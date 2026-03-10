# Vizuara Voice Agent — API Reference

Base URL (production): `https://vizuara-voice-agent-production.up.railway.app`

---

## Table of Contents

1. [GET /api/health](#get-apihealth)
2. [GET /api/config](#get-apiconfig)
3. [GET /api/costs](#get-apicosts)
4. [GET /api/costs/today](#get-apicoststoday)
5. [POST /api/call-record](#post-apicall-record)
6. [GET /api/call-records](#get-apicall-records)
7. [GET /api/call-records/:id](#get-apicall-recordsid)
8. [POST /api/vapi/call-ended](#post-apivapicall-ended)
9. [WebSocket /ws/openai-realtime](#websocket-wsopenai-realtime)
10. [Admin Pages](#admin-pages)

---

## GET /api/health

Health check. Returns `200` when the server is up.

**Response**
```json
{ "status": "ok" }
```

**Usage:** Poll this to confirm the server is reachable before initializing the widget.

---

## GET /api/config

Returns the active server configuration and today's budget status. The `VoiceWidget` calls this on mount to decide whether to allow calls.

**Response**
```json
{
  "provider": "vapi",
  "maxCallDurationSeconds": 300,
  "warningBeforeEndSeconds": 30,
  "dailyBudgetUsd": 10.00,
  "dailyCostUsd": 3.42,
  "budgetExceeded": false,
  "vapiPublicKey": "pk_...",
  "vapiAssistantId": "asst_..."
}
```

| Field | Type | Notes |
|---|---|---|
| `provider` | `"vapi" \| "openai"` | Active voice provider |
| `maxCallDurationSeconds` | `number` | Hard cap per call |
| `warningBeforeEndSeconds` | `number` | Always `30` |
| `dailyBudgetUsd` | `number \| null` | `null` = unlimited |
| `dailyCostUsd` | `number` | Today's running cost |
| `budgetExceeded` | `boolean` | If `true`, block new calls |
| `vapiPublicKey` | `string \| undefined` | Only present when provider is `vapi` |
| `vapiAssistantId` | `string \| undefined` | Only present when provider is `vapi` |

**Display guidance:** Show a disabled/locked state on the call button when `budgetExceeded` is `true`. Optionally show a progress bar using `dailyCostUsd / dailyBudgetUsd`.

---

## GET /api/costs

Returns cost summaries for the last 30 days. Does **not** include per-session breakdowns.

**Response**
```json
{
  "2025-01-10": {
    "totalCostUsd": 1.2340,
    "totalDurationSeconds": 1050,
    "totalCalls": 7,
    "sessionCount": 7
  },
  "2025-01-11": { ... }
}
```

Keys are `YYYY-MM-DD` date strings, ordered ascending.

| Field | Type | Notes |
|---|---|---|
| `totalCostUsd` | `number` | Rounded to 4 decimal places |
| `totalDurationSeconds` | `number` | Sum of all call durations |
| `totalCalls` | `number` | Number of calls that day |
| `sessionCount` | `number` | Same as `totalCalls` |

**Display guidance:** Use as a time-series chart (line/bar) with date on the X-axis and cost or call count on Y. Sort keys with `Object.keys(data).sort()` to guarantee chronological order.

---

## GET /api/costs/today

Returns today's cost summary plus budget status. Lighter than `/api/costs` — use this for live dashboards.

**Response**
```json
{
  "date": "2025-01-11",
  "totalCostUsd": 3.42,
  "totalDurationSeconds": 2940,
  "totalCalls": 14,
  "dailyBudgetUsd": 10.00,
  "budgetExceeded": false
}
```

**Display guidance:** Good for a header widget showing live spend. Pair with auto-refresh every 60 seconds.

---

## POST /api/call-record

Submitted automatically by `VoiceWidget` when a call ends. Stores the full call record in Firestore and computes quality metrics.

**Request body**
```json
{
  "provider": "vapi",
  "durationSeconds": 145,
  "startTime": "2025-01-11T10:00:00.000Z",
  "vapiCallId": "vapi-call-abc123",
  "transcript": [
    { "text": "Hi, tell me about your AI courses", "isUser": true, "timestamp": "2025-01-11T10:00:05.000Z" },
    { "text": "Sure! Vizuara offers...", "isUser": false, "timestamp": "2025-01-11T10:00:08.000Z" }
  ],
  "feedback": {
    "rating": "positive",
    "reasons": ["helpful", "clear"],
    "comment": "Great demo!"
  }
}
```

`feedback` is optional — set to `null` or omit if the user skipped it.

**Response**
```json
{
  "id": "cr-1736591234567-ab1cd2",
  "qualityMetrics": {
    "engagement": 72,
    "topicCoverage": 85,
    "conversationFlow": 90,
    "composite": 81
  }
}
```

**Quality metrics explained:**

| Metric | Weight | How it's scored |
|---|---|---|
| `engagement` | 40% | User turn count, avg message length, back-and-forth presence |
| `topicCoverage` | 30% | Keyword matching against Vizuara course topics |
| `conversationFlow` | 30% | Alternation rate between user/AI turns |
| `composite` | — | Weighted average of all three (0–100) |

---

## GET /api/call-records

Returns all call records from the last 30 days. Transcripts are excluded; `turnCount` is included instead.

**Response** — array of records
```json
[
  {
    "id": "cr-1736591234567-ab1cd2",
    "provider": "vapi",
    "startTime": "2025-01-11T10:00:00.000Z",
    "endTime": "2025-01-11T10:02:25.000Z",
    "durationSeconds": 145,
    "turnCount": 12,
    "feedback": {
      "rating": "positive",
      "reasons": ["helpful"],
      "comment": "Great demo!"
    },
    "qualityMetrics": {
      "engagement": 72,
      "topicCoverage": 85,
      "conversationFlow": 90,
      "composite": 81
    },
    "vapiAnalytics": {
      "summary": "User asked about GenAI bootcamp pricing...",
      "successEvaluation": "Call was successful",
      "recordingUrl": "https://...",
      "vapiCost": 0.0170
    },
    "vapiCallId": "vapi-call-abc123"
  }
]
```

`vapiAnalytics` is `null` for OpenAI provider calls, or if VAPI hasn't returned analytics yet (fetched async up to 90 seconds after call ends).

`feedback` is `null` if the user skipped rating.

**Display guidance:**
- Sort by `endTime` descending for a "recent calls" table
- Color-code `qualityMetrics.composite`: green ≥70, amber ≥40, red <40
- Show 👍/👎 badge for `feedback.rating`; "—" if `feedback` is `null`

---

## GET /api/call-records/:id

Returns a single call record including the full transcript.

**URL param:** `id` — the record ID (e.g. `cr-1736591234567-ab1cd2`)

**Response**
```json
{
  "id": "cr-1736591234567-ab1cd2",
  "provider": "vapi",
  "startTime": "...",
  "endTime": "...",
  "durationSeconds": 145,
  "transcript": [
    { "text": "Hi, tell me about your AI courses", "isUser": true, "timestamp": "..." },
    { "text": "Sure! Vizuara offers...", "isUser": false, "timestamp": "..." }
  ],
  "feedback": { ... },
  "qualityMetrics": { ... },
  "vapiAnalytics": { ... },
  "vapiCallId": "vapi-call-abc123"
}
```

**Display guidance:** Render transcript as a chat bubble list — `isUser: true` on the right, `isUser: false` (AI) on the left. Use `timestamp` for time labels between messages.

---

## POST /api/vapi/call-ended

Called by the VAPI webhook (configured in the VAPI dashboard) to record cost for VAPI calls. Not called by the frontend directly.

**Request body**
```json
{
  "durationSeconds": 145,
  "assistantId": "asst_abc123"
}
```

**Response**
```json
{
  "recorded": true,
  "estimatedCostUsd": 0.0170
}
```

**Setup:** In the VAPI dashboard, add a server URL webhook pointing to `{BASE_URL}/api/vapi/call-ended`.

---

## WebSocket /ws/openai-realtime

Used only when `provider = "openai"`. Acts as a proxy to OpenAI's Realtime API, adding time-cap enforcement and cost tracking.

**Connect:** `wss://your-server/ws/openai-realtime?model=gpt-4o-realtime-preview`

**Allowed models:** `gpt-4o-realtime-preview`, `gpt-4o-mini-realtime-preview`

**Server-injected message types** (in addition to standard OpenAI events):

| Type | When | Fields |
|---|---|---|
| `proxy.connected` | Upstream connected | — |
| `proxy.time_warning` | 30s before limit | `remainingSeconds`, `maxDurationSeconds` |
| `proxy.time_exceeded` | Hard limit hit | `durationSeconds`, `maxDurationSeconds` |
| `proxy.error` | Budget exceeded or upstream error | `error` (string) |

**Display guidance:** Listen for `proxy.time_warning` to show a countdown timer in the UI. Listen for `proxy.time_exceeded` to cleanly end the call flow.

---

## Admin Pages

HTML dashboards served directly from the server. No JSON — not intended for programmatic use.

| URL | Description |
|---|---|
| `/admin/costs` | Cost dashboard: today's spend, daily history (30 days), active config |
| `/admin/feedback` | Feedback & quality dashboard: per-call table with transcripts, ratings, VAPI summaries |

These pages are not protected by authentication. Restrict access via Railway's network settings or add middleware if needed.
