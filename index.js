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
        DetectedLanguage: 'English'
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

  const safeGreeting = greetingText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Ruth-Neural">${safeGreeting}</Say>
  <Start>
    <Stream url="${wsUrl}" />
  </Start>
  <Pause length="600"/>
</Response>`;

  res.type('text/xml').send(twiml);
});

function mapLanguageCode(code) {
  if (!code) return null;
  const c = code.toLowerCase();
  if (c.startsWith('pt')) return 'Portuguese';
  if (c.startsWith('es')) return 'Spanish';
  if (c.startsWith('zh') || c === 'cmn') return 'Mandarin';
  if (c.startsWith('ar')) return 'Arabic';
  if (c.startsWith('en')) return 'English';
  return null;
}

function detectLanguageFromText(text) {
  if (!text) return 'English';

  // Arabic script
  if (/[\u0600-\u06FF]/.test(text)) return 'Arabic';
  // Chinese script
  if (/[\u4E00-\u9FFF]/.test(text)) return 'Mandarin';

  const t = text.toLowerCase();

  // Caller says language name
  if (/\bportugu[eê]s(e)?\b/.test(t)) return 'Portuguese';
  if (/\bespan[oó]l\b|\bspanish\b/.test(t)) return 'Spanish';
  if (/\bmandarin\b|\bchinese\b|\bchines\b/.test(t)) return 'Mandarin';
  if (/\barab[eic]+\b|\b[aá]rabe\b/.test(t)) return 'Arabic';

  // Portuguese words
  const ptWords = /\b(oi|ol[aá]|sim|n[aã]o|voc[eê]|quero|queria|pintar|parede|preciso|gostaria|minha|meu|nossa|nosso|posso|falar|ajuda|tinta|obra|obrigado|obrigada|favor|hoje|aqui|isso|esse|este|esta|uma|umas|uns|mas|com|para|ele|ela|seu|sua|nos|mim|ent[aã]o|porque|quando|onde|qual|quanto|falo|fala|gosto|tenho|vou|vai|pode|fazer|seria|brasil|brazil|pin|pint|quer|voc|tud|tudo|tamb[eé]m|tambem|agora|depois|antes|sempre|nunca|muito|pouco|grande|pequeno|novo|velho|bonito|barato|caro|r[aá]pido|devagar|certo|errado|bom|mau|ruim|feliz|triste|casa|quarto|sala|cozinha|banheiro|jardim|rua|cidade|estado|pa[ií]s)\b/;
  if (ptWords.test(t)) return 'Portuguese';

  // Spanish words
  const esWords = /\b(hola|s[ií]|quiero|quisiera|pintar|pared|necesito|puedo|hablar|ayuda|pintura|gracias|buenos|d[ií]as|favor|hoy|aqu[ií]|eso|este|esta|una|unos|pero|con|para|[eé]l|ella|su|sus|ya|hasta|entonces|porque|cuando|d[oó]nde|cu[aá]l|cuanto|espa[nñ]ol|mexico|colombia|argentina|todo|tambi[eé]n|ahora|despu[eé]s|antes|siempre|nunca|mucho|poco|grande|peque[nñ]o|nuevo|viejo|bonito|barato|caro|r[aá]pido|despacio|correcto|incorrecto|bueno|malo|feliz|triste|casa|cuarto|sala|cocina|ba[nñ]o|jard[ií]n|calle|ciudad|estado|pa[ií]s|quieres|tiene|tengo|voy|voy|puedes|hacer|hecho|ser[ií]a|soy|eres|somos|es|son)\b/;
  if (esWords.test(t)) return 'Spanish';

  // Arabic words romanized (Deepgram sometimes transcribes Arabic phonetically)
  const arWords = /\b(marhaba|ahlan|naam|la|aywa|shukran|areed|bayt|talaa|salam|inshallah|habibi|yalla|wallah|tayeb|mumkin|lazim|kwayes|zain|mish|ana|anta|howa|hiya|nahnu|fi|min|ila|ma|wein|lesh|kam|mata|kayf|meen)\b/i;
  if (arWords.test(t)) return 'Arabic';

  // Mandarin words romanized (pinyin)
  const zhWords = /\b(ni hao|nihao|xie xie|xiexie|wo|shi|yao|bu|hen|hao|ma|ne|ba|le|de|ge|zhe|na|mei|you|meiyou|duoshao|zenme|weishenme|shenme|shei|nali|jia|fang|qi|gong|zuo|lai|qu|chi|he|shui|men|ren|tian|ri|yue|nian|zhongguo|putonghua)\b/i;
  if (zhWords.test(t)) return 'Mandarin';

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
      channels: 1
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

    const detectedCode = data.channel?.detected_language || data.detected_language || null;
    const fromCode = mapLanguageCode(detectedCode);
    const fromText = detectLanguageFromText(text);
    const detectedLanguage = (fromCode && fromCode !== 'English') ? fromCode :
                             (fromText !== 'English') ? fromText : 'English';

    if (!lockedLanguage) {
      lockedLanguage = detectedLanguage;
      console.log(`Language locked to: ${lockedLanguage}`);
    } else if (lockedLanguage === 'English' && detectedLanguage !== 'English') {
      lockedLanguage = detectedLanguage;
      console.log(`Language switched to: ${lockedLanguage}`);
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
              DetectedLanguage: lockedLanguage || 'English'
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
