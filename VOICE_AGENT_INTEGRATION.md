# Integration Analysis: Vizuara-Voice-Agent → Vizuara-AI-Labs

### What the instructions say to do (Option A — React)

Copy 8 files into the React app and add `<VoiceWidget />` to `App.tsx`. Simple on paper.

---

### The Real Challenges

#### 1. `server.ts` Cannot Become a Cloud Function — This is the Big One

`server.ts` is a long-running Express + WebSocket server. Cloud Functions are stateless, HTTP-triggered, and killed after a request completes. They fundamentally cannot:

- Maintain a persistent WebSocket connection (OpenAI Realtime streams audio for minutes)
- Write to local JSON files (`data/cost-tracker.json`, `data/call-records.json`)
- Enforce time caps mid-call (the function would already be dead)

**Your options for hosting `server.ts`:**

| Option | Cost | Effort | Notes |
|--------|------|--------|-------|
| **Railway / Render / Fly.io** | ~$5–10/mo | Low | Just deploy it as-is, set env vars. Recommended. |
| **Google Cloud Run** | Pay-per-use | Medium | Works well, supports WebSockets, same Google ecosystem as Firebase |
| **Firebase Cloud Functions (HTTPS callable)** | ❌ Not viable | — | Can't hold WebSocket connections; 9-minute hard timeout |

**Bottom line:** You'll be running two backends — Firebase Cloud Functions for the AI Labs app, and a separate always-on server for the Voice Agent.

---

#### 2. The Widget Needs to Know Where the Server Is

Currently the widget calls `/api/config`, `/ws/openai-realtime`, `/api/call-record`, etc. — relative URLs. Once you embed it in AI Labs (served from Firebase Hosting), those relative URLs will hit Firebase Hosting, not your Voice Agent server.

You'll need to update `VoiceWidget.tsx` and `OpenAIRealtimeService.ts` to use absolute URLs like `https://voice-agent.yourdomain.com/api/...` and `wss://voice-agent.yourdomain.com/ws/openai-realtime`.

**CORS headers** will also need to be added to `server.ts` since the widget will be making cross-origin requests from `app.vizuara.com` to `voice-agent.vizuara.com`.

---

#### 3. File-Based Storage Won't Survive Redeploys

`cost-tracker.json` and `call-records.json` live on the server's disk. If Railway/Render restarts the container, that data is gone. You either need:
- A persistent volume (Railway/Render both support this, but it's manual setup)
- Or migrate the storage to Firestore (more work, but fits the existing stack)

---

#### 4. No Authentication

The Voice Agent currently has zero auth — anyone who can reach the server can make calls and rack up costs. Once it's publicly embedded in the AI Labs site, the budget control is your only guard. You'll want to either:
- Add Firebase Auth token validation to `server.ts` (verify the user's ID token before allowing a WebSocket connection)
- Or at minimum, rely heavily on the `DAILY_BUDGET_USD` env var

---

#### 5. New npm Dependency: `@vapi-ai/web`

The Voice Agent uses `@vapi-ai/web`. This needs to be installed in the AI Labs project (`npm install @vapi-ai/web`). This is straightforward but worth noting.

---

#### 6. The `vite-env.d.ts` File

The instructions say to copy `src/vite-env.d.ts`. The AI Labs project already has one — don't overwrite it. Merge any type declarations manually.

---

#### 7. CSS Isolation — Not a Problem (Actually Well Done)

Every CSS class in `voice-widget.css` is prefixed with `voice-widget-`. No conflicts with existing Tailwind or custom styles. This part just works.

---

### Recommended Integration Path

1. **Deploy `server.ts` separately** on Railway or Google Cloud Run. This is the path of least resistance.
2. **Set CORS** on `server.ts` to allow requests from your AI Labs domain.
3. **Update the API base URLs** in `VoiceWidget.tsx` and `OpenAIRealtimeService.ts` to point to the deployed server.
4. **Copy the 8 source files** into AI Labs and add `<VoiceWidget />` to `App.tsx`.
5. **Install `@vapi-ai/web`** in the AI Labs project.
6. **Add a persistent volume** on your server host so call records survive restarts.

### If You Want Full Firebase Integration (More Work)

Replace the file-based storage in `server.ts` with Firestore writes, add Firebase Auth token checks at the WebSocket handshake, and move budget enforcement into a Cloud Function. The WebSocket proxy for OpenAI still cannot be a Cloud Function — you'd keep that part on Cloud Run.
