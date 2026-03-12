# TEST PLAN — Victor's Paint Shop AI Phone Receptionist
**Date:** 2026-03-12
**System version:** index.js commit 1242e5b / wf_current.json

---

## HOW TO READ THIS DOCUMENT

Each test case follows this structure:

- **ID** — unique identifier for tracking
- **Purpose** — what is being verified
- **Setup** — preconditions before the test runs
- **Script** — the exact exchange (A = AI/system, C = Caller)
- **Expected outcome** — what must be true for the test to pass
- **Watch in logs** — specific log lines or patterns to confirm in `/logs` endpoint
- **Known risks** — open issues from MISTAKES.md that may affect this test

---

## SECTION 1: HAPPY PATH TESTS (ALL 5 LANGUAGES)

Each happy path test verifies that a caller can complete all 5 booking fields in a single call, receive the [BOOKING COMPLETE] signal, and trigger SMS + WhatsApp + Airtable records.

---

### TC-HP-01: English — Full Booking

**Purpose:** Confirm the complete English booking flow end-to-end.

**Setup:**
- System must be running on Railway (n8n + deepgram-twilio-server)
- English AI agent active with Claude Haiku 4.5, maxTokens=250
- Airtable, Twilio SMS, WhatsApp credentials live in n8n

**Script:**

```
[Call connects]
A: "Hi! I'm Victor's Paint Shop AI assistant, how can I help you today?"

C: "Hi, I'd like to book a painting job."

A: "Great! What service do you need — interior, exterior, or something else?"

C: "Interior painting."

A: "What's your first name?"

C: "Michael."

A: "What's your 10-digit phone number, Michael?"

C: "Six five oh, seven seven two, four four three one."

A: "I have 6, 5, 0, 7, 7, 2, 4, 4, 3, 1 — is that correct?"

C: "Yes, that's right."

A: "What's your address? Street and city please."

C: "123 Oak Street, San Francisco."

A: "I have 123 Oak Street, San Francisco — is that correct?"

C: "Yes."

A: "When would you like to schedule? Date and time."

C: "Next Friday at 10am."

A: "[BOOKING COMPLETE] Name: Michael Phone: 6507724431 Address: 123 Oak Street, San Francisco Service: Interior painting Date: Next Friday at 10am"
```

**Expected outcome:**
1. Caller hears greeting within 3 seconds of call connecting
2. Each AI response plays via Polly.Ruth-Neural voice
3. After "yes" on date/time, SMS fires to caller's number
4. WhatsApp message fires to shop
5. Airtable record created with all 5 fields populated
6. Call ends gracefully (or AI says goodbye and Twilio hangs up)

**Watch in logs:**
- `Incoming call. CallSid: CA...`
- `Stream started: CA...`
- `Language confirmed: English (explicit Deepgram detection)` OR `Language confirmed: English (fallback)`
- `n8n response received, updating call` (fires once per turn)
- `Phone number request detected — listening for spoken digits first`
- `Phone spoken OK (...digits) — sending to n8n normally`
- `Phone confirmed — clearing phone collection state`
- `updateTwilioCall OK: 200` (fires once per turn)
- No `ERR` lines

**Known risks:**
- MISTAKE #004: 250 token limit may still truncate digit readback. Monitor response length.
- MISTAKE #006: ~500ms race window between stream stop and new TwiML. If caller hears silence after phone confirmation, add `<Pause length="1"/>` in n8n Code node.

---

### TC-HP-02: Portuguese — Full Booking

**Purpose:** Confirm full booking flow in Brazilian Portuguese.

**Setup:**
- Same as TC-HP-01
- Deepgram `language: 'multi'` mode must detect Portuguese from first utterance

**Script:**

```
[Call connects]
A: "Hi! I'm Victor's Paint Shop AI assistant, how can I help you today?"

C: "Oi, eu preciso pintar minha casa."

A: [Portuguese agent activates] "Olá! Aqui é o assistente virtual da Victor's Paint Shop. Que serviço você precisa?"

C: "Pintura interior."

A: "Qual é o seu nome?"

C: "Carlos."

A: "Qual é o seu número de telefone, Carlos?"

C: "Quatro um cinco, seis dois oito, dois dois nove dois."

A: "Anotei 4, 1, 5, 6, 2, 8, 2, 2, 9, 2 — está correto?"

C: "Sim."

A: "Qual é o seu endereço? Rua e cidade."

C: "Rua das Flores, duzentos e quarenta e cinco, San Jose."

A: "Anotei Rua das Flores, 245, San Jose — está correto?"

C: "Sim."

A: "Qual é a data e hora que você prefere?"

C: "Sábado às dois da tarde."

A: "[BOOKING COMPLETE] Name: Carlos Phone: 4156282292 Address: Rua das Flores 245, San Jose Service: Pintura interior Date: Sábado às 14h"
```

**Expected outcome:**
1. Language switches to Portuguese after "Oi, eu preciso pintar minha casa"
2. All subsequent turns use Polly.Vitoria-Neural voice
3. n8n routes to Portuguese AI agent on all turns
4. Booking complete fires SMS/WhatsApp/Airtable

**Watch in logs:**
- `Text detected: Portuguese from "Oi, eu preciso pintar minha casa"`  OR `Deepgram detected: Portuguese (pt-BR)`
- `Non-English confirmed: Portuguese, switching Deepgram`
- `Sending to n8n: "LANGUAGE_SWITCHED: Oi, eu preciso pintar minha casa"` (3+ words, so combined)
- `Language confirmed` not appearing twice (no double-detection)
- `TTS lock set for ...ms` using Vitoria-Neural voice path

**Known risks:**
- Text regex for Portuguese must match "preciso" and "pintar" (confirmed in ptOnly pattern in index.js line 280).
- Deepgram language_confidence threshold: if confidence < 0.85, text regex must pick it up as fallback.
- MISTAKE #010 is now fixed (0.85 threshold applied in index.js line 430).

---

### TC-HP-03: Spanish — Full Booking

**Purpose:** Confirm full booking flow in Spanish.

**Script:**

```
[Call connects]
A: "Hi! I'm Victor's Paint Shop AI assistant, how can I help you today?"

C: "Hola, necesito pintar mi casa."

A: [Spanish agent activates] "¡Hola! Soy el asistente de Victor's Paint Shop. ¿Qué servicio necesitas?"

C: "Pintura exterior."

A: "¿Cuál es tu nombre?"

C: "Maria."

A: "¿Cuál es tu número de teléfono, Maria?"

C: "Seis cinco cero, ocho uno dos, tres cuatro cinco seis."

A: "Tengo 6, 5, 0, 8, 1, 2, 3, 4, 5, 6 — ¿es correcto?"

C: "Sí."

A: "¿Cuál es tu dirección? Calle y ciudad."

C: "Avenida Principal ciento doce, Oakland."

A: "Tengo Avenida Principal 112, Oakland — ¿es correcto?"

C: "Sí."

A: "¿Cuándo quieres agendar? Fecha y hora."

C: "El martes a las nueve de la mañana."

A: "[BOOKING COMPLETE] Name: Maria Phone: 6508123456 Address: Avenida Principal 112, Oakland Service: Pintura exterior Date: Martes a las 9am"
```

**Expected outcome:**
1. Language detection triggers on "Hola, necesito" (matches `hola` + `necesito` in esOnly pattern)
2. Deepgram restarts in `es` mode
3. All turns use Polly.Lupe-Neural
4. Booking complete fires downstream actions

**Watch in logs:**
- `Text detected: Spanish from "Hola, necesito pintar mi casa"` or Deepgram confidence-based detection
- `Non-English confirmed: Spanish, switching Deepgram`
- Spanish n8n agent routing confirmed via booking complete output

**Known risks:**
- "necesito" is in esOnly regex (line 283 of index.js). Confirm match.
- Spanish "Sí" (with accent) — Deepgram STT may return "Si" without accent. Confirm AI agent handles both.

---

### TC-HP-04: Mandarin — Full Booking

**Purpose:** Confirm full booking flow in Mandarin Chinese.

**Script:**

```
[Call connects]
A: "Hi! I'm Victor's Paint Shop AI assistant, how can I help you today?"

C: "你好，我想预约粉刷服务。"
   (Nǐ hǎo, wǒ xiǎng yūyuē fěnshuā fúwù. — Hello, I'd like to book a painting service.)

A: [Mandarin agent activates] "您好！这是Victor油漆店的AI助手。您需要什么服务？"

C: "室内粉刷。"

A: "请问您的姓名是？"

C: "李明。"

A: "李明，请问您的电话号码是多少？"

C: "四一五，六二八，二二九二。"

A: "我记录的是4, 1, 5, 6, 2, 8, 2, 2, 9, 2，对吗？"

C: "对。"

A: "请问您的地址是？街道和城市。"

C: "旧金山市橡树街一二三号。"

A: "我记录的是旧金山市橡树街123号，对吗？"

C: "对。"

A: "您希望预约什么时间？日期和时间。"

C: "下周三上午十点。"

A: "[BOOKING COMPLETE] Name: 李明 Phone: 4156282292 Address: 旧金山市橡树街123号 Service: 室内粉刷 Date: 下周三上午10点"
```

**Expected outcome:**
1. Unicode character range `[\u4E00-\u9FFF]` in detectLanguageFromText fires immediately on first Chinese utterance
2. Deepgram restarts in `zh` mode
3. All turns use Polly.Zhiyu-Neural
4. Non-ASCII characters preserved throughout (per MISTAKE #002 fix)

**Watch in logs:**
- `Text detected: Mandarin from "你好..."` (Unicode range detection — does NOT need 2+ word check for CJK)
- `Non-English confirmed: Mandarin, switching Deepgram`
- `LANGUAGE_SWITCHED: 你好，我想预约粉刷服务` (full utterance combined since ≥3 words)
- No ASCII stripping visible in TwiML preview log lines

**Known risks:**
- MISTAKE #002: Ensure Code node in n8n preserves Chinese characters. Check TwiML preview log for correct unicode.
- Deepgram nova-2-general in `zh` mode may not support tone diacritics — test with native speaker.
- Polly.Zhiyu-Neural supports Mandarin. Confirm voice tag in n8n Code node output.

---

### TC-HP-05: Arabic — Full Booking

**Purpose:** Confirm full booking flow in Arabic.

**Script:**

```
[Call connects]
A: "Hi! I'm Victor's Paint Shop AI assistant, how can I help you today?"

C: "مرحبا، أريد حجز خدمة طلاء."
   (Marhaba, ureed hajz khedmat tila'. — Hello, I want to book a painting service.)

A: [Arabic agent activates] "مرحباً! أنا المساعد الذكي لمحل Victor للدهانات. ما الخدمة التي تحتاجها؟"

C: "طلاء داخلي."

A: "ما اسمك الكريم؟"

C: "أحمد."

A: "أحمد، ما رقم هاتفك؟"

C: "أربعة واحد خمسة، ستة اثنين ثمانية، اثنين اثنين تسعة اثنين."

A: "سجلت الرقم: 4، 1، 5، 6، 2، 8، 2، 2، 9، 2 — هل هذا صحيح؟"

C: "نعم."

A: "ما عنوانك؟ الشارع والمدينة."

C: "شارع البلوط مئة وثلاثة وعشرون، سان فرانسيسكو."

A: "سجلت: شارع البلوط 123، سان فرانسيسكو — هل هذا صحيح؟"

C: "نعم."

A: "متى تريد الموعد؟ التاريخ والوقت."

C: "الجمعة القادمة الساعة العاشرة صباحاً."

A: "[BOOKING COMPLETE] Name: أحمد Phone: 4156282292 Address: شارع البلوط 123، سان فرانسيسكو Service: طلاء داخلي Date: الجمعة القادمة الساعة 10 صباحاً"
```

**Expected outcome:**
1. Arabic Unicode range `[\u0600-\u06FF]` fires immediately on first Arabic utterance
2. Deepgram restarts in `ar` mode
3. All turns use Polly.Zeina (Standard — NOT Neural, no `-Neural` suffix)
4. Arabic characters preserved in TwiML output (per MISTAKE #002 fix)
5. Caller hears noticeably lower audio quality vs other languages — this is expected (MISTAKE #005, accepted limitation)

**Watch in logs:**
- `Text detected: Arabic from "مرحبا..."` (fires before Deepgram confidence check since Unicode is unambiguous)
- `Non-English confirmed: Arabic, switching Deepgram`
- TwiML preview in log shows `voice="Polly.Zeina"` (not Polly.Zeina-Neural, which would cause EngineNotSupportedException)
- Arabic characters visible and unstripped in TwiML preview

**Known risks:**
- MISTAKE #005: Polly.Zeina is Standard quality. Do not attempt to add `-Neural` — it will throw `EngineNotSupportedException`.
- MISTAKE #002: Most critical for Arabic — any stripping of `\u0600-\u06FF` range will break TTS and voice detection.
- Deepgram `ar` / `ar-001` mode accuracy for phone digit words in Arabic — may need DTMF fallback more often.

---

## SECTION 2: LANGUAGE DETECTION TESTS

---

### TC-LD-01: Ambiguous First Utterance — "Ok"

**Purpose:** Verify that a single ambiguous word does not trigger a false language switch or lock the call into the wrong agent.

**Script:**

```
[Call connects]
A: "Hi! I'm Victor's Paint Shop AI assistant, how can I help you today?"

C: "Ok."

[No language switch. AI either waits silently or asks a follow-up.]

C: "I need to paint my house."

A: [English agent responds] "Sure, what type of service do you need?"
```

**Expected outcome:**
1. "Ok" does NOT trigger Portuguese detection (previously "ok" was in ptOnly regex — confirmed removed per comment in index.js line 278)
2. "Ok" does NOT trigger Spanish detection (not in esOnly pattern)
3. Single word below 2-word threshold — no language confirmation fires
4. Second utterance "I need to paint my house" is 6 words — Deepgram detects English, languageConfirmed = true
5. English agent handles both turns

**Watch in logs:**
- No `Text detected: Portuguese` or `Text detected: Spanish` on "Ok"
- `Language confirmed: English (explicit Deepgram detection)` fires after 2nd utterance
- No language switch, no Deepgram restart

**Known risks:**
- Single-word `PT_SINGLE_WORD` regex (line 260 of index.js) only matches: `oi|ola|tchau|obrigado|obrigada|sim|nao`. "Ok" is not in this list. Verify no regression.

---

### TC-LD-02: Ambiguous First Utterance — "Hello"

**Purpose:** Same as TC-LD-01 but with the English word "hello."

**Script:**

```
[Call connects]
A: "Hi! I'm Victor's Paint Shop AI assistant, how can I help you today?"

C: "Hello."

[No action — single word, ambiguous, below threshold]

C: "Can I book an appointment?"

A: [English agent] "Of course! What service do you need?"
```

**Expected outcome:**
1. "Hello" is 1 word, not in PT_SINGLE_WORD or esOnly — no language detected
2. "Can I book an appointment" is 5 words, Deepgram detects `en-US` with high confidence
3. English confirmed on second utterance

**Watch in logs:**
- No language detection log line on "Hello"
- `Language confirmed: English` fires after second utterance

---

### TC-LD-03: Single Unmistakable Portuguese Greeting — "Oi"

**Purpose:** Verify that "oi" (Portuguese hello) triggers Portuguese detection via PT_SINGLE_WORD single-word bypass.

**Script:**

```
[Call connects]
A: "Hi! I'm Victor's Paint Shop AI assistant, how can I help you today?"

C: "Oi."

A: [Portuguese agent activates, speaks in Portuguese]
```

**Expected outcome:**
1. "oi" matches PT_SINGLE_WORD regex (line 260 in index.js) via single-word code path
2. Portuguese confirmed, Deepgram restarts in `pt` mode
3. n8n called with `LANGUAGE_SWITCHED` (not combined, because 1 word < 3-word threshold)

**Watch in logs:**
- `Text detected: Portuguese from "Oi"` (single-word match)
- `Non-English confirmed: Portuguese, switching Deepgram`
- `Sending to n8n: "LANGUAGE_SWITCHED"` (NOT "LANGUAGE_SWITCHED: Oi" — too short)

---

### TC-LD-04: Language Switch Mid-Call

**Purpose:** Verify that if a caller starts in English then switches to Spanish, the system re-detects and routes correctly.

**Note:** Mid-call language switching is only possible BEFORE `languageConfirmed` is set to true. Once confirmed, the language is locked for the session. This test verifies the pre-confirmation window.

**Script:**

```
[Call connects]
A: "Hi! I'm Victor's Paint Shop AI assistant, how can I help you today?"

C: "Hmm..." [garbled, no valid text]

[languageConfirmed still false]

C: "Hola, necesito un servicio de pintura."

A: [Spanish agent activates] "¡Hola! ¿Qué servicio necesitas?"
```

**Expected outcome:**
1. First utterance either too short or unrecognized — no language confirmed
2. Spanish detected on second utterance (6 words, "hola" + "necesito" match esOnly)
3. Language locked to Spanish for remainder of call

**Watch in logs:**
- `Language confirmed: Spanish` (not English)
- `Non-English confirmed: Spanish, switching Deepgram`

---

### TC-LD-05: Mixed Language Utterance — Spanish/English

**Purpose:** Verify behavior when a caller mixes Spanish and English in one utterance (code-switching).

**Script:**

```
[Call connects]
A: "Hi! I'm Victor's Paint Shop AI assistant, how can I help you today?"

C: "Hi I want painting service, yo necesito pintura."
```

**Expected outcome — two acceptable outcomes:**
1. **Option A (preferred):** Text regex detects Spanish ("necesito", "pintura" both in esOnly) → routes to Spanish agent
2. **Option B (acceptable):** Deepgram detects `en-US` with high confidence → routes to English agent, then caller clarifies

**Watch in logs:**
- Either `Text detected: Spanish` OR `Language confirmed: English`
- No crash, no silence, no stuck session

---

### TC-LD-06: Romanized Arabic — "Marhaba"

**Purpose:** Verify that romanized Arabic (Arabic words typed/spoken in Latin script) triggers Arabic detection.

**Script:**

```
[Call connects]
A: "Hi! I'm Victor's Paint Shop AI assistant, how can I help you today?"

C: "Marhaba, ana areed service."
```

**Expected outcome:**
1. `arRomanized` regex in index.js (line 285) matches "marhaba" and "areed"
2. Arabic detected, Deepgram restarts in `ar` mode
3. System responds in Arabic

**Watch in logs:**
- `Text detected: Arabic from "Marhaba, ana areed service"`
- `Non-English confirmed: Arabic, switching Deepgram`

---

### TC-LD-07: Failed Detection → Keypad Fallback

**Purpose:** Verify that after 6 consecutive failed detections, the system correctly redirects to the language menu.

**Setup:** Simulate 6 utterances that are ambiguous or produce empty transcripts. This is hard to do manually — it is more of a code inspection test. Verify the threshold in index.js lines 490–496.

**Script:**

```
[6 consecutive utterances produce no language match and failedDetectionCount increments to 6]

A: [Language menu plays]
   "It seems like you may be having trouble. Press 1 for English. Press 2 for Portuguese.
    Press 3 for Spanish. Press 4 for Mandarin. Press 5 for Arabic."

C: [Presses 2]

A: [Portuguese greeting plays via Polly.Vitoria-Neural]
```

**Expected outcome:**
1. After 6 failed detections (or utterances where English is inferred but failedDetectionCount reaches threshold), `/language-menu` is triggered via `updateTwilioCall`
2. Menu plays all 5 options
3. Keypad press routes to correct language agent
4. Language is locked via `preselectedLanguage` in WebSocket URL path

**Watch in logs:**
- `Detection failed, triggering language menu` (log line at index.js line 492)
- `Language menu triggered for: CA...`
- `Language picked: Portuguese for CA...`
- `Initial TTS lock 5000ms for preselected language greeting`

**Known risks:**
- The failedDetectionCount >= 6 check (line 490) is inside `if (!languageConfirmed)` — but `languageConfirmed` is set to true on the first English fallback at line 487. In practice, the menu may never trigger because English is confirmed before 6 fails. This is a code logic gap to be aware of.

---

### TC-LD-08: Mandarin Pinyin Detection — "Nihao"

**Purpose:** Verify romanized Mandarin (Pinyin) triggers Mandarin detection.

**Script:**

```
[Call connects]
A: "Hi! I'm Victor's Paint Shop AI assistant, how can I help you today?"

C: "Nihao, wo yao yuyue yige."
```

**Expected outcome:**
1. `zhPinyin` regex (line 287) matches "nihao"
2. Mandarin detected, Deepgram restarts in `zh` mode
3. Response uses Polly.Zhiyu-Neural

**Watch in logs:**
- `Text detected: Mandarin from "Nihao, wo yao yuyue yige"`

---

## SECTION 3: PHONE NUMBER COLLECTION TESTS

---

### TC-PH-01: Spoken Phone Number — Clean 10 Digits

**Purpose:** Verify a cleanly spoken 10-digit number is captured and confirmed without DTMF fallback.

**Script (mid-booking, after name collected):**

```
A: "What's your 10-digit phone number?"

C: "4156282292"
   [spoken as "four one five six two eight two two nine two"]
```

**Expected outcome:**
1. `isPhoneNumberRequest` fires on AI's question → `phoneCollectionPending.add(callSid)`
2. Silence timer is set to 3000ms (extended for phone collection)
3. Transcript contains digit words; `digitWordPattern` regex captures ≥7 words
4. totalDigits >= 7 → phone sent to n8n normally, NO DTMF fallback
5. AI reads back digits one-by-one for confirmation

**Watch in logs:**
- `Phone number request detected — listening for spoken digits first (CA...)`
- `Phone spoken OK (0 raw + 10 word = 10 digits) — sending to n8n normally`
- `phoneCollectionPending.delete` before forwarding to n8n

---

### TC-PH-02: Spoken Phone Number — With Pauses

**Purpose:** Verify that natural pauses within a digit string do not cause the number to split across two turns.

**Script:**

```
A: "What's your 10-digit phone number?"

C: "Four one five... [1.5s pause] ...six two eight two two nine two."
```

**Expected outcome:**
1. During phone collection, silence timer is 3000ms (index.js line 508)
2. A 1.5s pause within the number does not fire the silence timer (3000ms > 1500ms pause)
3. Complete number arrives in single processTranscript call
4. Digits counted correctly across the full string

**Watch in logs:**
- Single `Transcript:` log line with full number (not two separate lines)
- `Phone spoken OK (...digits) — sending to n8n normally`

**Known risks:**
- MISTAKE #012: This was a confirmed production bug. Fixed by extending silence timer to 3000ms during phone collection. Verify fix holds.

---

### TC-PH-03: Spoken Phone Number — Word Digits Only

**Purpose:** Verify that spoken digit words ("four", "one", "five") are counted correctly by digitWordPattern regex.

**Script:**

```
A: "What's your 10-digit phone number?"

C: "Four one five six two eight two two nine two."
```

**Expected outcome:**
1. `digitWordPattern` regex matches all 10 spoken words
2. `rawDigits = 0`, `wordDigits = 10`, `totalDigits = 10`
3. totalDigits >= 7 → no DTMF fallback triggered

**Digit word coverage check (from index.js line 540):**
- English: zero, one, two, three, four, five, six, seven, eight, nine, oh
- Portuguese: um, uma, dois, duas, três, quatro, cinco, seis, sete, oito, nove
- Spanish: cero, uno, una, siete, ocho, nueve (plus shared: dos, tres, cuatro, cinco, seis)
- Note: Mandarin and Arabic digit words are NOT in this regex — DTMF fallback is more likely for those languages

**Watch in logs:**
- `Phone spoken OK (0 raw + 10 word = 10 digits)`

---

### TC-PH-04: DTMF Fallback — Spoken Number Not Captured

**Purpose:** Verify that if fewer than 7 digits are captured from voice, the system switches to DTMF keypad entry.

**Script:**

```
A: "What's your 10-digit phone number?"

C: "Um... I'm not sure." [no digits spoken]
```

**Expected outcome:**
1. `totalDigits < 7` → DTMF fallback triggers
2. `dtmfSessions.add(callSid)` blocks further voice transcripts
3. AI says (in caller's language): "Please type your 10-digit phone number on the keypad."
4. `<Gather input="dtmf" numDigits="10" ...>` TwiML sent via updateTwilioCall
5. Caller types digits; `/phone-dtmf-received` receives them
6. Digits forwarded to n8n as SpeechResult
7. n8n AI reads back digits for confirmation

**Watch in logs:**
- `Phone not captured (X digits total) — switching to DTMF`
- `dtmfSessions.add` (implicit — DTMF entry now active)
- `DTMF phone received: "XXXXXXXXXX" for CA...`
- `n8n DTMF response received, returning as Gather action response`

**Known risks:**
- MISTAKE #012 / index.js line 562: Gather timeout is 30 seconds. If caller doesn't type within 30s, a "I didn't receive your number" message plays.

---

### TC-PH-05: DTMF Mid-Call — Voice Transcript Suppression

**Purpose:** Verify that voice transcripts are suppressed while DTMF entry is in progress.

**Script:**

```
[DTMF entry in progress — dtmfSessions has callSid]

[Caller accidentally speaks mid-entry]: "Wait, let me check..."
```

**Expected outcome:**
1. Deepgram still receives audio and may produce a transcript
2. `dtmfSessions.has(callSid)` check (index.js line 412) blocks processing
3. Log shows "Ignored transcript — DTMF phone entry in progress"
4. DTMF entry completes normally
5. After DTMF received, `dtmfSessions.delete(callSid)` restores voice processing

**Watch in logs:**
- `Ignored transcript — DTMF phone entry in progress: "Wait, let me check..."`
- `dtmfSessions.delete` after DTMF received at `/phone-dtmf-received`

---

### TC-PH-06: Phone Confirmation — "No" Response

**Purpose:** Verify the AI re-asks for the phone number when the caller says the readback is wrong.

**Script:**

```
A: "I have 6, 5, 0, 7, 7, 2, 4, 4, 3, 1 — is that correct?"

C: "No, the last digit is two, not one."

A: "My apologies! What is your correct phone number?"

C: "Six five oh, seven seven two, four four three two."

A: "I have 6, 5, 0, 7, 7, 2, 4, 4, 3, 2 — is that correct?"

C: "Yes."
```

**Expected outcome:**
1. AI correctly handles the "no" response and re-asks
2. `phoneCollectionActive` remains set during re-ask (phone not yet confirmed)
3. Extended 3000ms silence timer still applies to second attempt
4. `phoneCollectionActive` only cleared when AI asks for address (`isPhoneConfirmed` fires)

**Watch in logs:**
- `Phone confirmed — clearing phone collection state` fires only AFTER address question is asked, not after first "yes"

---

### TC-PH-07: Phone Collection — Arabic/Mandarin DTMF Likelihood

**Purpose:** Document expected DTMF fallback behavior for Arabic and Mandarin callers.

**Note:** The digitWordPattern regex (line 540) does NOT include Arabic or Mandarin digit words. Callers speaking digits in these languages are expected to fall back to DTMF unless Deepgram transcribes them as numerals.

**Expected behavior:**
1. Mandarin caller says "四一五六二八二二九二" — Deepgram may return digits as "4156282292" (numeric)
2. If returned as numerals, `rawDigits = 10`, captured successfully
3. If returned as Chinese characters, `rawDigits = 0`, `wordDigits = 0` → DTMF fallback

**Verification:** Test live with a Mandarin and Arabic caller to determine which transcription format Deepgram uses.

**DTMF apology messages (for reference from index.js lines 524–530):**
- Mandarin: "请用键盘输入您的10位号码。"
- Arabic: "يرجى إدخال رقمك المكون من 10 أرقام على لوحة المفاتيح."

---

## SECTION 4: EDGE CASE TESTS

---

### TC-EC-01: Very Short Utterance — Single Word Mid-Booking

**Purpose:** Verify that a single-word utterance mid-booking (after language is confirmed) is processed, not ignored.

**Script:**

```
[English, language confirmed, AI just asked for name]

A: "What's your first name?"

C: "John."
```

**Expected outcome:**
1. `data.is_final = true`, text = "John", length = 4 (≥ 2 character minimum)
2. Silence timer 1800ms fires, processTranscript("John") called
3. n8n receives SpeechResult: "John", AI stores name and asks for phone

**Watch in logs:**
- `Transcript: "John" | Language: English`
- `n8n response received, updating call`

**Note:** The 2-character minimum (index.js line 513: `full.length < 2`) passes "John". Single letters like "A" or "I" also pass (length 1 fails the `< 2` check for only empty/1-char strings). This is intentional.

---

### TC-EC-02: Single Character Utterance — Near-Empty Response

**Purpose:** Verify that near-empty transcripts are dropped and do not confuse the AI.

**Script:**

```
A: "What's your first name?"

C: "Uh..." [transcribed as "uh" — 2 chars]
   [or transcribed as "A" — 1 char]
```

**Expected outcome — two cases:**
1. "uh" (length 2) — passes the `< 2` check, IS sent to n8n. AI should ask again.
2. "A" (length 1) — fails `full.length < 2` check, dropped silently. AI waits.

**Watch in logs:**
- For "uh": `Transcript: "uh"` followed by `n8n response received`
- For "A": nothing (transcript dropped)

**Recommendation:** Consider raising minimum length to 3 characters to reduce noise.

---

### TC-EC-03: Caller Hangs Up Mid-Booking

**Purpose:** Verify that a call disconnecting mid-conversation cleans up all session state.

**Script:**

```
[Booking in progress, 2 of 5 fields collected]

[Caller hangs up]
```

**Expected outcome:**
1. Twilio sends `stop` event on WebSocket
2. `twilioWs.on('close')` fires (or `stop` case in message handler)
3. All session state cleaned up:
   - `activeSessions.delete(sessionId)`
   - `sessionLanguages.delete(sessionId)`
   - `dtmfSessions.delete(sessionId)`
   - `phoneCollectionActive.delete(sessionId)`
   - `phoneCollectionPending.delete(sessionId)`
4. `keepaliveInterval` cleared
5. Deepgram connection closed with `dgLive.finish()`
6. No orphaned timers (silenceTimer and speakingTimer cleared)
7. No partial booking sent to Airtable (n8n only fires [BOOKING COMPLETE] path)

**Watch in logs:**
- `Stream stopped` (from `stop` event handler)
- OR `Twilio disconnected` (from `close` event handler)
- No subsequent `n8n response received` or `updateTwilioCall` logs after disconnect

**Known risks:**
- MISTAKE #009 (OPEN): No SIGTERM handler. If Railway redeploys while a call is active, the call drops without cleanup. The session state (Maps/Sets) is cleared on WebSocket close, but the caller experience is abrupt.

---

### TC-EC-04: Caller Stays Silent (No Speech Detected)

**Purpose:** Verify system behavior when caller connects but never speaks.

**Script:**

```
[Call connects]
A: "Hi! I'm Victor's Paint Shop AI assistant, how can I help you today?"

[Caller holds the phone, no speech for 600 seconds]
```

**Expected outcome:**
1. Initial TwiML has `<Pause length="600"/>` (index.js line 152) — Twilio waits up to 600 seconds
2. Deepgram receives audio but generates no transcripts
3. No n8n calls made
4. After 600s Twilio hangs up automatically (end of TwiML)
5. WebSocket `stop` event fires, session cleaned up

**Additional scenario — silence after first utterance:**
```
C: "Hello." [single word — no language confirmed]
[Then silence for 30+ seconds]
```

**Expected:** Silence timer (1800ms) fires after the pause, processTranscript("Hello") called, but "Hello" (5 chars, 1 word) does not reach 3-word threshold for English confirmation. If languageConfirmed is false, the text falls into the ambiguous path. englishUtteranceCount increments.

**Watch in logs:**
- No activity for 600s, then `Stream stopped`

---

### TC-EC-05: Caller Interrupts TTS (Speaks While AI Is Talking)

**Purpose:** Verify that caller speech during TTS playback is buffered and processed after the lock expires, not dropped entirely.

**Script:**

```
A: [speaking long response about address confirmation, TTS lock active ~8 seconds]

C: [interrupts at 3 seconds] "Yes, that's right, and my zip code is 94102."
```

**Expected outcome:**
1. Deepgram transcribes the interruption
2. `isSpeaking = true` → transcript is NOT sent to n8n immediately
3. `data.is_final = true` AND `text.trim().length >= 2` → buffered in `bufferedTranscript`
4. After TTS lock expires, `bufferedTranscript` is processed
5. n8n receives the buffered utterance as if it arrived normally

**Watch in logs:**
- `Buffered transcript during TTS lock: "Yes, that's right, and my zip code is 94102"`
- After TTS lock expiry: `Processing buffered transcript after TTS lock: "..."`
- Followed by `n8n response received`

**Known risks:**
- MISTAKE (TTS estimate): TTS lock uses word-count estimate (`words * 450ms + 1500ms`). If Polly takes longer than estimated, the buffered transcript may fire too early (before Polly finishes speaking), causing overlap. If shorter, the 1500ms buffer prevents most issues.
- Only the LAST buffered transcript is kept. If caller speaks multiple times during TTS, only the most recent is processed.

---

### TC-EC-06: n8n Timeout / Failure

**Purpose:** Verify that a slow or failed n8n response does not permanently block the call.

**Simulated failure scenarios:**
1. n8n returns HTTP 500
2. n8n takes > 30 seconds (fetch timeout)
3. n8n returns malformed TwiML

**Expected outcome for HTTP 500:**
1. `if (!response.ok)` check fires (index.js line 586)
2. `isSpeaking = false` immediately — caller can still speak
3. No `updateTwilioCall` called
4. Error logged: `n8n returned 500: ...`
5. Caller hears silence; may speak again to retry

**Expected outcome for network timeout:**
1. fetch throws, caught in sendToN8n catch block (line 613)
2. `isSpeaking = false` — caller can still speak
3. `pendingForwardUtterance = null` — stale utterance cleared
4. Error logged: `Error sending to n8n: ...`

**Expected outcome for malformed TwiML:**
1. `updateTwilioCall` called with bad TwiML
2. Twilio returns 400
3. Logged as `updateTwilioCall FAILED: 400`
4. Call may go silent; caller can retry

**Watch in logs:**
- `ERR n8n returned 500:` or `ERR Error sending to n8n:`
- `isSpeaking` released (no further TTS lock — caller can speak)

**Note:** There is no user-facing error message (e.g., "Sorry, I'm having trouble") injected on n8n failure. This is a gap — consider adding a fallback `<Say>` response.

---

### TC-EC-07: Repeated Booking Fields (Caller Corrects Themselves)

**Purpose:** Verify the AI correctly handles mid-flow corrections.

**Script:**

```
A: "What's your first name?"

C: "Tom — actually, sorry, it's Thomas."

A: "Got it, Thomas. What's your 10-digit phone number?"
```

**Expected outcome:**
1. Single turn sends full text "Tom actually sorry it's Thomas" to n8n
2. n8n AI agent has conversation history (Simple Memory) — processes correction
3. AI stores "Thomas" (most recent name mention)
4. Booking complete uses "Thomas"

**Watch in logs:**
- Single n8n call with full corrected text
- No duplicate fields in [BOOKING COMPLETE] output

---

### TC-EC-08: Booking Complete — Downstream Verification

**Purpose:** Verify the full downstream chain fires after [BOOKING COMPLETE].

**Checklist (manual verification after TC-HP-01 through TC-HP-05):**

| Check | Method | Pass Criteria |
|-------|--------|---------------|
| SMS to customer | Check customer phone | Receives confirmation SMS from +1 628 877 8185 |
| WhatsApp to shop | Check shop WhatsApp | Receives booking details message |
| Airtable record | Check Airtable base | New row with all 5 fields + timestamp |
| Call ends gracefully | Listen to call | AI says closing message, call ends |

**Expected SMS format (English):**
```
Your appointment at Victor's Paint Shop is confirmed!
Service: Interior painting
Name: Michael
Phone: 6507724431
Address: 123 Oak Street, San Francisco
Date: Next Friday at 10am
```

---

## SECTION 5: CONCURRENT CALL TESTS

---

### TC-CC-01: Two Simultaneous Calls — Different Languages

**Purpose:** Verify that two concurrent calls maintain completely separate session state, language detection, and AI conversation memory.

**Setup:**
- Two phones available (or use second line and a friend)
- Both calls active simultaneously

**Script:**

```
Phone 1 (English):
  [Call connects to Victor's Paint Shop]
  C1: "Hi, I need interior painting."
  A1: [English responses via Ruth-Neural]

Phone 2 (Spanish, started 15 seconds after Phone 1):
  [Call connects to Victor's Paint Shop]
  C2: "Hola, necesito pintura."
  A2: [Spanish responses via Lupe-Neural]

[Both calls proceed independently through the booking flow]
```

**Expected outcome:**
1. Two separate `CallSid` values (CA_xxx and CA_yyy)
2. `activeSessions` Map has two entries with different keys
3. `sessionLanguages` Map has CA_xxx → English, CA_yyy → Spanish
4. Phone 1 AI has no awareness of Phone 2 conversation (separate Simple Memory nodes, keyed by CallSid)
5. Phone 2 AI has no awareness of Phone 1 conversation
6. Both calls complete to [BOOKING COMPLETE] independently
7. Two separate Airtable records created
8. Two separate SMS messages sent

**Watch in logs:**
- Two distinct `CallSid` values throughout
- No interleaving of booking fields (Phone 1's name/address does not appear in Phone 2's context)
- `Language confirmed: English` and `Language confirmed: Spanish` for separate CallSids
- `TTS lock set for ...ms` only affects its own session

**Known risks:**
- MISTAKE #007 (OPEN): Simple Memory is in-process RAM. If n8n restarts mid-test, both sessions lose memory. Use this test to also verify isolation before migrating to Redis.
- Index.js global state: `activeSessions`, `dtmfSessions`, `phoneCollectionActive`, `phoneCollectionPending`, `sessionLanguages` are all keyed by `callSid`, so isolation is correct. No shared mutable state per session.

---

### TC-CC-02: Two Simultaneous Calls — Same Language

**Purpose:** Verify memory isolation when two callers speak the same language.

**Script:**

```
Phone 1 (English):
  C1: "Hi, I need to book interior painting for John at 123 Main St."

Phone 2 (English, concurrent):
  C2: "Hi, I need exterior painting for Sarah at 456 Oak Ave."
```

**Expected outcome:**
1. English AI agent in n8n handles both calls — each with its own Simple Memory instance keyed by separate `sessionId = CallSid`
2. Phone 1's context (John, 123 Main St) never bleeds into Phone 2's session
3. [BOOKING COMPLETE] for Phone 1 has John's details; Phone 2 has Sarah's details

**Watch in logs:**
- Two distinct `CallSid` values with separate `Language confirmed: English` lines
- [BOOKING COMPLETE] payloads contain correct names per session

---

## SECTION 6: INFRASTRUCTURE / HEALTH TESTS

---

### TC-INF-01: Health Check Endpoint

**Purpose:** Verify the `/health` endpoint returns correct status before running call tests.

**Method:** GET `https://{SERVER_URL}/health`

**Expected response:**
```json
{
  "server": "ok",
  "twilio": "ok",
  "n8n_url": "https://...",
  "account_sid_set": true,
  "auth_token_set": true
}
```

**Fail condition:** Any field other than "ok" — investigate before proceeding with call tests.

---

### TC-INF-02: Live Logs During Test

**Purpose:** Verify the `/logs` endpoint is streaming correctly during a test call.

**Method:**
1. Start a test call
2. In parallel, poll GET `https://{SERVER_URL}/logs` every 5 seconds
3. Confirm log lines appear in real time

**Expected:** Timestamps and log lines from the active call visible within 5 seconds of each event.

---

### TC-INF-03: WebSocket Keepalive — Long Silent Call

**Purpose:** Verify the 30-second ping/pong keepalive prevents Railway proxy from dropping idle connections.

**Method:**
1. Place a call
2. Do not speak for 90 seconds
3. After 90 seconds, speak
4. Verify Deepgram still transcribes correctly

**Expected outcome:**
1. WebSocket stays open past the 60-120s Railway idle timeout (MISTAKE #008 fix: 30s ping interval)
2. Transcript received after 90s silence
3. No `Twilio disconnected` log during the silent period

**Watch in logs:**
- Absence of `Twilio disconnected` during the 90s window
- Transcript after silence processes normally

---

## TEST EXECUTION CHECKLIST

Run tests in this order. Stop and investigate before proceeding if any test fails.

### Phase 1 — Infrastructure Verification (5 minutes)
- [ ] TC-INF-01: Health check passes
- [ ] TC-INF-02: Logs streaming works

### Phase 2 — English Happy Path (10 minutes)
- [ ] TC-HP-01: English full booking completes
- [ ] TC-EC-08: Downstream (SMS, WhatsApp, Airtable) verified

### Phase 3 — Language Detection (15 minutes)
- [ ] TC-LD-01: "Ok" — no false Portuguese detection
- [ ] TC-LD-02: "Hello" — no false detection
- [ ] TC-LD-03: "Oi" — Portuguese via single-word match
- [ ] TC-LD-06: "Marhaba" — Arabic via romanized match
- [ ] TC-LD-07: Language menu fallback (code inspection)

### Phase 4 — Phone Number Collection (15 minutes)
- [ ] TC-PH-01: Clean spoken number captured
- [ ] TC-PH-02: Number with pauses — no split (3000ms timer)
- [ ] TC-PH-03: Word digits counted correctly
- [ ] TC-PH-04: DTMF fallback triggers on insufficient digits
- [ ] TC-PH-05: Voice suppressed during DTMF

### Phase 5 — Remaining Language Happy Paths (30 minutes)
- [ ] TC-HP-02: Portuguese full booking
- [ ] TC-HP-03: Spanish full booking
- [ ] TC-HP-04: Mandarin full booking
- [ ] TC-HP-05: Arabic full booking

### Phase 6 — Edge Cases (20 minutes)
- [ ] TC-EC-01: Single-word name mid-booking
- [ ] TC-EC-03: Hang up mid-booking — cleanup verified
- [ ] TC-EC-04: Caller stays silent
- [ ] TC-EC-05: Caller interrupts TTS — buffering works
- [ ] TC-EC-06: n8n failure — isSpeaking released

### Phase 7 — Concurrent Calls (10 minutes)
- [ ] TC-CC-01: Two languages, memory isolation
- [ ] TC-CC-02: Same language, memory isolation

### Phase 8 — Long Call Stability (10 minutes)
- [ ] TC-INF-03: 90-second silence, keepalive holds

---

## KNOWN OPEN ISSUES TO WATCH DURING TESTING

These issues are documented in MISTAKES.md but not yet fixed. Flag any that manifest during testing:

| ID | Issue | Likelihood | Action if triggered |
|----|-------|-----------|---------------------|
| MISTAKE #004 | 250-token limit may truncate digit readback | Medium | Log full AI response; raise to 300 if truncation seen |
| MISTAKE #006 | ~500ms race between stream stop and new TwiML | Low | If caller hears silence after a turn, add `<Pause length="1"/>` before `<Say>` in n8n Code node |
| MISTAKE #007 | Simple Memory lost on n8n restart | Low during testing | Don't redeploy n8n mid-test |
| MISTAKE #008 | Railway WebSocket idle timeout | Low (keepalive added) | Monitor TC-INF-03 |
| MISTAKE #009 | No graceful shutdown on deploy | Low during testing | Don't redeploy during active calls |

---

## APPENDIX A: POLLY VOICE REFERENCE

| Language | Voice Tag | Type | Notes |
|----------|-----------|------|-------|
| English | `Polly.Ruth-Neural` | Neural | Default greeting voice |
| Portuguese | `Polly.Vitoria-Neural` | Neural | Brazilian Portuguese |
| Spanish | `Polly.Lupe-Neural` | Neural | US Spanish |
| Mandarin | `Polly.Zhiyu-Neural` | Neural | Simplified Chinese |
| Arabic | `Polly.Zeina` | Standard | No Neural option available in Polly |

---

## APPENDIX B: LANGUAGE DETECTION REGEX COVERAGE

| Language | Detection mechanism | Example trigger |
|----------|---------------------|-----------------|
| Arabic | Unicode `\u0600-\u06FF` | Any Arabic script character |
| Mandarin | Unicode `\u4E00-\u9FFF` | Any CJK character |
| Portuguese | PT_SINGLE_WORD (oi, ola, sim, nao...) | Single-word "Oi" |
| Portuguese | ptOnly regex (2+ words) | "preciso pintura" |
| Spanish | esOnly regex (2+ words) | "hola necesito" |
| Arabic (romanized) | arRomanized regex | "marhaba", "ahlan" |
| Mandarin (Pinyin) | zhPinyin regex | "nihao", "xiexie" |
| Deepgram detected | language_confidence >= 0.85 | Any language |

---

*End of TEST PLAN — Victor's Paint Shop AI Phone Receptionist*
*Generated: 2026-03-12*
