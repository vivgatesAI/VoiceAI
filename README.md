# DRISHTI - Voice-to-Voice AI Assistant

A real-time voice-to-voice AI assistant that uses Venice AI for speech recognition, chat completions, and text-to-speech. Speak naturally and get AI responses spoken back to you.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         BROWSER (Client)                            │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐             │
│  │   Web Audio │    │   Fetch     │    │   Audio     │             │
│  │   API       │───▶│   API       │───▶│   Playback  │             │
│  │  (Record)   │    │  (Stream)   │    │   (TTS)     │             │
│  └─────────────┘    └─────────────┘    └─────────────┘             │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      NODE.JS SERVER (Express)                       │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐             │
│  │ /api/       │    │ /api/chat   │    │ /api/tts    │             │
│  │ transcribe  │    │ (SSE)       │    │             │             │
│  └─────────────┘    └─────────────┘    └─────────────┘             │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        VENICE AI API                                │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐             │
│  │ ASR         │    │ Chat        │    │ TTS         │             │
│  │ (Parakeet)  │    │ Completions │    │ (Kokoro)    │             │
│  └─────────────┘    └─────────────┘    └─────────────┘             │
└─────────────────────────────────────────────────────────────────────┘
```

## How It Works

### 1. Voice Input (Browser → Server)
- User holds button or uses VAD (Voice Activity Detection)
- Browser's `MediaRecorder` captures audio as WebM/Opus
- Audio blob is sent to `/api/transcribe`

### 2. Speech-to-Text (Server → Venice ASR)
- Server sends audio to Venice AI's ASR endpoint
- Uses NVIDIA Parakeet model for transcription
- Returns text transcription to client

### 3. Chat Completion (Server ↔ Venice Chat)
- Client sends transcribed text to `/api/chat`
- Server streams response using **Server-Sent Events (SSE)**
- Venice AI generates response with streaming enabled
- Tokens are sent to client in real-time

### 4. Text-to-Speech (Server → Venice TTS)
- Complete sentences are sent to `/api/tts`
- Venice AI converts text to MP3 audio
- Audio is queued and played back in order

## Venice AI Integration

### API Endpoints Used

| Endpoint | Purpose | Model |
|----------|---------|-------|
| `/api/v1/audio/transcriptions` | Speech-to-Text | `nvidia/parakeet-tdt-0.6b-v3` |
| `/api/v1/chat/completions` | Chat (streaming) | Configurable (e.g., `grok-41-fast`) |
| `/api/v1/audio/speech` | Text-to-Speech | `kokoro` with various voices |

### Key Venice Parameters

```javascript
// Chat request body
{
  model: "grok-41-fast",
  messages: [...],
  stream: true,
  temperature: 0.7,
  max_tokens: 500,
  venice_parameters: {
    strip_thinking_response: true  // Important for reasoning models
  }
}
```

### Reasoning Models
Venice AI offers reasoning models (Grok, GLM, Qwen, DeepSeek) that emit `<think>...</think>` tags. The `strip_thinking_response: true` parameter tells Venice to remove these before sending the response.

## Project Structure

```
voice-to-voice/
├── server.js           # Express server with API routes
├── public/
│   ├── index.html      # UI with orb visualization
│   ├── app.js          # Client-side JavaScript
│   └── style.css       # Styling
├── package.json        # Dependencies
└── .env                # Environment variables (not in git)
```

## Setup Instructions

### 1. Prerequisites
- Node.js 18+ installed
- Venice AI API key (get from https://venice.ai)

### 2. Clone and Install

```bash
git clone https://github.com/vivgatesAI/VoiceAI.git
cd VoiceAI
npm install
```

### 3. Configure Environment

Create a `.env` file:

```env
VENICE_API_KEY=your_api_key_here
CHAT_MODEL=grok-41-fast
TTS_VOICE=am_adam

# Telegram relay (for website-to-chat)
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
```

### 4. Run Locally

```bash
node server.js
```

Open http://localhost:3000 in your browser.

## API Routes

### POST `/api/transcribe`
Converts audio to text.

**Request:** `multipart/form-data` with `audio` file field

**Response:**
```json
{
  "text": "What are the seven wonders of the world?"
}
```

### POST `/api/chat`
Streams chat response via SSE.

**Request:**
```json
{
  "messages": [
    { "role": "user", "content": "Hello" }
  ],
  "model": "grok-41-fast"
}
```

**Response (SSE stream):**
```
data: {"type":"token","token":"Hello"}
data: {"type":"token","token":"!"}
data: {"type":"sentence","index":0,"text":"Hello!"}
data: {"type":"done","sentenceCount":1}
```

### POST `/api/tts`
Converts text to speech.

**Request:**
```json
{
  "text": "Hello, how can I help you?",
  "index": 0,
  "voice": "am_adam"
}
```

**Response:** MP3 audio buffer

## Issues We Fixed

### Issue 1: Brotli Compression Breaking Streams

**Problem:** Venice API responses were Brotli-compressed (`content-encoding: br`), but Node.js `fetch` doesn't auto-decompress, causing `reader.read()` to hang.

**Solution:** Added `Accept-Encoding: identity` header to disable compression:
```javascript
headers: {
  'Authorization': `Bearer ${API_KEY}`,
  'Content-Type': 'application/json',
  'Accept-Encoding': 'identity'  // Disable compression
}
```

### Issue 2: Node.js Fetch Streaming Issues

**Problem:** Native `fetch()` and async iterators weren't reliably streaming response data in Node.js.

**Solution:** Switched to native `https` module for reliable streaming:
```javascript
const https = require('https');

const veniceReq = https.request(options, (veniceRes) => {
  veniceRes.setEncoding('utf8');
  veniceRes.on('data', (chunk) => {
    // Process SSE chunks
  });
});
```

### Issue 3: Reasoning Model Thinking Tags

**Problem:** Reasoning models (Grok, GLM, etc.) emit `<think>...</think>` tags that shouldn't be shown to users.

**Solution:** Enable Venice's built-in stripping for all models:
```javascript
requestBody.venice_parameters = {
  strip_thinking_response: true
};
```

### Issue 4: Client Aborting Connection Early

**Problem:** Browser was closing SSE connection before server finished processing.

**Investigation:** Added logging to track `req.on('close')` events. Found that the client's fetch was being cancelled.

**Debug approach:**
```javascript
req.on('close', () => { 
  console.log('[Chat] Client connection closed!');
  aborted = true; 
});
```

## Available Models (Venice AI)

### Chat Models
- `grok-41-fast` - Fast Grok model
- `venice-uncensored` - Uncensored model
- `llama-3.3-70b` - Llama 3.3 70B
- `qwen3-235b-a22b` - Qwen 3 large
- `deepseek-r1-671b` - DeepSeek reasoning

### TTS Voices
- `am_adam` - American male (Adam)
- `af_sarah` - American female (Sarah)
- `bf_emma` - British female (Emma)
- `bm_george` - British male (George)

## Client-Side Features

### Voice Activity Detection (VAD)
Automatically detects when user starts/stops speaking:
```javascript
VAD.start({
  onSpeechStart: () => { /* Start recording */ },
  onSpeechEnd: () => { /* Process recording */ }
});
```

### Settings Panel
UI for selecting model and voice:
```javascript
const Settings = {
  model: 'grok-41-fast',
  voice: 'am_adam',
  // Persists to localStorage
};
```

### Audio Queue
Ensures TTS audio plays in correct order:
```javascript
class AudioQueueManager {
  enqueue(index, audioBuffer) { /* ... */ }
  waitForCompletion() { /* ... */ }
}
```

## Deployment

### Railway
1. Connect GitHub repo to Railway
2. Set environment variables:
   - `VENICE_API_KEY`
   - `CHAT_MODEL`
   - `TTS_VOICE`
3. Deploy

### SSE Headers for Proxies
Important headers to prevent buffering:
```javascript
res.setHeader('Content-Type', 'text/event-stream');
res.setHeader('Cache-Control', 'no-cache');
res.setHeader('Connection', 'keep-alive');
res.setHeader('X-Accel-Buffering', 'no');  // For Nginx
```

## Troubleshooting

### No audio recording
- Check microphone permissions in browser
- Ensure HTTPS (required for `getUserMedia`)

### Responses not streaming
- Check browser console for errors
- Verify Venice API key is valid
- Check server logs for connection issues

### TTS not playing
- Verify TTS toggle is enabled
- Check browser audio permissions
- Look for decoding errors in console

## Tech Stack

- **Backend:** Node.js, Express
- **Frontend:** Vanilla JavaScript, Web Audio API
- **AI Provider:** Venice AI
- **Protocols:** SSE for streaming, FormData for file uploads

## License

MIT

## Credits

Built with [Venice AI](https://venice.ai) APIs.
