# Vizuara Voice Agent Widget

A floating voice agent widget powered by OpenAI's Realtime API. Drop it into any website to add a voice-based AI assistant.

## Architecture

```
Browser (React widget)
  ↕ WebSocket
Your Server (Express proxy)
  ↕ WebSocket
OpenAI Realtime API (gpt-4o-realtime-preview)
```

The server acts as a proxy to keep the OpenAI API key secure. Audio streams bidirectionally in real-time (24kHz PCM16).

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Create .env.local with your OpenAI key
cp .env.example .env.local
# Edit .env.local and add your OPENAI_API_KEY

# 3. Run in development
npm run dev
```

Open `http://localhost:5173` — you'll see a floating phone icon in the bottom-right corner.

## Production Deployment

```bash
# Build the frontend
npm run build

# Start the server (serves the built frontend + WebSocket proxy)
npm start
```

Deploy to Railway, Render, Fly.io, or any Node.js host that supports WebSockets.

## Integration with an Existing Website

### Option A: Add to your React app
Copy these files into your project:
- `src/services/AudioService.ts`
- `src/services/LatencyTracker.ts`
- `src/services/OpenAIRealtimeService.ts`
- `src/VoiceWidget.tsx`
- `src/voice-widget.css`

Then in your app:
```tsx
import VoiceWidget from "./VoiceWidget";
import "./voice-widget.css";

function App() {
  return (
    <div>
      {/* Your existing app */}
      <VoiceWidget />
    </div>
  );
}
```

You'll still need the server-side WebSocket proxy (`server.ts`) running alongside your backend.

### Option B: Non-React site
Add this to your HTML:
```html
<div id="vizuara-voice-widget"></div>
<script type="module" src="/path/to/built/main.js"></script>
```

## Customization

Edit `src/VoiceWidget.tsx` to change:
- **`SYSTEM_INSTRUCTION`** — the AI's personality, knowledge, and rules
- **`VOICE_NAME`** — OpenAI voice (Fenrir=ash, Puck=alloy, Charon=echo, Kore=coral, Zephyr=sage)
- **`OPENAI_MODEL`** — model (`gpt-4o-realtime-preview` or `gpt-4o-mini-realtime-preview`)
- **`COURSE_LINKS`** — product links that appear during conversation

Edit `src/voice-widget.css` to change colors, sizing, and positioning.

## File Structure

```
├── server.ts                          # Express + WebSocket proxy to OpenAI
├── src/
│   ├── main.tsx                       # Entry point
│   ├── VoiceWidget.tsx                # The floating widget component
│   ├── voice-widget.css               # Self-contained widget styles
│   └── services/
│       ├── AudioService.ts            # Mic capture + audio playback (24kHz PCM16)
│       ├── LatencyTracker.ts          # Turn-by-turn latency metrics
│       └── OpenAIRealtimeService.ts   # WebSocket client for OpenAI Realtime
├── index.html                         # Dev entry point
├── vite.config.ts                     # Vite config with WebSocket proxy
├── package.json
├── tsconfig.json
└── .env.example
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes | OpenAI API key with Realtime API access |
| `PORT` | No | Server port (default: 3000) |

## Features

- Real-time voice conversation with OpenAI's Realtime API
- Server-side VAD (Voice Activity Detection) for natural turn-taking
- Interruption support — speak over the AI and it stops immediately
- Live transcript display
- Auto-detected course/product links shown during conversation
- Email draft detection with copy-to-clipboard
- Volume visualization
- Call timer
- Self-contained CSS (no Tailwind dependency for the widget)
