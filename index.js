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

const languageMap = {
  '1': 'English',
  '2': 'Portuguese',
  '3': 'Spanish',
  '4': 'Mandarin',
  '5': 'Arabic'
};

const deepgramLanguageMap = {
  'English': 'en',
  'Portuguese': 'pt',
  'Spanish': 'es',
  'Mandarin': 'zh',
  'Arabic': 'ar'
};

const pollyVoiceMap = {
  'English': 'Polly.Ruth-Neural',
  'Portuguese': 'Polly.Vitoria-Neural',
  'Spanish': 'Polly.Lupe-Neural',
  'Mandarin': 'Polly.Zhiyu-Neural',
  'Arabic': 'Polly.Zeina'
};

app.get('/', (req, res) => {
  res.send('Deepgram Twilio Server Running');
});

// Step 1: Play language menu
app.post('/incoming-call', (req, res) => {
  const callSid = req.body.CallSid || 'unknown';
  console.log(`Incoming call. CallSid: ${callSid}`);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" action="https://${SERVER_URL}/language-select" method="POST" timeout="10">
    <Say voice="Polly.Ruth-Neural">Welcome to Victor's Paint Shop. Press 1 for English. Press 2 for Portuguese. Press 3 for Spanish. Press 4 for Mandarin. Press 5 for Arabic.</Say>
  </Gather>
  <Say voice="Polly.Ruth-Neural">We did not receive your selection. Please call back and press a number to continue.</Say>
</Response>`;

  res.type('text/xml').send(twiml);
});

// Step 2: Handle keypress, send greeting, open stream
app.post('/language-select', async (req, res) => {
  const digit = req.body.Digits;
  const callSid = req.body.CallSid || 'unknown';
  const language = languageMap[digit] || 'English';
  const voice = pollyVoiceMap[language];
  const wsUrl = `wss://${SERVER_URL}/stream/${callSid}/${language}`;

  console.log(`Language selected: ${language} (digit: ${digit}) | CallSid: ${callSid}`);

  // Get greeting from n8n
  let greetingText = "Hi! I'm Victor's Paint Shop AI assistant, how can I help you today?";
  try {
    const response = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        SpeechResult: 'CALL_STARTED',
        CallSid: callSid,
        StreamSid: '',
        DetectedLanguage: language
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
    console.error('Error getting greeting from n8n:', err);
  }

  const safeGreeting = greetingText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voice}">${safeGreeting}</Say>
  <Start>
    <Stream url="${wsUrl}" />
  </Start>
  <Pause length="600"/>
</Response>`;

  res.type('text/xml').send(twiml);
});

wss.on('connection', (twilioWs, req) => {
  const parts = req.url.split('/stream/')[1]?.split('/');
  const sessionId = parts?.[0] || 'unknown';
  const language = parts?.[1] || 'English';

  console.log(`New call session: ${sessionId} | Language: ${language}`);

  let deepgramLive;
  let transcript = '';
  let silenceTimer;
  let callSid;
  let streamSid;
  const lockedLanguage = language;
  const dgLanguage = deepgramLanguageMap[language] || 'en';

  try {
    const deepgramClient = createClient(DEEPGRAM_API_KEY);
    deepgramLive = deepgramClient.listen.live({
      model: 'nova-2-general',
      language: dgLanguage,
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
    console.log(`Deepgram connected | Language: ${lockedLanguage}`);
  });

  deepgramLive.on(LiveTranscriptionEvents.Transcript, async (data) => {
    const text = data.channel?.alternatives?.[0]?.transcript;
    if (!text) return;

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
