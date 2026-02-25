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

app.get('/', (req, res) => {
  res.send('Deepgram Twilio Server Running');
});

app.post('/incoming-call', async (req, res) => {
  const callSid = req.body.CallSid || 'unknown';
  const wsUrl = `wss://${SERVER_URL}/stream/${callSid}`;
  console.log(`Incoming call. CallSid: ${callSid} | WS: ${wsUrl}`);

  let greetingText = "Hi! I'm Victor's Paint Shop AI assistant, how can I help you today?";
  try {
    const response = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        SpeechResult: 'CALL_STARTED',
        CallSid: callSid,
        StreamSid: '',
        DetectedLanguage: 'en'
      })
    });
    if (response.ok) {
      const twiml = await response.text();
      const match = twiml.match(/<Say[^>]*>(.*?)<\/Say>/s);
      if (match) greetingText = match[1]
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
    }
  } catch (err) {
    console.error('Error getting greeting:', err);
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Ruth-Neural">${greetingText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</Say>
  <Start>
    <Stream url="${wsUrl}" />
  </Start>
  <Pause length="600"/>
</Response>`;

  res.type('text/xml').send(twiml);
});

// Map Deepgram language codes to friendly names
function mapLanguage(code) {
  if (!code) return null;
  const c = code.toLowerCase();
  if (c.startsWith('pt')) return 'Portuguese';
  if (c.startsWith('es')) return 'Spanish';
  if (c.startsWith('zh') || c === 'cmn') return 'Mandarin';
  if (c.startsWith('ar')) return 'Arabic';
  if (c.startsWith('en')) return 'English';
  return null;
}

// Detect language from transcript text as fallback
function detectLanguageFromText(text) {
  if (!text) return 'English';
  // Arabic script
  if (/[\u0600-\u06FF]/.test(text)) return 'Arabic';
  // Chinese/Mandarin script
  if (/[\u4E00-\u9FFF]/.test(text)) return 'Mandarin';
  // Portuguese-specific words and patterns
  const ptWords = /\b(oi|olá|sim|não|nao|você|voce|quero|casa|pintar|parede|preciso|gostaria|minha|meu|nossa|como|posso|falar|ajuda|tinta|obra|boa|bom|obrigado|obrigada|dia|por|favor|hoje|aqui|isso|esse|este|uma|uns|mas|com|para|que|ele|ela|seu|sua|nos|mim|me|te|lhe|já|já|até|então|porque|quando|onde|qual|quanto)\b/i;
  if (ptWords.test(text)) return 'Portuguese';
  // Spanish-specific words
  const esWords = /\b(hola|sí|si|no|quiero|casa|pintar|pared|necesito|como|puedo|hablar|ayuda|pintura|gracias|buenos|días|dia|por|favor|hoy|aquí|aqui|eso|este|una|unos|pero|con|para|que|él|ella|su|sus|nos|mí|me|te|le|ya|hasta|entonces|porque|cuando|dónde|donde|cuál|cuanto)\b/i;
  if (esWords.test(text)) return 'Spanish';
  return 'English';
}

wss.on('connection', (twilioWs, req) => {
  const sessionId = req.url.split('/stream/')[1];
  console.log(`New call session: ${sessionId}`);

  let deepgramLive;
  let transcript = '';
  let silenceTimer;
  let callSid;
  let streamSid;
  let lockedLanguage = null;

  try {
    const deepgramClient = createClient(DEEPGRAM_API_KEY);
    deepgramLive = deepgramClient.listen.live({
      model: 'nova-2-general',
      language: 'multi',
      punctuate: true,
      interim_results: true,
      endpointing: 800,
      encoding: 'mulaw',
      sample_rate: 8000,
      channels: 1,

    });
  } catch (err) {
    console.error('Failed to create Deepgram client:', err);
    twilioWs.close();
    return;
  }

  deepgramLive.on(LiveTranscriptionEvents.Open, () => {
    console.log('Deepgram connected');
  });

  deepgramLive.on(LiveTranscriptionEvents.Transcript, async (data) => {
    const text = data.channel?.alternatives?.[0]?.transcript;
    if (!text) return;

    // Get detected language from Deepgram, fallback to text detection
    const detectedCode = data.channel?.detected_language || data.detected_language || null;
    const deepgramLanguage = mapLanguage(detectedCode);
    const textLanguage = detectLanguageFromText(text);
    const detectedLanguage = (deepgramLanguage && deepgramLanguage !== 'English') ? deepgramLanguage :
                             (textLanguage !== 'English') ? textLanguage : 'English';

    // Lock language, never revert to English once a language is detected
    if (!lockedLanguage || lockedLanguage === 'English') {
      if (detectedLanguage !== 'English') {
        lockedLanguage = detectedLanguage;
        console.log(`Language switched to: ${lockedLanguage}`);
      } else if (!lockedLanguage) {
        lockedLanguage = 'English';
        console.log(`Language locked to: English`);
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

        try {
          const response = await fetch(N8N_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              SpeechResult: fullTranscript,
              CallSid: callSid || sessionId,
              StreamSid: streamSid || '',
              DetectedLanguage: lockedLanguage
            })
          });

          if (!response.ok) {
            console.error(`n8n returned ${response.status}: ${await response.text()}`);
            return;
          }

          const twimlResponse = await response.text();
          console.log('n8n response received, updating call');

          if (callSid) {
            await updateTwilioCall(callSid, twimlResponse);
          }
        } catch (err) {
          console.error('Error sending to n8n:', err);
        }
      }, 1000);
    }
  });

  deepgramLive.on(LiveTranscriptionEvents.Error, (err) => {
    console.error('Deepgram error:', err);
  });

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
          if (deepgramLive.getReadyState() === 1) {
            const audio = Buffer.from(data.media.payload, 'base64');
            deepgramLive.send(audio);
          }
          break;

        case 'stop':
          console.log('Stream stopped');
          deepgramLive.finish();
          break;
      }
    } catch (err) {
      console.error('Error parsing Twilio message:', err);
    }
  });

  twilioWs.on('close', () => {
    console.log('Twilio disconnected');
    try { deepgramLive.finish(); } catch (e) {}
  });

  twilioWs.on('error', (err) => {
    console.error('Twilio WebSocket error:', err);
  });
});

async function updateTwilioCall(callSid, twiml) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    console.error('Missing Twilio credentials in environment');
    return;
  }

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
    if (!response.ok) {
      console.error(`Twilio update failed: ${response.status} ${await response.text()}`);
    }
  } catch (err) {
    console.error('Error updating Twilio call:', err);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
