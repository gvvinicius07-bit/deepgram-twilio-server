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
  'Arabic': 'ar',
  'multi': 'multi'
};

const deepgramLangMap = {
  'pt': 'Portuguese',
  'pt-BR': 'Portuguese',
  'pt-PT': 'Portuguese',
  'es': 'Spanish',
  'es-419': 'Spanish',
  'es-ES': 'Spanish',
  'es-US': 'Spanish',
  'zh': 'Mandarin',
  'zh-CN': 'Mandarin',
  'zh-TW': 'Mandarin',
  'ar': 'Arabic',
  'ar-001': 'Arabic',
  'en': 'English',
  'en-US': 'English',
  'en-GB': 'English'
};

// Global session registry — kills old session when new one opens for same CallSid
const activeSessions = new Map();

// Track which sessions are currently collecting phone via DTMF keypad
// (prevents voice transcripts from being processed during DTMF entry)
const dtmfSessions = new Set();

// Track sessions where phone collection is in progress (initial ask OR re-ask after "No")
// Stays true until address question is detected, meaning phone was confirmed.
const phoneCollectionActive = new Set();

// Track sessions where AI has asked for phone but customer hasn't responded yet.
// We listen to their voice first; only fall back to DTMF if digits weren't captured.
const phoneCollectionPending = new Set();

// Track confirmed language per callSid (needed by /phone-dtmf-received)
const sessionLanguages = new Map();

// Detect when the AI is asking for a phone number (all 5 languages)
const PHONE_REQUEST_PATTERNS = [
  /phone number/i,
  /número de telefone/i,
  /número de celular/i,
  /número de teléfono/i,
  /teléfono/i,
  /\btelefone\b/i,      // Portuguese: "Qual é o seu telefone?"
  /\bcelular\b/i,       // Portuguese/Spanish alternative
  /电话/,               // Mandarin: 电话号码, 电话
  /手机/,               // Mandarin: 手机号码 (mobile number)
  /رقم الهاتف/,
  /رقم هاتف/,
  /الهاتف/,             // Arabic: shorter form
  /هاتفك/               // Arabic: "your phone"
];

// Detect that phone was confirmed and AI moved on (address question)
const PHONE_CONFIRMED_PATTERNS = [
  /address/i,
  /endere[çc]o/i,
  /dirección/i,
  /地址/,
  /العنوان/
];

function isPhoneNumberRequest(text) {
  if (!text) return false;
  return PHONE_REQUEST_PATTERNS.some(p => p.test(text));
}

function isPhoneConfirmed(text) {
  if (!text) return false;
  return PHONE_CONFIRMED_PATTERNS.some(p => p.test(text));
}

app.get('/', (req, res) => res.send('Deepgram Twilio Server Running'));

app.post('/incoming-call', async (req, res) => {
  const callSid = req.body.CallSid || 'unknown';
  const wsUrl = `wss://${SERVER_URL}/stream/${callSid}`;
  console.log(`Incoming call. CallSid: ${callSid}`);

  // Always use hardcoded greeting — n8n CALL_STARTED returned garbled output (AI wraps
  // the silence token in quotes, causing Polly to literally speak "quote space quote").
  const greetingText = "Hi! I'm Victor's Paint Shop AI assistant, how can I help you today?";
  const safeGreeting = greetingText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Ruth-Neural">${safeGreeting}</Say>
  <Start><Stream url="${wsUrl}" /></Start>
  <Pause length="600"/>
</Response>`;
  res.type('text/xml').send(twiml);
});

app.post('/language-menu', (req, res) => {
  const callSid = req.body.CallSid || 'unknown';
  console.log(`Language menu triggered for: ${callSid}`);
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" action="https://${SERVER_URL}/language-pick" method="POST" timeout="10">
    <Say voice="Polly.Ruth-Neural">It seems like you may be having trouble. Press 1 for English. Press 2 for Portuguese. Press 3 for Spanish. Press 4 for Mandarin. Press 5 for Arabic.</Say>
  </Gather>
  <Redirect method="POST">https://${SERVER_URL}/language-menu</Redirect>
</Response>`;
  res.type('text/xml').send(twiml);
});

app.post('/language-pick', async (req, res) => {
  const digit = req.body.Digits;
  const callSid = req.body.CallSid || 'unknown';
  const languageMap = { '1': 'English', '2': 'Portuguese', '3': 'Spanish', '4': 'Mandarin', '5': 'Arabic' };
  const language = languageMap[digit] || 'English';
  const voice = pollyVoiceMap[language];
  console.log(`Language picked: ${language} for ${callSid}`);

  let greetingText = "Hi! I'm Victor's Paint Shop AI assistant, how can I help you today?";
  try {
    const response = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        SpeechResult: 'LANGUAGE_SWITCHED',
        CallSid: callSid,
        StreamSid: '',
        DetectedLanguage: language
      })
    });
    if (response.ok) {
      const twiml = await response.text();
      const match = twiml.match(/<Say[^>]*>(.*?)<\/Say>/s);
      if (match && match[1].trim()) greetingText = match[1]
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    }
  } catch (err) {
    console.error('Error getting language greeting:', err);
  }

  const safeGreeting = greetingText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const wsUrl = `wss://${SERVER_URL}/stream/${callSid}/${language}`;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voice}">${safeGreeting}</Say>
  <Start><Stream url="${wsUrl}" /></Start>
  <Pause length="600"/>
</Response>`;
  res.type('text/xml').send(twiml);
});

// Called by Twilio after caller enters phone number on keypad
app.post('/phone-dtmf-received', async (req, res) => {
  const digits = req.body.Digits || '';
  const callSid = req.body.CallSid || req.query.callSid || '';
  const language = sessionLanguages.get(callSid) || 'English';

  console.log(`DTMF phone received: "${digits}" for ${callSid} (${language})`);

  // Remove from active DTMF entry — WebSocket transcripts can resume
  // (phoneCollectionActive stays set until address question confirms phone was accepted)
  dtmfSessions.delete(callSid);

  // Send digits to n8n as if the caller spoke them
  try {
    const n8nResponse = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        SpeechResult: digits,
        CallSid: callSid,
        StreamSid: '',
        DetectedLanguage: language
      })
    });
    if (!n8nResponse.ok) {
      console.error(`n8n returned ${n8nResponse.status} for DTMF`);
      res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, there was a problem. Please hold.</Say></Response>');
      return;
    }
    const twimlResponse = await n8nResponse.text();
    console.log('n8n DTMF response received, updating call');

    // Update the live call with n8n's TwiML (AI reads back the number for confirmation)
    await updateTwilioCall(callSid, twimlResponse);

    // Return a brief pause — gives updateTwilioCall time to register before Twilio
    // would otherwise hang up on the empty action response.
    res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="5"/></Response>');
  } catch (err) {
    console.error('Error processing DTMF phone:', err);
    res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, there was a problem. Please try again.</Say></Response>');
  }
});

function normalizeAccents(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Very distinctive single-word Portuguese markers (won't be mistaken for other languages)
const PT_SINGLE_WORD = /^(oi|ola|tchau|obrigado|obrigada|sim|nao)$/;

function detectLanguageFromText(text) {
  if (!text) return null;
  if (/[\u0600-\u06FF]/.test(text)) return 'Arabic';
  if (/[\u4E00-\u9FFF]/.test(text)) return 'Mandarin';
  const t = text.toLowerCase();
  const tn = normalizeAccents(t); // accent-stripped version for matching
  if (/\bportugu[eê]s(e)?\b/.test(tn)) return 'Portuguese';
  if (/\bespan[oó]l\b|\bspanish\b/.test(tn)) return 'Spanish';
  if (/\bmandarin\b|\bchinese\b/.test(tn)) return 'Mandarin';
  if (/\barab[eic]+\b|\b[aá]rabe\b/.test(tn)) return 'Arabic';

  // Single-word check for unmistakable Portuguese greetings
  const singleWord = tn.trim();
  if (PT_SINGLE_WORD.test(singleWord)) return 'Portuguese';

  // Multi-word Portuguese detection (accent-normalized)
  const ptOnly = /\b(oi|ola|voce|obrigado|obrigada|nao|gostaria|preciso|parede|tinta|banheiro|cozinha|brasil|brazil|entao|tambem|tudo|muito|devagar|depois|aqui|isso|esse|minha|meu|nossa|nosso|falo|fala|gosto|tenho|vou|vai|pode|fazer|quero|queria|seria|posso|falar|ajuda|obra|hoje|onde|qual|quanto|sim|marcar|pintura|pintar|sala|quarto|corredor|porta|janela|teto|piso|cor|branco|cinza|azul|verde|cores|orcamento|preco|valor|agenda|agendar|ligar|atender|servico|servicos|casa|apartamento|imovel|reforma|renovacao|interior|exterior|portugues|queria|precisa|preciso|posso|pode|vou|falo|falamos|falando|falar|estou|esta|estao|somos|sou|sera|seria|mesmo|mesmo|tambem|tambem|tudo|tudo|bom|boa|dia|tarde|noite|obrigado|obrigada|tchau|ate|logo|por|favor|desculpe|desculpa|nao|sim|claro|certo|ok|hum|ah)\b/;
  if (ptOnly.test(tn)) return 'Portuguese';

  const esOnly = /\b(hola|gracias|buenos|dias|hoy|aqui|hasta|entonces|donde|espanol|mexico|colombia|argentina|tambien|ahora|despues|siempre|nunca|mucho|pequeno|despacio|cocina|bano|quieres|tiene|tengo|necesito|puedo|hablar|ayuda|pintura|quiero|pared)\b/;
  if (esOnly.test(tn)) return 'Spanish';
  const arRomanized = /\b(marhaba|ahlan|naam|aywa|shukran|areed|salam|habibi|yalla|tayeb|mumkin|kwayes)\b/i;
  if (arRomanized.test(tn)) return 'Arabic';
  const zhPinyin = /\b(nihao|ni hao|xiexie|xie xie|zhongguo|putonghua|meiyou|duoshao|zenme|weishenme)\b/i;
  if (zhPinyin.test(tn)) return 'Mandarin';
  return null;
}

function createDGLive(client, language) {
  const dgLang = dgLanguageMap[language] || 'en';
  // NOTE: no detect_language param — language: 'multi' is itself the detection mode
  return client.listen.live({
    model: 'nova-2-general',
    language: dgLang,
    punctuate: true,
    interim_results: true,
    endpointing: 2000,
    encoding: 'mulaw',
    sample_rate: 8000,
    channels: 1
  });
}

function estimateTTSDuration(text) {
  if (!text) return 2000;
  const words = text.trim().split(/\s+/).length;
  return Math.max(2000, words * 450 + 1500);
}

wss.on('connection', (twilioWs, req) => {
  const urlParts = req.url.split('/stream/')[1]?.split('/');
  const sessionId = urlParts?.[0] || 'unknown';
  const preselectedLanguage = urlParts?.[1] || null;
  console.log(`New call session: ${sessionId}${preselectedLanguage ? ' | Preselected: ' + preselectedLanguage : ''}`);

  // Keepalive: prevent Railway proxy from dropping idle WebSocket connections
  const keepaliveInterval = setInterval(() => {
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.ping();
  }, 30000);

  // Kill any existing session for this CallSid
  if (activeSessions.has(sessionId)) {
    console.log(`Killing old session for ${sessionId}`);
    try { activeSessions.get(sessionId)(); } catch(e) {}
  }

  const deepgramClient = createClient(DEEPGRAM_API_KEY);
  let deepgramLive = null;
  let audioBuffer = [];
  let transcript = '';
  let silenceTimer;
  let speakingTimer;
  let isSpeaking = preselectedLanguage ? true : false;
  let callSid = sessionId;
  let streamSid;
  let lockedLanguage = preselectedLanguage || null;
  let languageConfirmed = preselectedLanguage ? true : false;
  let englishUtteranceCount = 0;
  let deepgramReady = false;
  let switching = false;
  let failedDetectionCount = 0;
  let destroyed = false;

  // Block TTS bleedthrough for greeting when language was preselected via keypad
  if (preselectedLanguage) {
    console.log(`Initial TTS lock 5000ms for preselected language greeting`);
    speakingTimer = setTimeout(() => {
      isSpeaking = false;
      console.log('Initial TTS lock cleared — listening for caller');
    }, 5000);
  }

  activeSessions.set(sessionId, () => {
    destroyed = true;
    clearTimeout(silenceTimer);
    clearTimeout(speakingTimer);
    try { deepgramLive?.finish(); } catch(e) {}
    activeSessions.delete(sessionId);
  });

  function setSpeakingLock(responseText) {
    isSpeaking = true;
    clearTimeout(speakingTimer);
    const duration = estimateTTSDuration(responseText);
    console.log(`TTS lock set for ${duration}ms`);
    speakingTimer = setTimeout(() => {
      isSpeaking = false;
      console.log('TTS lock cleared — listening for caller');
    }, duration);
  }

  function attachDGHandlers(dgLive, language) {
    dgLive.on(LiveTranscriptionEvents.Open, () => {
      console.log(`Deepgram ready | language: ${language}`);
      deepgramReady = true;
      switching = false;
      audioBuffer.forEach(chunk => {
        try { dgLive.send(chunk); } catch(e) {}
      });
      audioBuffer = [];
    });

    dgLive.on(LiveTranscriptionEvents.Transcript, async (data) => {
      if (destroyed) return;
      const text = data.channel?.alternatives?.[0]?.transcript;
      if (!text || switching) return;

      // Don't process voice while caller is entering digits on keypad
      if (dtmfSessions.has(callSid)) {
        console.log(`Ignored transcript — DTMF phone entry in progress: "${text}"`);
        return;
      }

      if (isSpeaking) {
        console.log(`Ignored transcript during TTS playback: "${text}"`);
        return;
      }

      if (!languageConfirmed) {
        // Try Deepgram's detected_language first, fall back to text regex
        const dgDetected = data.channel?.detected_language;
        const dgConfidence = data.channel?.language_confidence ?? 1;
        let detected = (dgDetected && dgConfidence >= 0.85) ? deepgramLangMap[dgDetected] : null;

        const wordCount = text.trim().split(/\s+/).length;

        // Text detection only on 2+ word utterances to avoid single-word false positives
        // (e.g. "oi" transcribed as "Hoy" which is Spanish)
        if (wordCount >= 2) {
          const textDetected = detectLanguageFromText(text);
          if (textDetected && textDetected !== 'English') {
            detected = textDetected;
            console.log(`Text detected: ${detected} from "${text}"`);
          }
        }
        if (detected && detected !== 'English') {
          console.log(`Deepgram detected: ${detected} (${dgDetected})`);
        }

        // Switch to non-English if Deepgram detected it, OR text matched on 2+ words
        if (detected && detected !== 'English') {
          console.log(`Non-English confirmed: ${detected}, switching Deepgram`);
          lockedLanguage = detected;
          languageConfirmed = true;
          sessionLanguages.set(callSid, detected);
          switching = true;
          deepgramReady = false;
          try { dgLive.finish(); } catch(e) {}
          deepgramLive = createDGLive(deepgramClient, detected);
          attachDGHandlers(deepgramLive, detected);
          await sendToN8n('LANGUAGE_SWITCHED', callSid, streamSid, detected);
        } else if (detected === 'English' && data.is_final && text.trim().split(/\s+/).length >= 3) {
          // Deepgram explicitly detected English with enough words
          englishUtteranceCount++;
          if (englishUtteranceCount >= 1) {
            lockedLanguage = 'English';
            languageConfirmed = true;
            sessionLanguages.set(callSid, 'English');
            console.log('Language confirmed: English (explicit Deepgram detection)');
          }
          await processTranscript(text);
        } else if (data.is_final && text.trim().split(/\s+/).length >= 3) {
          // Ambiguous with enough words - increment counters
          englishUtteranceCount++;
          failedDetectionCount++;
          if (englishUtteranceCount >= 2) {
            lockedLanguage = 'English';
            languageConfirmed = true;
            sessionLanguages.set(callSid, 'English');
            console.log('Language confirmed: English (fallback)');
          }
          if (failedDetectionCount >= 6 && !languageConfirmed) {
            console.log('Detection failed, triggering language menu');
            if (callSid) {
              const menuTwiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Redirect method="POST">https://${SERVER_URL}/language-menu</Redirect></Response>`;
              await updateTwilioCall(callSid, menuTwiml);
            }
            return;
          }
          await processTranscript(text);
        }
        return;
      }

      if (data.is_final) {
        transcript += ' ' + text;
        clearTimeout(silenceTimer);
        silenceTimer = setTimeout(async () => {
          if (destroyed) return;
          const full = transcript.trim();
          transcript = '';
          if (!full || full.length < 3) return;
          await processTranscript(full);
        }, 3000); // 3s gives callers time to continue digit strings without splitting
      }
    });

    dgLive.on(LiveTranscriptionEvents.Error, (err) => {
      console.error('Deepgram error:', err);
    });
  }

  const phoneApologyMessages = {
    'English':    "I'm sorry, I didn't understand that perfectly. Could you type it on the keypad just to be 100% sure?",
    'Portuguese': "Desculpe, não entendi direito. Pode digitar no teclado para ter certeza?",
    'Spanish':    "Lo siento, no entendí bien. ¿Podría escribir su número en el teclado?",
    'Mandarin':   "对不起，我没听清楚。您能在键盘上输入您的电话号码吗？",
    'Arabic':     "آسف، لم أفهم ذلك جيداً. هل يمكنك كتابة رقمك على لوحة المفاتيح؟"
  };

  async function processTranscript(text) {
    if (destroyed) return;
    console.log(`Transcript: "${text}" | Language: ${lockedLanguage}`);

    // If we're waiting for the customer to speak their phone number, check digits first
    if (phoneCollectionPending.has(callSid)) {
      const digits = text.replace(/\D/g, '');
      if (digits.length >= 7) {
        // Got enough digits — send to n8n normally; AI will read back for confirmation
        console.log(`Phone spoken OK (${digits.length} digits) — sending to n8n normally`);
        phoneCollectionPending.delete(callSid);
        phoneCollectionActive.add(callSid);
      } else {
        // Couldn't capture digits — apologise and switch to keypad
        console.log(`Phone not captured (only ${digits.length} digits) — switching to DTMF`);
        phoneCollectionPending.delete(callSid);
        phoneCollectionActive.add(callSid);
        dtmfSessions.add(callSid);
        const lang = lockedLanguage || 'English';
        const voice = pollyVoiceMap[lang] || 'Polly.Ruth-Neural';
        const apology = phoneApologyMessages[lang] || phoneApologyMessages['English'];
        const safeApology = apology.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&apos;');
        const dtmfTwiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voice}">${safeApology}</Say>
  <Gather input="dtmf" numDigits="10" action="https://${SERVER_URL}/phone-dtmf-received" method="POST" timeout="30"></Gather>
  <Say voice="${voice}">I didn&apos;t receive your number. Please call back and try again.</Say>
</Response>`;
        setSpeakingLock(apology);
        await updateTwilioCall(callSid, dtmfTwiml);
        return;
      }
    }

    await sendToN8n(text, callSid, streamSid, lockedLanguage || 'English');
  }

  async function sendToN8n(speechResult, cSid, sSid, language) {
    if (destroyed) return;
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

      const sayMatch = twimlResponse.match(/<Say[^>]*>(.*?)<\/Say>/s);
      const sayText = sayMatch ? sayMatch[1].replace(/<[^>]+>/g, '') : twimlResponse;

      // Once phone is confirmed (AI asks for address), clear phone collection state
      if ((phoneCollectionActive.has(cSid) || phoneCollectionPending.has(cSid)) && isPhoneConfirmed(sayText)) {
        console.log(`Phone confirmed — clearing phone collection state for ${cSid}`);
        phoneCollectionActive.delete(cSid);
        phoneCollectionPending.delete(cSid);
      }

      // If AI is asking for phone number → mark pending and let customer speak first.
      // Only fall back to DTMF keypad if their spoken digits can't be captured (handled in processTranscript).
      if (isPhoneNumberRequest(sayText) && !phoneCollectionActive.has(cSid) && !phoneCollectionPending.has(cSid)) {
        console.log(`Phone number request detected — listening for spoken digits first (${cSid})`);
        phoneCollectionPending.add(cSid);
      }

      setSpeakingLock(sayText);
      if (cSid) await updateTwilioCall(cSid, twimlResponse);
    } catch (err) {
      console.error('Error sending to n8n:', err);
    }
  }

  const startLanguage = preselectedLanguage || 'multi';
  deepgramLive = createDGLive(deepgramClient, startLanguage);
  attachDGHandlers(deepgramLive, startLanguage);

  twilioWs.on('message', (message) => {
    if (destroyed) return;
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
          if (deepgramReady && deepgramLive?.getReadyState() === 1 && !switching) {
            try { deepgramLive.send(audio); } catch(e) {}
          } else {
            if (audioBuffer.length < 500) audioBuffer.push(audio);
          }
          break;
        case 'stop':
          console.log('Stream stopped');
          clearInterval(keepaliveInterval);
          try { deepgramLive?.finish(); } catch(e) {}
          activeSessions.delete(sessionId);
          sessionLanguages.delete(sessionId);
          dtmfSessions.delete(sessionId);
          phoneCollectionActive.delete(sessionId);
          phoneCollectionPending.delete(sessionId);
          break;
      }
    } catch (err) {
      console.error('Error parsing Twilio message:', err);
    }
  });

  twilioWs.on('close', () => {
    clearInterval(keepaliveInterval);
    if (!destroyed) {
      console.log('Twilio disconnected');
      clearTimeout(silenceTimer);
      clearTimeout(speakingTimer);
      try { deepgramLive?.finish(); } catch(e) {}
      activeSessions.delete(sessionId);
      sessionLanguages.delete(sessionId);
      dtmfSessions.delete(sessionId);
      phoneCollectionActive.delete(sessionId);
      phoneCollectionPending.delete(sessionId);
    }
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
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
