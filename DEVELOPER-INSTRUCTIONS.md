# Developer Instructions — Integrating the Voice Widget into vizuara.ai

## Overview

This repo contains a standalone voice agent widget that lets website visitors talk to an AI assistant in real-time. It supports two voice providers that can be switched with a single env var:

| Provider | Model | Cost | Quality |
|----------|-------|------|---------|
| **OpenAI Realtime** (default) | gpt-4o-realtime-preview | ~$0.30/min | Highest — direct audio streaming |
| **VAPI** (fallback) | Vikrant agent (gpt-4o-mini + ElevenLabs) | ~$0.07/min | Good — managed pipeline |

---

## Architecture

```
── OpenAI Mode ──────────────────────────────
Browser (VoiceWidget)
  ↕ WebSocket (/ws/openai-realtime)
Your Server (server.ts — Express + ws proxy)
  ↕ WebSocket (wss://api.openai.com/v1/realtime)
OpenAI Realtime API

── VAPI Mode ────────────────────────────────
Browser (VoiceWidget → VapiService)
  ↕ VAPI Web SDK (direct connection)
VAPI Cloud (Vikrant assistant)
```

---

## Step-by-Step Setup

### 1. Clone and install

```bash
git clone https://github.com/Vizuara-AI-Lab/Vizuara-Voice-Agent.git
cd Vizuara-Voice-Agent
npm install
```

### 2. Configure environment

```bash
cp .env.example .env.local
```

Edit `.env.local`:
```env
# Required for OpenAI mode
OPENAI_API_KEY=sk-proj-your-key-here

# Provider: "openai" or "vapi"
VOICE_PROVIDER=openai

# Cost controls
MAX_CALL_DURATION_SECONDS=300   # 5-minute time cap per call
DAILY_BUDGET_USD=5              # $5/day cap (0 = unlimited)

# VAPI (only needed when VOICE_PROVIDER=vapi)
VAPI_API_KEY=your-vapi-public-key
VAPI_ASSISTANT_ID=ed2c2703-ffcb-4424-86c2-0509ca0da732
```

> Ask Raj for the API keys. The OpenAI key is the same one used in the BharatVoice AI project. The VAPI public key and Vikrant assistant ID are pre-configured.

### 3. Test locally

```bash
npm run dev
```

- Vite dev server: http://localhost:5173
- Backend proxy: http://localhost:3000
- Cost dashboard: http://localhost:3000/admin/costs

Click the floating purple phone icon → allow microphone → start talking.

### 4. Understand the key files

| File | What it does |
|------|-------------|
| `server.ts` | Express server + WebSocket proxy + **cost tracking** + **time cap enforcement** + **cost dashboard**. |
| `src/VoiceWidget.tsx` | The entire widget — FAB button, call window, transcript, course links, email detection. Contains the **system instruction** and **knowledge base**. Handles **provider switching** and **time warnings**. |
| `src/voice-widget.css` | Self-contained CSS. All classes prefixed with `voice-widget-`. Won't conflict with your site's styles. |
| `src/services/OpenAIRealtimeService.ts` | WebSocket client for OpenAI Realtime mode. |
| `src/services/VapiService.ts` | VAPI Web SDK wrapper for VAPI mode. |
| `src/services/AudioService.ts` | Mic capture (24kHz) + audio playback using Web Audio API. |
| `src/services/LatencyTracker.ts` | Turn-by-turn latency tracking (optional). |
| `src/knowledge-base.txt` | Full Vizuara knowledge base — courses, pricing, schedules, FAQs. |
| `data/cost-tracker.json` | Auto-generated cost data (gitignored). |

---

## How to Switch Providers

### Switch from OpenAI → VAPI (to reduce costs)

1. Edit `.env.local`:
   ```env
   VOICE_PROVIDER=vapi
   ```
2. Restart the server (`Ctrl+C`, then `npm run dev` or `npm start`)
3. That's it. All calls now go through VAPI.

### Switch from VAPI → OpenAI (for higher quality)

1. Edit `.env.local`:
   ```env
   VOICE_PROVIDER=openai
   ```
2. Restart the server.

No code changes needed — just change the env var and restart.

---

## How to Change the Budget and Time Cap

### Max call duration
```env
MAX_CALL_DURATION_SECONDS=300   # 5 minutes
```
- Users see a warning banner 30 seconds before the call ends
- The server forcibly closes the connection at the limit
- Change this to any value (e.g., `180` for 3 minutes, `600` for 10 minutes)

### Daily budget
```env
DAILY_BUDGET_USD=5   # $5 per day
```
- When the daily spend reaches this limit, new calls are blocked
- The widget shows a "Daily budget reached" message
- Resets automatically at midnight (UTC)
- Set to `0` for unlimited

### Cost rate adjustments
```env
COST_PER_MIN_REALTIME=0.30   # gpt-4o-realtime: ~$0.06/min input + ~$0.24/min output
COST_PER_MIN_MINI=0.05       # gpt-4o-mini-realtime
COST_PER_MIN_VAPI=0.07       # VAPI
```
These are estimates used for tracking. Adjust if OpenAI or VAPI changes their pricing.

---

## Cost Dashboard

### Viewing costs

Once deployed, visit:
```
https://your-domain.com/admin/costs
```

The dashboard shows:
- **Today's cost, calls, and duration** (summary cards)
- **Budget progress bar** (if a daily budget is set)
- **Current configuration** (provider, max duration, budget, cost rate)
- **Today's sessions** (time, provider, model, duration, cost per session)
- **30-day history** (daily totals)

### API access to cost data
```bash
# Today's summary
curl https://your-domain.com/api/costs/today

# Last 30 days
curl https://your-domain.com/api/costs
```

### Where is cost data stored?
In `data/cost-tracker.json` on the server. This file is auto-created and gitignored. If you redeploy to a new server, the history resets (consider using a persistent volume if you need to keep it).

---

## Integrate into vizuara.ai

### Option A: If vizuara.ai uses React

Copy these into your project:
```
src/services/AudioService.ts
src/services/LatencyTracker.ts
src/services/OpenAIRealtimeService.ts
src/services/VapiService.ts
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

### Option B: If vizuara.ai is NOT React (plain HTML, WordPress, etc.)

1. Build the widget:
   ```bash
   npm run build
   ```
2. Add to your HTML (before `</body>`):
   ```html
   <div id="vizuara-voice-widget"></div>
   <link rel="stylesheet" href="/path/to/voice-widget.css">
   <script type="module" src="/path/to/main.js"></script>
   ```

### In both cases: You need server.ts running

The widget needs `server.ts` for:
- WebSocket proxy to OpenAI (in OpenAI mode)
- Cost tracking (both modes)
- Budget enforcement (both modes)
- The `/admin/costs` dashboard

Deploy it alongside your existing backend, or as a separate service (e.g., on Railway).

---

## Customization

### Changing the AI's behavior
Edit `SYSTEM_INSTRUCTION` at the top of `src/VoiceWidget.tsx`.

### Updating the knowledge base
Edit `src/knowledge-base.txt`. Update whenever courses, pricing, or schedules change.

### Changing the voice (OpenAI mode)
Edit `VOICE_NAME` in `src/VoiceWidget.tsx`:
- `"Fenrir"` → ash (current — Indian male)
- `"Puck"` → alloy
- `"Charon"` → echo
- `"Kore"` → coral
- `"Zephyr"` → sage

### Changing the voice (VAPI mode)
Edit the Vikrant assistant in the VAPI dashboard at https://dashboard.vapi.ai.

### Changing colors
Edit `src/voice-widget.css`. Key values:
- `#c084fc` — purple (primary)
- `#f472b6` — pink (secondary)
- `#121212` — dark background
- `#ef4444` — red (end call)

---

## Deployment Checklist

- [ ] `.env.local` has all required keys for your chosen provider
- [ ] `VOICE_PROVIDER` is set to `openai` or `vapi`
- [ ] `MAX_CALL_DURATION_SECONDS` and `DAILY_BUDGET_USD` are set appropriately
- [ ] Server supports WebSocket connections (Railway, Render, Fly.io — **NOT** Vercel/Netlify)
- [ ] Widget CSS is loaded on the page
- [ ] `<div id="vizuara-voice-widget"></div>` exists in HTML (if not using React)
- [ ] Site is served over HTTPS (required for microphone access)
- [ ] Test a call end-to-end: click icon → allow mic → speak → hear response
- [ ] Verify cost dashboard at `/admin/costs`
- [ ] Verify call auto-ends at time limit

---

## Costs (OpenAI Realtime API)

OpenAI Realtime API pricing:
- **Audio input:** ~$0.06/min
- **Audio output:** ~$0.24/min
- **Combined:** ~$0.30/min of conversation
- **A typical 5-minute call:** ~$1.50

With the large knowledge base system prompt, actual costs may be slightly higher on the first turn due to text token processing.

VAPI costs depend on your VAPI plan and configuration (typically $0.05–$0.10/min).

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| "OPENAI_API_KEY not set" error | Make sure `.env.local` exists and has the key |
| "Daily budget exceeded" message | Budget has been hit. Wait until tomorrow, increase `DAILY_BUDGET_USD`, or switch to VAPI |
| Call cuts off abruptly | Check `MAX_CALL_DURATION_SECONDS` — the call auto-ends at this limit |
| WebSocket connection fails | Ensure your host supports WebSockets (not Vercel/Netlify) |
| No audio / mic not working | Must be HTTPS in production. Check browser mic permissions. |
| Widget doesn't appear | Ensure `#vizuara-voice-widget` div exists and JS bundle is loaded |
| VAPI mode not working | Verify `VAPI_API_KEY` and `VAPI_ASSISTANT_ID` are correct in `.env.local` |
| Cost dashboard shows $0 | Calls haven't been tracked yet. Make a test call first. |
