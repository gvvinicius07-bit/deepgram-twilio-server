require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const fetch = require('node-fetch');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const SERVER_URL = (process.env.SERVER_URL || '').replace(/^https?:\/\//, '').replace(/\/$/, '');

if (!DEEPGRAM_API_KEY) throw new Error('Missing DEEPGRAM_API_KEY in environment');
if (!N8N_WEBHOOK_URL) throw new Error('Missing N8N_WEBHOOK_URL in environment');
if (!SERVER_URL) throw new Error('Missing SERVER_URL in environment');

const pollyVoiceMap = {
  'English': 'Polly.Ruth-Neural',
  'Portuguese': 'Polly.Vitoria-Neural',
  'Spanish': 'Polly.Lupe-Neural',
  'Mandarin': 'Polly.Zhiyu-Neural',
  'Arabic': 'Polly.Zeina'
};

const dgLanguageMap = {
  'English': 'en',
  'Portuguese': 'pt',
  'Spanish': 'es',
  'Mandarin': 'zh',
  'Arabic': 'ar'
};

app.get('/', (req, res) => {
  res.send('Deepgram Twilio Server Running');
});

app.post('/incoming-call', async (req, res) => {
  const callSid = req.body.CallSid || 'unknown';
  const wsUrl = `wss://${SERVER_URL}/stream/${callSid}`;
  console.log(`Incoming call. CallSid: ${callSid}`);

  let greetingText = "Hi! I'm Victor's Paint Shop AI assistant, how can I help you today?";
  try {
    const response = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        SpeechResult: 'CALL_STARTED',
        CallSid: callSid,
        StreamSid: '',
        DetectedLanguage: 'English'
      })
    });
    if (response.ok) {
      const twiml = await response.text();
      const match = twiml.match(/<Say[^>]*>(.*?)<\/Say>/s);
      if (match) greetingText = match[1]
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    }
  } catch (err) {
    console.error('Error getting greeting:', err);
  }

  const safeGreeting = greetingText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Ruth-Neural">${safeGreeting}</Say>
  <Start><Stream url="${wsUrl}" /></Start>
  <Pause length="600"/>
</Response>`;

  res.type('text/xml').send(twiml);
});

function detectLanguageFromText(text) {
  if (!text) return 'English';
  if (/[\u0600-\u06FF]/.test(text)) return 'Arabic';
  if (/[\u4E00-\u9FFF]/.test(text)) return 'Mandarin';
  const t = text.toLowerCase();
  if (/\bportugu[eê]s(e)?\b/.test(t)) return 'Portuguese';
  if (/\bespan[oó]l\b|\bspanish\b/.test(t)) return 'Spanish';
  if (/\bmandarin\b|\bchinese\b/.test(t)) return 'Mandarin';
  if (/\barab[eic]+\b|\b[aá]rabe\b/.test(t)) return 'Arabic';
  const ptOnly = /\b(oi|voc[eê]|obrigado|obrigada|n[aã]o|gostaria|preciso|parede|tinta|banheiro|cozinha|brasil|brazil|ent[aã]o|tambem|tamb[eé]m|tudo|muito|ruim|devagar|errado|depois|aqui|isso|esse|minha|meu|nossa|nosso|falo|fala|gosto|tenho|vou|vai|pode|fazer|quero|queria|seria|posso|falar|ajuda|obra|hoje|onde|qual|quanto|sim)\b/;
  if (ptOnly.test(t)) return 'Portuguese';
  const esOnly = /\b(hola|gracias|buenos|d[ií]as|hoy|aqu[ií]|hasta|entonces|d[oó]nde|espa[nñ]ol|mexico|colombia|argentina|tambi[eé]n|ahora|despu[eé]s|siempre|nunca|mucho|peque[nñ]o|despacio|cocina|ba[nñ]o|quieres|tiene|tengo|necesito|puedo|hablar|ayuda|pintura|quiero|pared)\b/;
  if (esOnly.test(t)) return 'Spanish';
  const arRomanized = /\b(marhaba|ahlan|naam|aywa|shukran|areed|salam|habibi|yalla|tayeb|mumkin|kwayes)\b/i;
  if (arRomanized.test(t)) return 'Arabic';
  const zhPinyin = /\b(nihao|ni hao|xiexie|xie xie|zhongguo|putonghua|meiyou|duoshao|zenme|weishenme)\b/i;
  if (zhPinyin.test(t)) return 'Mandarin';
  return 'English';
}

function createDeepgramConnection(deepgramClient, language) {
  const dgLang = dgLanguageMap[language] || 'en';
  return deepgramClient.listen.live({
    model: 'nova-2-general',
    language: dgLang,
    punctuate: true,
    interim_results: true,
    endpointing: 800,
    encoding: 'mulaw',
    sample_rate: 8000,
    channels: 1
  });
}

wss.on('connection', (twilioWs, req) => {
  const sessionId = req.url.split('/stream/')[1];
  console.log(`New call session: ${sessionId}`);

  const deepgramClient = createClient(DEEPGRAM_API_KEY);
  let deepgramLive = null;
  let audioBuffer = [];
  let transcript = '';
  let silenceTimer;
  let callSid;
  let streamSid;
  let lockedLanguage = null;
  let deepgramReady = false;

  function startDeepgram(language) {
    if (deepgramLive) {
      try { deepgramLive.finish(); } catch(e) {}
    }
    deepgramLive = createDeepgramConnection(deepgramClient, language);
    deepgramReady = false;

    deepgramLive.on(LiveTranscriptionEvents.Open, () => {
      console.log(`Deepgram connected | Language: ${language}`);
      deepgramReady = true;
      // Flush buffered audio
      if (audioBuffer.length > 0) {
        audioBuffer.forEach(chunk => deepgramLive.send(chunk));
        audioBuffer = [];
      }
    });

    deepgramLive.on(LiveTranscriptionEvents.Transcript, async (data) => {
      const text = data.channel?.alternatives?.[0]?.transcript;
      if (!text) return;

      // Detect language from first utterance if not locked yet
      if (!lockedLanguage || lockedLanguage === 'English') {
        const detected = detectLanguageFromText(text);
        if (detected !== 'English' && detected !== lockedLanguage) {
          console.log(`Language detected: ${detected}, restarting Deepgram`);
          lockedLanguage = detected;
          // Restart Deepgram with correct language
          startDeepgram(lockedLanguage);
          // Send language switch notification to n8n
          sendToN8n('', callSid, streamSid, lockedLanguage);
          return;
        } else if (!lockedLanguage) {
          lockedLanguage = 'English';
        }
      }

      if (data.is_final) {
        transcript += ' ' + text;
        clearTimeout(silenceTimer);

        silenceTimer = setTimeout(async () => {
          const fullTranscript = transcript.trim();
          transcript = '';
          if (!fullTranscript || fullTranscript.length < 5) return;
          console.log(`Transcript: ${fullTranscript} | Language: ${lockedLanguage}`);
          await sendToN8n(fullTranscript, callSid, streamSid, lockedLanguage);
        }, 1000);
      }
    });

    deepgramLive.on(LiveTranscriptionEvents.Error, (err) => {
      console.error('Deepgram error:', err);
    });
  }

  async function sendToN8n(speechResult, cSid, sSid, language) {
    try {
      const response = await fetch(N8N_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          SpeechResult: speechResult,
          CallSid: cSid || sessionId,
          StreamSid: sSid || '',
          DetectedLanguage: language || 'English'
        })
      });
      if (!response.ok) {
        console.error(`n8n returned ${response.status}: ${await response.text()}`);
        return;
      }
      const twimlResponse = await response.text();
      console.log('n8n response received, updating call');
      if (cSid) await updateTwilioCall(cSid, twimlResponse);
    } catch (err) {
      console.error('Error sending to n8n:', err);
    }
  }

  // Start with multi-language detection first
  startDeepgram('multi-detect');

  twilioWs.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      switch (data.event) {
        case 'start':
          callSid = data.start.callSid;
          streamSid = data.start.streamSid;
          console.log(`Stream started: ${callSid}`);
          break;
        case 'media':
          const audio = Buffer.from(data.media.payload, 'base64');
          if (deepgramReady && deepgramLive?.getReadyState() === 1) {
            deepgramLive.send(audio);
          } else {
            audioBuffer.push(audio);
          }
          break;
        case 'stop':
          console.log('Stream stopped');
          try { deepgramLive?.finish(); } catch(e) {}
          break;
      }
    } catch (err) {
      console.error('Error parsing Twilio message:', err);
    }
  });

  twilioWs.on('close', () => {
    console.log('Twilio disconnected');
    try { deepgramLive?.finish(); } catch(e) {}
  });

  twilioWs.on('error', (err) => {
    console.error('Twilio WebSocket error:', err);
  });
});



async function updateTwilioCall(callSid, twiml) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) return;
  try {
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${callSid}.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({ Twiml: twiml })
      }
    );
    if (!response.ok) console.error(`Twilio update failed: ${response.status} ${await response.text()}`);
  } catch (err) {
    console.error('Error updating Twilio call:', err);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
