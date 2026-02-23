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

const DEEPGRAM_API_KEY = '01c0ea31e26abc54c6a1572ceb945e80ba18ed04';
const N8N_WEBHOOK_URL = 'https://primary-production-34d51.up.railway.app/webhook/incoming-call';

app.get('/', (req, res) => {
  res.send('Deepgram Twilio Server Running');
});

app.post('/incoming-call', (req, res) => {
  const sessionId = req.body.CallSid || 'unknown';
  const wsUrl = process.env.SERVER_URL 
    ? `wss://${process.env.SERVER_URL.replace('https://', '')}/stream/${sessionId}`
    : `wss://localhost:${process.env.PORT || 3000}/stream/${sessionId}`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Stream url="${wsUrl}" />
  </Start>
  <Say voice="Polly.Ruth-Neural">Hi! I am Victor's Paint Shop AI assistant, how can I help you today?</Say>
  <Pause length="60"/>
</Response>`;

  res.type('text/xml').send(twiml);
});

wss.on('connection', (twilioWs, req) => {
  const sessionId = req.url.split('/stream/')[1];
  console.log(`New call session: ${sessionId}`);

  let deepgramClient;
  let deepgramLive;
  let transcript = '';
  let silenceTimer;
  let callSid;
  let streamSid;

  deepgramClient = createClient(DEEPGRAM_API_KEY);
  deepgramLive = deepgramClient.listen.live({
    model: 'nova-2',
    language: 'multi',
    punctuate: true,
    interim_results: true,
    endpointing: 800,
    encoding: 'mulaw',
    sample_rate: 8000,
    channels: 1
  });

  deepgramLive.on(LiveTranscriptionEvents.Open, () => {
    console.log('Deepgram connected');
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
        
        if (!fullTranscript) return;
        console.log(`Transcript: ${fullTranscript}`);

        try {
          const response = await fetch(N8N_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              SpeechResult: fullTranscript,
              CallSid: callSid || sessionId,
              StreamSid: streamSid || ''
            })
          });

          const twimlResponse = await response.text();
          
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
  });

  twilioWs.on('close', () => {
    console.log('Twilio disconnected');
    deepgramLive.finish();
  });
});

async function updateTwilioCall(callSid, twiml) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  
  await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${callSid}.json`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ Twiml: twiml })
  });
}

app.get('/twiml/:encoded', (req, res) => {
  const twiml = Buffer.from(decodeURIComponent(req.params.encoded), 'base64').toString('utf8');
  res.type('text/xml').send(twiml);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
