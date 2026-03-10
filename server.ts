import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createServer } from "http";
import path from "path";
import { WebSocket, WebSocketServer } from "ws";

dotenv.config({ path: ".env.local" });

const app = express();
const PORT = parseInt(process.env.PORT || "3000");

// --- Configuration ---
const VOICE_PROVIDER = (process.env.VOICE_PROVIDER || "vapi") as "openai" | "vapi";
const MAX_CALL_DURATION_SECONDS = parseInt(process.env.MAX_CALL_DURATION_SECONDS || "300"); // 5 min default
const DAILY_BUDGET_USD = parseFloat(process.env.DAILY_BUDGET_USD || "0"); // 0 = unlimited
const WARNING_BEFORE_END_SECONDS = 30;

// Cost per minute estimates (configurable via env)
const COST_RATES: Record<string, number> = {
  "gpt-4o-realtime-preview": parseFloat(process.env.COST_PER_MIN_REALTIME || "0.30"),
  "gpt-4o-mini-realtime-preview": parseFloat(process.env.COST_PER_MIN_MINI || "0.05"),
  vapi: parseFloat(process.env.COST_PER_MIN_VAPI || "0.07"),
};

const VAPI_SERVER_API_KEY = process.env.VAPI_SERVER_API_KEY || "";

// --- Firestore Init ---
if (!getApps().length) {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (serviceAccountJson) {
    initializeApp({ credential: cert(JSON.parse(serviceAccountJson)) });
  } else {
    // Falls back to GOOGLE_APPLICATION_CREDENTIALS or GCP default credentials
    initializeApp();
  }
}

const db = getFirestore();
const COST_DAYS_COL = "CostDays";
const CALL_RECORDS_COL = "CallRecords";

// --- Interfaces ---

interface CallSession {
  id: string;
  startTime: string;
  endTime: string | null;
  durationSeconds: number;
  model: string;
  provider: "openai" | "vapi";
  estimatedCostUsd: number;
}

interface DailyData {
  totalCostUsd: number;
  totalDurationSeconds: number;
  totalCalls: number;
  sessions: CallSession[];
}

interface TranscriptEntry {
  text: string;
  isUser: boolean;
  timestamp: string;
}

interface CallFeedback {
  rating: "positive" | "negative";
  reasons?: string[];
  comment?: string;
}

interface QualityMetrics {
  engagement: number;      // 0-100
  topicCoverage: number;   // 0-100
  conversationFlow: number; // 0-100
  composite: number;       // 0-100 weighted
}

interface VapiAnalytics {
  summary: string | null;
  successEvaluation: string | null;
  recordingUrl: string | null;
  vapiCost: number | null;
}

interface CallRecord {
  id: string;
  provider: "openai" | "vapi";
  startTime: string;
  endTime: string;
  durationSeconds: number;
  transcript: TranscriptEntry[];
  feedback: CallFeedback | null;
  qualityMetrics: QualityMetrics;
  vapiAnalytics: VapiAnalytics | null;
  vapiCallId: string | null;
}

// --- Firestore: Cost Storage ---

function getToday(): string {
  return new Date().toISOString().split("T")[0];
}

async function getTodayCost(): Promise<number> {
  const doc = await db.collection(COST_DAYS_COL).doc(getToday()).get();
  if (!doc.exists) return 0;
  return (doc.data() as DailyData).totalCostUsd || 0;
}

async function recordSession(session: CallSession): Promise<void> {
  const date = session.startTime.split("T")[0];
  const docRef = db.collection(COST_DAYS_COL).doc(date);

  await db.runTransaction(async (t) => {
    const doc = await t.get(docRef);
    const existing: DailyData = doc.exists
      ? (doc.data() as DailyData)
      : { totalCostUsd: 0, totalDurationSeconds: 0, totalCalls: 0, sessions: [] };

    existing.sessions.push(session);
    existing.totalCalls += 1;
    existing.totalDurationSeconds += session.durationSeconds;
    existing.totalCostUsd = Math.round((existing.totalCostUsd + session.estimatedCostUsd) * 10000) / 10000;

    t.set(docRef, existing);
  });

  console.log(
    `[CostTracker] Session recorded: ${session.durationSeconds}s, $${session.estimatedCostUsd.toFixed(4)} (${session.provider}/${session.model})`
  );
}

async function isDailyBudgetExceeded(): Promise<boolean> {
  if (DAILY_BUDGET_USD <= 0) return false;
  return (await getTodayCost()) >= DAILY_BUDGET_USD;
}

// --- Firestore: Call Records ---

async function addCallRecord(record: CallRecord): Promise<void> {
  await db.collection(CALL_RECORDS_COL).doc(record.id).set(record);
}

async function updateCallRecord(id: string, updates: Partial<CallRecord>): Promise<void> {
  await db.collection(CALL_RECORDS_COL).doc(id).update(updates as Record<string, unknown>);
}

// --- Quality Scoring (rule-based, no LLM) ---

const COURSE_KEYWORDS = [
  "ai", "machine learning", "deep learning", "reinforcement learning", "computer vision",
  "nlp", "natural language", "transformer", "llm", "gpu", "robot", "robotics",
  "bootcamp", "minor", "genai", "generative ai", "agents", "context engineering",
  "neural network", "pytorch", "tensorflow", "slm", "vizuara", "pod", "course",
  "curriculum", "training", "workshop", "certificate", "research",
];

function computeQualityMetrics(transcript: TranscriptEntry[]): QualityMetrics {
  if (transcript.length === 0) {
    return { engagement: 0, topicCoverage: 0, conversationFlow: 0, composite: 0 };
  }

  // --- Engagement (40%) ---
  const userTurns = transcript.filter((t) => t.isUser);
  const aiTurns = transcript.filter((t) => !t.isUser);
  const totalTurns = transcript.length;

  const turnScore = Math.min(100, (userTurns.length / 5) * 100);

  const avgUserLen = userTurns.length > 0
    ? userTurns.reduce((sum, t) => sum + t.text.length, 0) / userTurns.length
    : 0;
  const lengthScore = Math.min(100, (avgUserLen / 50) * 100);

  const backForthScore = userTurns.length > 0 && aiTurns.length > 0 ? 100 : 0;

  const engagement = Math.round((turnScore * 0.4 + lengthScore * 0.3 + backForthScore * 0.3));

  // --- Topic Coverage (30%) ---
  const allText = transcript.map((t) => t.text).join(" ").toLowerCase();
  const matchedKeywords = COURSE_KEYWORDS.filter((kw) => allText.includes(kw));
  const topicCoverage = Math.min(100, Math.round((matchedKeywords.length / 3) * 100));

  // --- Conversation Flow (30%) ---
  let alternations = 0;
  for (let i = 1; i < transcript.length; i++) {
    if (transcript[i].isUser !== transcript[i - 1].isUser) alternations++;
  }
  const alternationRate = totalTurns > 1 ? alternations / (totalTurns - 1) : 0;
  const conversationFlow = Math.round(alternationRate * 100);

  // --- Composite ---
  const composite = Math.round(engagement * 0.4 + topicCoverage * 0.3 + conversationFlow * 0.3);

  return { engagement, topicCoverage, conversationFlow, composite };
}

// --- VAPI Analytics Fetch (with retry) ---

async function fetchVapiAnalytics(vapiCallId: string, recordId: string) {
  if (!VAPI_SERVER_API_KEY || !vapiCallId) return;

  const delays = [10000, 30000, 60000]; // 10s, 30s, 60s

  for (const delay of delays) {
    await new Promise((resolve) => setTimeout(resolve, delay));

    try {
      const resp = await fetch(`https://api.vapi.ai/call/${vapiCallId}`, {
        headers: { Authorization: `Bearer ${VAPI_SERVER_API_KEY}` },
      });

      if (!resp.ok) {
        console.warn(`[VAPI Analytics] HTTP ${resp.status} for call ${vapiCallId}`);
        continue;
      }

      const data = await resp.json();
      const analysis = data.analysis || {};

      if (analysis.summary) {
        const analytics: VapiAnalytics = {
          summary: analysis.summary || null,
          successEvaluation: analysis.successEvaluation || null,
          recordingUrl: data.recordingUrl || null,
          vapiCost: data.cost != null ? data.cost : null,
        };

        await updateCallRecord(recordId, { vapiAnalytics: analytics });
        console.log(`[VAPI Analytics] Fetched analytics for call ${vapiCallId}`);
        return;
      }
    } catch (e) {
      console.warn(`[VAPI Analytics] Fetch error for ${vapiCallId}:`, e);
    }
  }

  console.warn(`[VAPI Analytics] Could not fetch analytics for ${vapiCallId} after retries`);
}

// --- CORS ---
app.use(cors({
  origin: process.env.CORS_ORIGIN || "*",
  methods: ["GET", "POST"],
}));

// --- Serve static files (production build) ---
app.use(express.static(path.join(import.meta.dirname, "dist")));
app.use(express.json());

// --- API Endpoints ---

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/config", async (_req, res) => {
  try {
    const [dailyCostUsd, budgetExceeded] = await Promise.all([
      getTodayCost(),
      isDailyBudgetExceeded(),
    ]);
    res.json({
      provider: VOICE_PROVIDER,
      maxCallDurationSeconds: MAX_CALL_DURATION_SECONDS,
      warningBeforeEndSeconds: WARNING_BEFORE_END_SECONDS,
      dailyBudgetUsd: DAILY_BUDGET_USD || null,
      dailyCostUsd,
      budgetExceeded,
      vapiPublicKey: VOICE_PROVIDER === "vapi" ? (process.env.VAPI_API_KEY || "") : undefined,
      vapiAssistantId: VOICE_PROVIDER === "vapi" ? (process.env.VAPI_ASSISTANT_ID || "") : undefined,
    });
  } catch (e) {
    console.error("[/api/config]", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/costs", async (_req, res) => {
  try {
    const snapshot = await db.collection(COST_DAYS_COL)
      .orderBy("__name__", "desc")
      .limit(30)
      .get();

    const result: Record<string, unknown> = {};
    for (const doc of snapshot.docs.reverse()) {
      const { sessions, ...summary } = doc.data() as DailyData;
      result[doc.id] = { ...summary, sessionCount: sessions.length };
    }
    res.json(result);
  } catch (e) {
    console.error("[/api/costs]", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/costs/today", async (_req, res) => {
  try {
    const today = getToday();
    const doc = await db.collection(COST_DAYS_COL).doc(today).get();
    const todayData = doc.exists
      ? (doc.data() as DailyData)
      : { totalCostUsd: 0, totalDurationSeconds: 0, totalCalls: 0 };

    res.json({
      date: today,
      totalCostUsd: todayData.totalCostUsd,
      totalDurationSeconds: todayData.totalDurationSeconds,
      totalCalls: todayData.totalCalls,
      dailyBudgetUsd: DAILY_BUDGET_USD || null,
      budgetExceeded: DAILY_BUDGET_USD > 0 && todayData.totalCostUsd >= DAILY_BUDGET_USD,
    });
  } catch (e) {
    console.error("[/api/costs/today]", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// --- Cost Dashboard (admin page) ---
app.get("/admin/costs", async (_req, res) => {
  try {
    const today = getToday();
    const snapshot = await db.collection(COST_DAYS_COL)
      .orderBy("__name__", "desc")
      .limit(30)
      .get();

    const days = snapshot.docs.map((d) => ({ id: d.id, ...(d.data() as DailyData) }));
    const todayData = days.find((d) => d.id === today) ||
      { id: today, totalCostUsd: 0, totalDurationSeconds: 0, totalCalls: 0, sessions: [] };

    const fmtDuration = (s: number) => {
      const m = Math.floor(s / 60);
      const sec = s % 60;
      return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
    };

    const dailyRows = days.map((d) => `<tr>
      <td>${d.id}${d.id === today ? " (today)" : ""}</td>
      <td>${d.totalCalls}</td>
      <td>${fmtDuration(d.totalDurationSeconds)}</td>
      <td>$${d.totalCostUsd.toFixed(4)}</td>
    </tr>`).join("\n");

    const sessionRows = todayData.sessions?.map((s: CallSession) => {
      const start = new Date(s.startTime).toLocaleTimeString();
      return `<tr>
        <td>${start}</td>
        <td>${s.provider}</td>
        <td>${s.model}</td>
        <td>${fmtDuration(s.durationSeconds)}</td>
        <td>$${s.estimatedCostUsd.toFixed(4)}</td>
      </tr>`;
    }).join("\n") || '<tr><td colspan="5" style="text-align:center;color:#888">No calls today</td></tr>';

    const totalAllTime = days.reduce((sum, d) => sum + (d.totalCostUsd || 0), 0);
    const budgetBar = DAILY_BUDGET_USD > 0
      ? `<div style="margin:16px 0">
          <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px">
            <span>Daily Budget</span>
            <span>$${todayData.totalCostUsd.toFixed(2)} / $${DAILY_BUDGET_USD.toFixed(2)}</span>
          </div>
          <div style="background:#333;border-radius:8px;height:12px;overflow:hidden">
            <div style="background:${todayData.totalCostUsd >= DAILY_BUDGET_USD ? '#ef4444' : '#4ade80'};height:100%;width:${Math.min(100, (todayData.totalCostUsd / DAILY_BUDGET_USD) * 100)}%;border-radius:8px;transition:width 0.3s"></div>
          </div>
         </div>`
      : '<p style="color:#888;font-size:13px">No daily budget set (unlimited)</p>';

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Voice Agent — Cost Dashboard</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family: "Inter", system-ui, sans-serif; background: #0a0a0a; color: #e5e5e5; padding: 32px; }
    h1 { font-size: 22px; margin-bottom: 8px; }
    h2 { font-size: 16px; color: #a3a3a3; margin: 24px 0 12px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 700; }
    .subtitle { color: #737373; font-size: 14px; margin-bottom: 24px; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card { background: #171717; border: 1px solid #262626; border-radius: 12px; padding: 16px; }
    .card .label { font-size: 11px; color: #737373; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 4px; }
    .card .value { font-size: 24px; font-weight: 700; }
    .card .value.green { color: #4ade80; }
    .card .value.amber { color: #f59e0b; }
    .card .value.purple { color: #c084fc; }
    table { width: 100%; border-collapse: collapse; background: #171717; border: 1px solid #262626; border-radius: 12px; overflow: hidden; }
    th { text-align: left; padding: 10px 16px; font-size: 11px; color: #737373; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #262626; background: #1a1a1a; }
    td { padding: 10px 16px; font-size: 13px; border-bottom: 1px solid #1f1f1f; }
    tr:last-child td { border-bottom: none; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 600; }
    .badge.openai { background: rgba(16,185,129,0.15); color: #34d399; }
    .badge.vapi { background: rgba(192,132,252,0.15); color: #c084fc; }
    .config-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 12px; }
    .config-item { background: #171717; border: 1px solid #262626; border-radius: 8px; padding: 12px 16px; font-size: 13px; }
    .config-item .key { color: #737373; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
    .config-item .val { margin-top: 2px; font-weight: 600; }
    .refresh-note { color: #525252; font-size: 12px; margin-top: 24px; text-align: center; }
  </style>
</head>
<body>
  <h1>Voice Agent Cost Dashboard</h1>
  <p class="subtitle">Vizuara AI Labs — Real-time cost tracking</p>

  <div class="cards">
    <div class="card">
      <div class="label">Today's Cost</div>
      <div class="value amber">$${todayData.totalCostUsd.toFixed(2)}</div>
    </div>
    <div class="card">
      <div class="label">Today's Calls</div>
      <div class="value">${todayData.totalCalls}</div>
    </div>
    <div class="card">
      <div class="label">Today's Duration</div>
      <div class="value">${fmtDuration(todayData.totalDurationSeconds)}</div>
    </div>
    <div class="card">
      <div class="label">All-Time Tracked</div>
      <div class="value purple">$${totalAllTime.toFixed(2)}</div>
    </div>
  </div>

  ${budgetBar}

  <h2>Current Configuration</h2>
  <div class="config-grid">
    <div class="config-item">
      <div class="key">Voice Provider</div>
      <div class="val"><span class="badge ${VOICE_PROVIDER}">${VOICE_PROVIDER.toUpperCase()}</span></div>
    </div>
    <div class="config-item">
      <div class="key">Max Call Duration</div>
      <div class="val">${fmtDuration(MAX_CALL_DURATION_SECONDS)}</div>
    </div>
    <div class="config-item">
      <div class="key">Daily Budget</div>
      <div class="val">${DAILY_BUDGET_USD > 0 ? "$" + DAILY_BUDGET_USD.toFixed(2) : "Unlimited"}</div>
    </div>
    <div class="config-item">
      <div class="key">Cost Rate (per min)</div>
      <div class="val">$${(COST_RATES[VOICE_PROVIDER === "vapi" ? "vapi" : "gpt-4o-realtime-preview"] || 0).toFixed(2)}</div>
    </div>
  </div>

  <h2>Today's Sessions</h2>
  <table>
    <thead><tr><th>Time</th><th>Provider</th><th>Model</th><th>Duration</th><th>Est. Cost</th></tr></thead>
    <tbody>${sessionRows}</tbody>
  </table>

  <h2>Daily History (Last 30 Days)</h2>
  <table>
    <thead><tr><th>Date</th><th>Calls</th><th>Total Duration</th><th>Est. Cost</th></tr></thead>
    <tbody>${dailyRows || '<tr><td colspan="4" style="text-align:center;color:#888">No data yet</td></tr>'}</tbody>
  </table>

  <p class="refresh-note">Refresh the page to update. Data stored in Firestore.</p>
</body>
</html>`);
  } catch (e) {
    console.error("[/admin/costs]", e);
    res.status(500).send("Internal server error");
  }
});

// --- Call Record Endpoints ---

app.post("/api/call-record", async (req, res) => {
  try {
    const { transcript, feedback, provider, durationSeconds, vapiCallId, startTime } = req.body || {};

    if (!Array.isArray(transcript)) {
      return res.status(400).json({ error: "transcript array required" });
    }

    const recordId = `cr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const endTime = new Date().toISOString();
    const prov = provider === "vapi" ? "vapi" : "openai";

    const transcriptEntries: TranscriptEntry[] = transcript.map((t: any) => ({
      text: String(t.text || ""),
      isUser: Boolean(t.isUser),
      timestamp: t.timestamp || endTime,
    }));

    const qualityMetrics = computeQualityMetrics(transcriptEntries);

    const record: CallRecord = {
      id: recordId,
      provider: prov,
      startTime: startTime || new Date(Date.now() - (durationSeconds || 0) * 1000).toISOString(),
      endTime,
      durationSeconds: durationSeconds || 0,
      transcript: transcriptEntries,
      feedback: feedback ? {
        rating: feedback.rating === "negative" ? "negative" : "positive",
        reasons: Array.isArray(feedback.reasons) ? feedback.reasons : undefined,
        comment: typeof feedback.comment === "string" && feedback.comment.trim() ? feedback.comment.trim() : undefined,
      } : null,
      qualityMetrics,
      vapiAnalytics: null,
      vapiCallId: vapiCallId || null,
    };

    await addCallRecord(record);
    console.log(`[CallRecord] Saved ${recordId}: ${prov}, ${transcriptEntries.length} turns, quality=${qualityMetrics.composite}`);

    // Fetch VAPI analytics in background if applicable
    if (prov === "vapi" && vapiCallId && VAPI_SERVER_API_KEY) {
      fetchVapiAnalytics(vapiCallId, recordId).catch((e) =>
        console.error("[VAPI Analytics] Background fetch failed:", e)
      );
    }

    res.json({ id: recordId, qualityMetrics });
  } catch (e) {
    console.error("[/api/call-record]", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/call-records", async (_req, res) => {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const snapshot = await db.collection(CALL_RECORDS_COL)
      .where("endTime", ">=", thirtyDaysAgo)
      .orderBy("endTime", "asc")
      .get();

    const records = snapshot.docs.map((d) => {
      const { transcript, ...rest } = d.data() as CallRecord;
      return { ...rest, turnCount: transcript.length };
    });

    res.json(records);
  } catch (e) {
    console.error("[/api/call-records]", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/call-records/:id", async (req, res) => {
  try {
    const doc = await db.collection(CALL_RECORDS_COL).doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: "Record not found" });
    res.json(doc.data());
  } catch (e) {
    console.error("[/api/call-records/:id]", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// --- Feedback Dashboard ---
app.get("/admin/feedback", async (_req, res) => {
  try {
    const allSnapshot = await db.collection(CALL_RECORDS_COL)
      .orderBy("endTime", "asc")
      .get();
    const allRecords = allSnapshot.docs.map((d) => d.data() as CallRecord);
    const recent = allRecords.slice(-100).reverse();

    const totalCalls = allRecords.length;
    const withFeedback = allRecords.filter((r) => r.feedback !== null);
    const feedbackRate = totalCalls > 0 ? Math.round((withFeedback.length / totalCalls) * 100) : 0;
    const avgQuality = totalCalls > 0
      ? Math.round(allRecords.reduce((sum, r) => sum + r.qualityMetrics.composite, 0) / totalCalls)
      : 0;
    const positiveCount = withFeedback.filter((r) => r.feedback?.rating === "positive").length;
    const positiveRate = withFeedback.length > 0 ? Math.round((positiveCount / withFeedback.length) * 100) : 0;

    const fmtDuration = (s: number) => {
      const m = Math.floor(s / 60);
      const sec = s % 60;
      return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
    };

    const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const tableRows = recent.map((r) => {
      const date = new Date(r.endTime).toLocaleString();
      const ratingBadge = r.feedback
        ? r.feedback.rating === "positive"
          ? '<span class="badge positive">&#128077;</span>'
          : '<span class="badge negative">&#128078;</span>'
        : '<span class="badge skipped">—</span>';
      const reasons = r.feedback?.reasons?.join(", ") || "";
      const vapiSummary = r.vapiAnalytics?.summary || "";
      const qualityColor = r.qualityMetrics.composite >= 70 ? "#4ade80" : r.qualityMetrics.composite >= 40 ? "#f59e0b" : "#f87171";

      const transcriptHtml = r.transcript.map((t) =>
        `<p style="margin:4px 0;font-size:12px"><strong style="color:${t.isUser ? "#f472b6" : "#c084fc"}">${t.isUser ? "User" : "AI"}:</strong> ${escapeHtml(t.text)}</p>`
      ).join("");

      return `<tr>
        <td>${date}</td>
        <td><span class="badge ${r.provider}">${r.provider.toUpperCase()}</span></td>
        <td>${fmtDuration(r.durationSeconds)}</td>
        <td style="color:${qualityColor};font-weight:700">${r.qualityMetrics.composite}</td>
        <td>${ratingBadge}</td>
        <td style="font-size:12px;color:#a3a3a3">${escapeHtml(reasons)}</td>
        <td style="font-size:12px;color:#a3a3a3;max-width:300px">${escapeHtml(vapiSummary)}</td>
        <td>
          <details><summary style="cursor:pointer;color:#c084fc;font-size:11px">View</summary>
            <div style="max-height:200px;overflow-y:auto;padding:8px;background:#0a0a0a;border-radius:6px;margin-top:4px">${transcriptHtml}</div>
          </details>
        </td>
      </tr>`;
    }).join("\n");

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Voice Agent — Feedback Dashboard</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family: "Inter", system-ui, sans-serif; background: #0a0a0a; color: #e5e5e5; padding: 32px; }
    h1 { font-size: 22px; margin-bottom: 8px; }
    .subtitle { color: #737373; font-size: 14px; margin-bottom: 24px; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 32px; }
    .card { background: #171717; border: 1px solid #262626; border-radius: 12px; padding: 16px; }
    .card .label { font-size: 11px; color: #737373; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 4px; }
    .card .value { font-size: 24px; font-weight: 700; }
    .card .value.green { color: #4ade80; }
    .card .value.amber { color: #f59e0b; }
    .card .value.purple { color: #c084fc; }
    .card .value.pink { color: #f472b6; }
    table { width: 100%; border-collapse: collapse; background: #171717; border: 1px solid #262626; border-radius: 12px; overflow: hidden; }
    th { text-align: left; padding: 10px 12px; font-size: 11px; color: #737373; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #262626; background: #1a1a1a; }
    td { padding: 10px 12px; font-size: 13px; border-bottom: 1px solid #1f1f1f; vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 600; }
    .badge.openai { background: rgba(16,185,129,0.15); color: #34d399; }
    .badge.vapi { background: rgba(192,132,252,0.15); color: #c084fc; }
    .badge.positive { background: rgba(74,222,128,0.15); color: #4ade80; }
    .badge.negative { background: rgba(248,113,113,0.15); color: #f87171; }
    .badge.skipped { background: rgba(82,82,82,0.3); color: #737373; }
    .nav { margin-bottom: 24px; }
    .nav a { color: #c084fc; font-size: 13px; text-decoration: none; margin-right: 16px; }
    .nav a:hover { text-decoration: underline; }
    .refresh-note { color: #525252; font-size: 12px; margin-top: 24px; text-align: center; }
  </style>
</head>
<body>
  <div class="nav"><a href="/admin/costs">Cost Dashboard</a> <a href="/admin/feedback">Feedback Dashboard</a></div>
  <h1>Feedback &amp; Quality Dashboard</h1>
  <p class="subtitle">Vizuara AI Labs — Conversation quality tracking</p>

  <div class="cards">
    <div class="card">
      <div class="label">Total Calls</div>
      <div class="value purple">${totalCalls}</div>
    </div>
    <div class="card">
      <div class="label">Feedback Rate</div>
      <div class="value amber">${feedbackRate}%</div>
    </div>
    <div class="card">
      <div class="label">Avg Quality Score</div>
      <div class="value green">${avgQuality}</div>
    </div>
    <div class="card">
      <div class="label">Positive Feedback</div>
      <div class="value pink">${positiveRate}%</div>
    </div>
  </div>

  <table>
    <thead>
      <tr><th>Date</th><th>Provider</th><th>Duration</th><th>Quality</th><th>Rating</th><th>Reasons</th><th>VAPI Summary</th><th>Transcript</th></tr>
    </thead>
    <tbody>${tableRows || '<tr><td colspan="8" style="text-align:center;color:#888">No call records yet</td></tr>'}</tbody>
  </table>

  <p class="refresh-note">Refresh to update. Data stored in Firestore.</p>
</body>
</html>`);
  } catch (e) {
    console.error("[/admin/feedback]", e);
    res.status(500).send("Internal server error");
  }
});

// --- SPA fallback ---
app.get("*", (_req, res) => {
  res.sendFile(path.join(import.meta.dirname, "dist", "index.html"));
});

// --- HTTP Server + WebSocket ---
const httpServer = createServer(app);
const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url!, `http://${request.headers.host}`).pathname;

  if (pathname === "/ws/openai-realtime") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  }
});

// --- OpenAI Realtime Proxy (with cost tracking + time cap) ---
wss.on("connection", async (clientWs, req) => {
  // Check daily budget before allowing connection
  if (await isDailyBudgetExceeded()) {
    clientWs.send(
      JSON.stringify({
        type: "proxy.error",
        error: "Daily budget exceeded. Please try again tomorrow or switch to VAPI.",
      })
    );
    clientWs.close();
    return;
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    clientWs.send(
      JSON.stringify({ type: "proxy.error", error: "OPENAI_API_KEY not set on server" })
    );
    clientWs.close();
    return;
  }

  console.log("[OpenAI Proxy] Client connected, opening upstream...");

  const clientUrl = new URL(req.url!, `http://${req.headers.host}`);
  const requestedModel = clientUrl.searchParams.get("model") || "gpt-4o-realtime-preview";
  const allowedModels = ["gpt-4o-realtime-preview", "gpt-4o-mini-realtime-preview"];
  const model = allowedModels.includes(requestedModel)
    ? requestedModel
    : "gpt-4o-realtime-preview";

  const upstreamUrl = `wss://api.openai.com/v1/realtime?model=${model}`;
  console.log(`[OpenAI Proxy] Using model: ${model}`);

  // Session tracking
  const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sessionStartTime = new Date();
  let sessionEnded = false;

  const upstream = new WebSocket(upstreamUrl, {
    headers: {
      Authorization: `Bearer ${openaiKey}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  // --- Time cap enforcement ---
  const maxDurationTimer = setTimeout(() => {
    console.log(`[OpenAI Proxy] Max call duration (${MAX_CALL_DURATION_SECONDS}s) reached. Closing session ${sessionId}.`);
    endSession("time_limit");
  }, MAX_CALL_DURATION_SECONDS * 1000);

  const warningTimer = setTimeout(() => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(
        JSON.stringify({
          type: "proxy.time_warning",
          remainingSeconds: WARNING_BEFORE_END_SECONDS,
          maxDurationSeconds: MAX_CALL_DURATION_SECONDS,
        })
      );
    }
  }, (MAX_CALL_DURATION_SECONDS - WARNING_BEFORE_END_SECONDS) * 1000);

  async function endSession(reason: string) {
    if (sessionEnded) return;
    sessionEnded = true;

    clearTimeout(maxDurationTimer);
    clearTimeout(warningTimer);

    const endTime = new Date();
    const durationSeconds = Math.round((endTime.getTime() - sessionStartTime.getTime()) / 1000);
    const costPerMin = COST_RATES[model] || 0.15;
    const estimatedCostUsd = Math.round((durationSeconds / 60) * costPerMin * 10000) / 10000;

    await recordSession({
      id: sessionId,
      startTime: sessionStartTime.toISOString(),
      endTime: endTime.toISOString(),
      durationSeconds,
      model,
      provider: "openai",
      estimatedCostUsd,
    });

    console.log(`[OpenAI Proxy] Session ${sessionId} ended (${reason}): ${durationSeconds}s, ~$${estimatedCostUsd.toFixed(4)}`);

    if (reason === "time_limit" && clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(
        JSON.stringify({
          type: "proxy.time_exceeded",
          durationSeconds,
          maxDurationSeconds: MAX_CALL_DURATION_SECONDS,
        })
      );
    }

    if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close();
  }

  upstream.on("open", () => {
    console.log("[OpenAI Proxy] Upstream connected");
    clientWs.send(JSON.stringify({ type: "proxy.connected" }));
  });

  upstream.on("message", (data) => {
    const str = data.toString();
    try {
      const parsed = JSON.parse(str);
      if (
        ["session.created", "session.updated", "error", "response.done"].includes(parsed.type)
      ) {
        console.log(
          `[OpenAI Proxy] Upstream >> ${parsed.type}`,
          parsed.type === "error" ? parsed.error : ""
        );
      }
    } catch {}
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(str);
    }
  });

  upstream.on("close", (code, reason) => {
    console.log(`[OpenAI Proxy] Upstream closed: ${code} ${reason}`);
    endSession("upstream_closed").catch(console.error);
  });

  upstream.on("error", (err) => {
    console.error("[OpenAI Proxy] Upstream error:", err.message);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ type: "proxy.error", error: err.message }));
    }
    endSession("upstream_error").catch(console.error);
  });

  clientWs.on("message", (data) => {
    const str = data.toString();
    try {
      const parsed = JSON.parse(str);
      if (parsed.type === "session.update") {
        console.log(
          `[OpenAI Proxy] Client >> session.update modalities=${JSON.stringify(parsed.session?.modalities)}`
        );
      }
    } catch {}
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(str);
    }
  });

  clientWs.on("close", () => {
    console.log("[OpenAI Proxy] Client disconnected");
    endSession("client_disconnected").catch(console.error);
  });
});

// --- VAPI call cost tracking endpoint ---
app.post("/api/vapi/call-ended", async (req, res) => {
  try {
    const { durationSeconds, assistantId } = req.body || {};
    if (typeof durationSeconds !== "number" || durationSeconds <= 0) {
      return res.status(400).json({ error: "Invalid durationSeconds" });
    }

    const costPerMin = COST_RATES.vapi || 0.07;
    const estimatedCostUsd = Math.round((durationSeconds / 60) * costPerMin * 10000) / 10000;

    await recordSession({
      id: `vapi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      startTime: new Date(Date.now() - durationSeconds * 1000).toISOString(),
      endTime: new Date().toISOString(),
      durationSeconds,
      model: assistantId || "vapi-assistant",
      provider: "vapi",
      estimatedCostUsd,
    });

    res.json({ recorded: true, estimatedCostUsd });
  } catch (e) {
    console.error("[/api/vapi/call-ended]", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

httpServer.listen(PORT, () => {
  console.log(`\n  Voice Agent server running on http://localhost:${PORT}`);
  console.log(`  Provider: ${VOICE_PROVIDER}`);
  console.log(`  Max call duration: ${MAX_CALL_DURATION_SECONDS}s`);
  if (DAILY_BUDGET_USD > 0) {
    console.log(`  Daily budget: $${DAILY_BUDGET_USD}`);
  }
  console.log();
});
