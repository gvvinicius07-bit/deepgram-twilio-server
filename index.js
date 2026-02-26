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
  'es': 'Spanish',
  'zh': 'Mandarin',
  'ar': 'Arabic',
  'en': 'English'
};

app.get('/', (req, res) => res.send('Deepgram Twilio Server Running'));

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
      if (match) greetingText = match[1]
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

function createDGLive(client, language) {
  const dgLang = dgLanguageMap[language] || 'en';
  return client.listen.live({
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

function estimateTTSDuration(text) {
  if (!text) return 4000;
  const words = text.trim().split(/\s+/).length;
  return Math.max(4000, words * 200 + 1000);
}

wss.on('connection', (twilioWs, req) => {
  const urlParts = req.url.split('/stream/')[1]?.split('/');
  const sessionId = urlParts?.[0] || 'unknown';
  const preselectedLanguage = urlParts?.[1] || null;
  console.log(`New call session: ${sessionId}${preselectedLanguage ? ' | Preselected: ' + preselectedLanguage : ''}`);

  const deepgramClient = createClient(DEEPGRAM_API_KEY);
  let deepgramLive = null;
  let audioBuffer = [];
  let transcript = '';
  let silenceTimer;
  let speakingTimer;
  let isSpeaking = false;
  let callSid;
  let streamSid;
  let lockedLanguage = preselectedLanguage || null;
  let languageConfirmed = preselectedLanguage ? true : false;
  let englishUtteranceCount = 0;
  let deepgramReady = false;
  let switching = false;
  let failedDetectionCount = 0;

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
      const text = data.channel?.alternatives?.[0]?.transcript;
      if (!text || switching) return;

      if (isSpeaking) {
        console.log(`Ignored transcript during TTS playback: "${text}"`);
        return;
      }

      if (!languageConfirmed) {
        // Use Deepgram's own detected_language field — reliable, not regex on mangled text
        const dgDetected = data.channel?.detected_language;
        const detected = dgDetected ? deepgramLangMap[dgDetected] : null;
        console.log(`Detection phase — Deepgram says: ${dgDetected || 'unknown'} | text: "${text}"`);

        if (detected && detected !== 'English') {
          console.log(`Non-English detected: ${detected}, switching Deepgram`);
          lockedLanguage = detected;
          languageConfirmed = true;
          switching = true;
          deepgramReady = false;
          try { dgLive.finish(); } catch(e) {}
          deepgramLive = createDGLive(deepgramClient, detected);
          attachDGHandlers(deepgramLive, detected);
          await sendToN8n('LANGUAGE_SWITCHED', callSid, streamSid, detected);
        } else if (data.is_final && text.length > 3) {
          englishUtteranceCount++;
          failedDetectionCount++;
          if (englishUtteranceCount >= 3) {
            lockedLanguage = 'English';
            languageConfirmed = true;
            console.log('Language confirmed: English');
          }
          if (failedDetectionCount >= 2 && !languageConfirmed) {
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
          const full = transcript.trim();
          transcript = '';
          if (!full || full.length < 3) return;
          await processTranscript(full);
        }, 3000);
      }
    });

    dgLive.on(LiveTranscriptionEvents.Error, (err) => {
      console.error('Deepgram error:', err);
    });
  }

  async function processTranscript(text) {
    console.log(`Transcript: ${text} | Language: ${lockedLanguage}`);
    await sendToN8n(text, callSid, streamSid, lockedLanguage || 'English');
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

      const sayMatch = twimlResponse.match(/<Say[^>]*>(.*?)<\/Say>/s);
      const sayText = sayMatch ? sayMatch[1].replace(/<[^>]+>/g, '') : twimlResponse;
      setSpeakingLock(sayText);

      if (cSid) await updateTwilioCall(cSid, twimlResponse);
    } catch (err) {
      console.error('Error sending to n8n:', err);
    }
  }

  // Start Deepgram with preselected language if set, otherwise multi for detection
  const startLanguage = preselectedLanguage || 'multi';
  deepgramLive = createDGLive(deepgramClient, startLanguage);
  attachDGHandlers(deepgramLive, startLanguage);

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
          if (deepgramReady && deepgramLive?.getReadyState() === 1 && !switching) {
            try { deepgramLive.send(audio); } catch(e) {}
          } else {
            if (audioBuffer.length < 500) audioBuffer.push(audio);
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
    clearTimeout(silenceTimer);
    clearTimeout(speakingTimer);
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
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
