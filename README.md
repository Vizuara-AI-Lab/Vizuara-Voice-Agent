# Vizuara Voice Agent Widget

A floating voice agent widget powered by VAPI (with OpenAI Realtime fallback). Drop it into any website to add a voice-based AI assistant. Includes post-call feedback collection, conversation quality scoring, and admin dashboards.

## Architecture

```
Browser (React widget)
  ↕ WebSocket (OpenAI mode) or VAPI Web SDK (VAPI mode)
Your Server (Express proxy + cost tracker)
  ↕ WebSocket
OpenAI Realtime API  — or —  VAPI (Vikrant agent)
```

The server acts as a proxy to keep the OpenAI API key secure. Audio streams bidirectionally in real-time (24kHz PCM16). When using VAPI, the browser connects directly to VAPI's servers.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Create .env.local with your keys
cp .env.example .env.local
# Edit .env.local — at minimum set OPENAI_API_KEY

# 3. Run in development
npm run dev
```

Open `http://localhost:5173` — you'll see a floating phone icon in the bottom-right corner.

## Production Deployment

```bash
npm run build
npm start
```

Deploy to Railway, Render, Fly.io, or any Node.js host that supports WebSockets.

## Dashboards

### Cost Dashboard
```
https://your-domain.com/admin/costs
```
Shows today's spend, call count, session details, budget usage, and 30-day history.

### Feedback & Quality Dashboard
```
https://your-domain.com/admin/feedback
```
Shows total calls, feedback rate, average quality score, positive feedback %, and a table of all call records with expandable transcripts.

## Switching Voice Providers

The widget supports two providers. Switch instantly via `.env.local`:

### VAPI (default)
```env
VOICE_PROVIDER=vapi
VAPI_API_KEY=your-vapi-public-key
VAPI_ASSISTANT_ID=your-assistant-id
```
Uses VAPI's hosted voice agent (Vikrant). Lower cost (~$0.07/min).

### OpenAI Realtime
```env
VOICE_PROVIDER=openai
```
Uses `gpt-4o-realtime-preview` with direct audio streaming. Higher quality, higher cost (~$0.30/min).

Restart the server after switching providers.

## Cost Controls

### Max Call Duration
```env
MAX_CALL_DURATION_SECONDS=300  # 5 minutes (default)
```
Calls auto-end when the limit is reached. Users see a warning 30 seconds before.

### Daily Budget
```env
DAILY_BUDGET_USD=5  # $5/day cap. Set to 0 for unlimited.
```
New calls are blocked when the budget is exceeded. Resets daily.

### Cost Rates
```env
COST_PER_MIN_REALTIME=0.30   # gpt-4o-realtime (~$0.06 input + $0.24 output per min)
COST_PER_MIN_MINI=0.05       # gpt-4o-mini-realtime
COST_PER_MIN_VAPI=0.07       # VAPI
```

## Post-Call Feedback & Quality Tracking

After every call, users see a feedback screen:
- **Thumbs up** — submits immediately with positive rating
- **Thumbs down** — shows selectable reason chips ("Not helpful", "Wrong info", "Too slow", "Hard to understand", "Didn't answer my question", "Other") + free-text comment
- **Skip (X)** — transcript is still saved, but no feedback recorded

Each call record includes:
- **Full transcript** with timestamps
- **User feedback** (rating, reasons, comment)
- **Quality score** (0-100) computed from engagement, topic coverage, and conversation flow
- **VAPI analytics** (VAPI calls only) — summary, success evaluation, recording URL, fetched automatically from the VAPI API

Quality scoring is rule-based (no LLM cost):
- **Engagement (40%)**: turn count, message length, back-and-forth interaction
- **Topic coverage (30%)**: course keyword matches in the transcript
- **Conversation flow (30%)**: alternation rate between user and AI turns

Data is stored in `data/call-records.json` on the server.

## Integration with an Existing Website

### Option A: Add to your React app
Copy these files into your project:
- `src/services/AudioService.ts`
- `src/services/LatencyTracker.ts`
- `src/services/OpenAIRealtimeService.ts`
- `src/services/VapiService.ts`
- `src/VoiceWidget.tsx`
- `src/voice-widget.css`

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

You'll still need `server.ts` running as a backend.

### Option B: Non-React site
```html
<div id="vizuara-voice-widget"></div>
<script type="module" src="/path/to/built/main.js"></script>
```

## File Structure

```
├── server.ts                          # Express + WS proxy + cost tracking + call records + quality scoring + dashboards
├── src/
│   ├── main.tsx                       # Entry point
│   ├── VoiceWidget.tsx                # Floating widget + post-call feedback UI
│   ├── voice-widget.css               # Self-contained widget styles (incl. feedback)
│   └── services/
│       ├── AudioService.ts            # Mic capture + audio playback (24kHz PCM16)
│       ├── LatencyTracker.ts          # Turn-by-turn latency metrics
│       ├── OpenAIRealtimeService.ts   # WebSocket client for OpenAI Realtime
│       └── VapiService.ts            # VAPI Web SDK wrapper + call ID capture
├── data/
│   ├── cost-tracker.json             # Auto-generated daily cost data (gitignored)
│   └── call-records.json             # Auto-generated call records with feedback (gitignored)
├── index.html
├── vite.config.ts
├── package.json
├── tsconfig.json
├── DEVELOPER-INSTRUCTIONS.md
└── .env.example
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | Yes (for OpenAI mode) | — | OpenAI API key with Realtime API access |
| `VOICE_PROVIDER` | No | `vapi` | `openai` or `vapi` |
| `MAX_CALL_DURATION_SECONDS` | No | `300` | Max call length in seconds |
| `DAILY_BUDGET_USD` | No | `0` | Daily spending cap ($0 = unlimited) |
| `COST_PER_MIN_REALTIME` | No | `0.30` | Estimated $/min for gpt-4o-realtime |
| `COST_PER_MIN_MINI` | No | `0.05` | Estimated $/min for gpt-4o-mini-realtime |
| `COST_PER_MIN_VAPI` | No | `0.07` | Estimated $/min for VAPI |
| `VAPI_API_KEY` | Yes (for VAPI mode) | — | VAPI public key |
| `VAPI_ASSISTANT_ID` | Yes (for VAPI mode) | — | VAPI assistant ID (e.g., Vikrant) |
| `VAPI_SERVER_API_KEY` | No | — | VAPI private key for fetching call analytics |
| `PORT` | No | `3000` | Server port |

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | Health check |
| `GET /api/config` | Returns current provider, limits, budget status |
| `GET /api/costs/today` | Today's cost, calls, duration, budget status |
| `GET /api/costs` | Last 30 days of daily cost summaries |
| `POST /api/vapi/call-ended` | Frontend reports VAPI call duration for tracking |
| `POST /api/call-record` | Submit call transcript + feedback, returns quality score |
| `GET /api/call-records` | Last 30 days of call records (without full transcripts) |
| `GET /api/call-records/:id` | Single call record with full transcript |
| `GET /admin/costs` | Cost dashboard (HTML) |
| `GET /admin/feedback` | Feedback & quality dashboard (HTML) |

## Features

- Real-time voice conversation (VAPI or OpenAI Realtime API)
- One-line provider switching (VAPI ↔ OpenAI)
- Post-call feedback UI (thumbs up/down, reason chips, free-text comment)
- Conversation quality scoring (engagement, topic coverage, conversation flow)
- VAPI analytics integration (call summary, success evaluation, recording URL)
- Feedback & quality admin dashboard
- Call time cap with warning banner and auto-end
- Daily budget enforcement
- Cost dashboard with session-level tracking
- Server-side VAD for natural turn-taking
- Interruption support
- Live transcript display
- Auto-detected course/product links
- Email draft detection with copy-to-clipboard
- Volume visualization and call timer
- Self-contained CSS (no Tailwind dependency)
