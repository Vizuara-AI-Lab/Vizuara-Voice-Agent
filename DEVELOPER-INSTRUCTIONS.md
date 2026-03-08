# Developer Instructions — Integrating the Voice Widget into vizuara.ai

## Overview

This repo contains a standalone voice agent widget that lets website visitors talk to an AI assistant in real-time. It uses OpenAI's Realtime API with an Indian English voice (Fenrir/ash). The widget appears as a floating phone icon in the bottom-right corner of the page.

**Live demo:** https://bharatvoice-ai-production.up.railway.app/ (click the purple phone icon in the bottom-right)

---

## Architecture

```
Browser (VoiceWidget React component)
  ↕ WebSocket (/ws/openai-realtime)
Your Server (server.ts — Express + ws proxy)
  ↕ WebSocket (wss://api.openai.com/v1/realtime)
OpenAI Realtime API
```

The server is a thin WebSocket proxy. It exists solely to keep the OpenAI API key off the client. All audio streams bidirectionally in real-time (24kHz PCM16).

---

## Step-by-Step Setup

### 1. Clone and install

```bash
git clone https://github.com/Vizuara-AI-Lab/Vizuara-Voice-Agent.git
cd Vizuara-Voice-Agent
npm install
```

### 2. Add the OpenAI API key

```bash
cp .env.example .env.local
```

Edit `.env.local`:
```
OPENAI_API_KEY=sk-proj-your-key-here
```

> Ask Raj for the OpenAI API key. It's the same key used in the BharatVoice AI project.

This key needs access to the `gpt-4o-realtime-preview` model.

### 3. Test locally

```bash
npm run dev
```

- Vite dev server: http://localhost:5173
- Backend proxy: http://localhost:3000
- Vite automatically proxies `/ws/openai-realtime` to the backend (see `vite.config.ts`)

Click the floating purple phone icon → allow microphone → start talking.

### 4. Understand the key files

| File | What it does |
|------|-------------|
| `server.ts` | Express server + WebSocket proxy to OpenAI. This is the only backend needed. |
| `src/VoiceWidget.tsx` | The entire widget — FAB button, call window, transcript, course links, email detection. Also contains the **system instruction** and **knowledge base** (loaded from `src/knowledge-base.txt`). |
| `src/voice-widget.css` | Self-contained CSS for the widget. No Tailwind dependency. Won't conflict with your site's styles. All classes are prefixed with `voice-widget-`. |
| `src/services/OpenAIRealtimeService.ts` | WebSocket client that talks to the proxy, sends mic audio, receives AI audio. |
| `src/services/AudioService.ts` | Mic capture (24kHz) + audio playback using Web Audio API. |
| `src/services/LatencyTracker.ts` | Tracks turn-by-turn latency (optional, for monitoring). |
| `src/knowledge-base.txt` | The full Vizuara knowledge base — courses, pricing, schedules, FAQs. The AI uses this to answer questions. |

### 5. Integrate into vizuara.ai

#### Option A: If vizuara.ai uses React

Copy these into your project:
```
src/services/AudioService.ts
src/services/LatencyTracker.ts
src/services/OpenAIRealtimeService.ts
src/VoiceWidget.tsx
src/voice-widget.css
src/knowledge-base.txt
src/vite-env.d.ts
```

In your app's root component:
```tsx
import VoiceWidget from "./VoiceWidget";
import "./voice-widget.css";

function App() {
  return (
    <>
      {/* ... your existing app ... */}
      <VoiceWidget />
    </>
  );
}
```

#### Option B: If vizuara.ai is NOT React (plain HTML, WordPress, etc.)

1. Build the widget as a standalone JS bundle:
   ```bash
   npm run build
   ```
   This outputs `dist/assets/main-XXXX.js` and `dist/assets/main-XXXX.css`.

2. Add to your HTML (before `</body>`):
   ```html
   <div id="vizuara-voice-widget"></div>
   <link rel="stylesheet" href="/path/to/voice-widget.css">
   <script type="module" src="/path/to/main.js"></script>
   ```

#### In both cases: You need the server proxy running

The widget needs `server.ts` running as a backend to proxy WebSocket connections to OpenAI. Deploy it alongside your existing backend, or as a separate service.

For example, on Railway:
```bash
npm run build
# Railway will run: npm start (which runs server.ts)
```

The server serves both the static files and the WebSocket proxy on the same port.

---

## Customization

### Changing the AI's behavior
Edit `SYSTEM_INSTRUCTION` at the top of `src/VoiceWidget.tsx`. This controls the AI's personality, accent, rules, and behavior.

### Updating the knowledge base
Edit `src/knowledge-base.txt`. This is the full Vizuara product/course knowledge that the AI references when answering questions. Update it whenever courses, pricing, or schedules change.

### Changing the voice
Edit `VOICE_NAME` in `src/VoiceWidget.tsx`:
- `"Fenrir"` → ash (current — Indian male)
- `"Puck"` → alloy
- `"Charon"` → echo
- `"Kore"` → coral
- `"Zephyr"` → sage

### Changing colors
Edit `src/voice-widget.css`. Key color values:
- `#c084fc` — purple (primary)
- `#f472b6` — pink (secondary/accent)
- `#121212` — dark background
- `#ef4444` — red (end call button)

### Changing position
In `voice-widget.css`, find `.voice-widget-fab` and `.voice-widget-window` — change `bottom` and `right` values.

---

## Deployment Checklist

- [ ] `OPENAI_API_KEY` is set in environment variables
- [ ] Server supports WebSocket connections (Railway, Render, Fly.io all work; Vercel/Netlify do NOT support WebSockets)
- [ ] Widget CSS is loaded on the page
- [ ] `<div id="vizuara-voice-widget"></div>` exists in the HTML (if not using React integration)
- [ ] Microphone permissions are allowed (site must be served over HTTPS in production)
- [ ] Test a call end-to-end: click icon → allow mic → speak → hear response

---

## Costs

OpenAI Realtime API pricing (as of March 2026):
- **Audio input:** $0.06 / minute
- **Audio output:** $0.24 / minute
- **Text tokens:** standard GPT-4o pricing

A typical 5-minute call costs approximately $1.50.

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| "OPENAI_API_KEY not set" error | Make sure `.env.local` exists and has the key |
| WebSocket connection fails | Ensure your host supports WebSockets (not Vercel/Netlify) |
| No audio / mic not working | Must be served over HTTPS in production. Check browser mic permissions. |
| Widget doesn't appear | Ensure `<div id="vizuara-voice-widget"></div>` is in the HTML and the JS bundle is loaded |
| Audio choppy or delayed | Normal on slow connections. The widget uses 24kHz PCM16 streaming. |
