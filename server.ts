import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import fs from "fs";
import { createServer } from "http";
import path from "path";
import { WebSocket, WebSocketServer } from "ws";
import { fetchYouTubeTranscript, generateCourseSection, scrapeWebsite } from "./server/courseGenerator.js";

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

// --- Knowledge Base & Course Links Paths ---
const KNOWLEDGE_BASE_PATH = path.join(import.meta.dirname, "src", "knowledge-base.txt");
const COURSE_LINKS_PATH = path.join(import.meta.dirname, "src", "course-links.json");

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
      const start = new Date(s.startTime).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" });
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
    .nav { margin-bottom: 24px; }
    .nav a { color: #c084fc; font-size: 13px; text-decoration: none; margin-right: 16px; }
    .nav a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="nav"><a href="/admin/costs">Cost Dashboard</a> <a href="/admin/feedback">Feedback Dashboard</a> <a href="/admin/add-course">Add Course</a></div>
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
        ...(Array.isArray(feedback.reasons) && feedback.reasons.length > 0 ? { reasons: feedback.reasons } : {}),
        ...(typeof feedback.comment === "string" && feedback.comment.trim() ? { comment: feedback.comment.trim() } : {}),
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

app.patch("/api/call-record/:id/feedback", async (req, res) => {
  try {
    const { id } = req.params;
    const { rating, reasons, comment } = req.body || {};

    if (!rating || (rating !== "positive" && rating !== "negative")) {
      return res.status(400).json({ error: "rating must be 'positive' or 'negative'" });
    }

    const feedback: CallFeedback = {
      rating,
      ...(Array.isArray(reasons) && reasons.length > 0 ? { reasons } : {}),
      ...(typeof comment === "string" && comment.trim() ? { comment: comment.trim() } : {}),
    };

    await updateCallRecord(id, { feedback });
    res.json({ ok: true });
  } catch (e) {
    console.error("[/api/call-record/:id/feedback]", e);
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
      const date = new Date(r.endTime).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
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
  <div class="nav"><a href="/admin/costs">Cost Dashboard</a> <a href="/admin/feedback">Feedback Dashboard</a> <a href="/admin/add-course">Add Course</a></div>
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

// --- Course Generator API Endpoints ---

// POST /api/youtube/transcript — extract captions from a YouTube video
app.post("/api/youtube/transcript", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "url is required" });
    const result = await fetchYouTubeTranscript(url);
    res.json(result);
  } catch (err: any) {
    console.error("[Course] Transcript error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/website/scrape — scrape a website URL for course info
app.post("/api/website/scrape", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "url is required" });
    const content = await scrapeWebsite(url);
    res.json({ content, charCount: content.length });
  } catch (err: any) {
    console.error("[Scrape] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/knowledge-base/generate-section — LLM generates a structured KB section
app.post("/api/knowledge-base/generate-section", async (req, res) => {
  try {
    const { transcript, metadata, websiteContent } = req.body;
    if (!metadata) {
      return res.status(400).json({ error: "metadata is required" });
    }
    if (!transcript && !websiteContent) {
      return res.status(400).json({ error: "at least one of transcript or websiteContent is required" });
    }
    const existingKB = fs.existsSync(KNOWLEDGE_BASE_PATH)
      ? fs.readFileSync(KNOWLEDGE_BASE_PATH, "utf-8") : "";
    const section = await generateCourseSection(transcript, metadata, existingKB, websiteContent || "");
    res.json({ section });
  } catch (err: any) {
    console.error("[Course] Generate error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/course-links — return all course links (used by widget for suggested links)
app.get("/api/course-links", (_req, res) => {
  try {
    const links = fs.existsSync(COURSE_LINKS_PATH)
      ? JSON.parse(fs.readFileSync(COURSE_LINKS_PATH, "utf-8"))
      : [];
    res.json(links);
  } catch (err: any) {
    console.error("[CourseLinks] Read error:", err.message);
    res.json([]);
  }
});

// POST /api/knowledge-base/append — append a section to knowledge-base.txt
app.post("/api/knowledge-base/append", async (req, res) => {
  try {
    const { section, syncToVapi, courseLink } = req.body;
    if (!section) return res.status(400).json({ error: "section is required" });

    const existingKB = fs.existsSync(KNOWLEDGE_BASE_PATH)
      ? fs.readFileSync(KNOWLEDGE_BASE_PATH, "utf-8") : "";
    const separator = existingKB.trim() ? "\n\n---\n\n" : "";
    const updatedKB = existingKB.trim() + separator + section.trim() + "\n";
    fs.writeFileSync(KNOWLEDGE_BASE_PATH, updatedKB);
    console.log(`[Course] Appended ${section.length} chars to KB (total: ${updatedKB.length})`);

    // Auto-register suggested link if courseLink provided
    let linkAdded = false;
    if (courseLink?.name && courseLink?.url && courseLink?.keywords?.length) {
      try {
        const links = fs.existsSync(COURSE_LINKS_PATH)
          ? JSON.parse(fs.readFileSync(COURSE_LINKS_PATH, "utf-8"))
          : [];
        const exists = links.some((l: any) => l.url === courseLink.url);
        if (!exists) {
          links.push({ name: courseLink.name, url: courseLink.url, keywords: courseLink.keywords });
          fs.writeFileSync(COURSE_LINKS_PATH, JSON.stringify(links, null, 2) + "\n");
          linkAdded = true;
          console.log(`[Course] Added suggested link: ${courseLink.name} → ${courseLink.url}`);
        }
      } catch (e: any) {
        console.warn("[Course] Failed to add suggested link:", e.message);
      }
    }

    let synced = false;
    if (syncToVapi) {
      const vapiKey = process.env.VAPI_SERVER_API_KEY;
      const assistantId = process.env.VAPI_ASSISTANT_ID;
      if (vapiKey && assistantId) {
        const vapiRes = await fetch(`https://api.vapi.ai/assistant/${assistantId}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${vapiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: {
              model: "gpt-4o-mini",
              provider: "openai",
              messages: [{ role: "system", content: updatedKB }],
            },
          }),
        });
        if (vapiRes.ok) {
          synced = true;
          console.log(`[Course] Synced to VAPI — ${updatedKB.length} chars`);
        } else {
          console.warn(`[Course] VAPI sync failed: ${vapiRes.status}`);
        }
      }
    }

    res.json({ success: true, totalKBChars: updatedKB.length, synced, linkAdded });
  } catch (err: any) {
    console.error("[Course] Append error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Admin: Add Course page ---
app.get("/admin/add-course", (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Add Course — Vizuara Voice Agent</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0a0a0f; color: #e0e0e0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    .nav { background: #111118; border-bottom: 1px solid #2a2a35; padding: 12px 24px; display: flex; align-items: center; gap: 24px; }
    .nav-brand { font-weight: 700; font-size: 16px; color: #c084fc; }
    .nav a { color: #888; text-decoration: none; font-size: 14px; transition: color .2s; }
    .nav a:hover, .nav a.active { color: #e0e0e0; }
    .container { max-width: 900px; margin: 0 auto; padding: 24px; }
    h1 { font-size: 24px; margin-bottom: 8px; }
    .subtitle { color: #888; font-size: 14px; margin-bottom: 24px; }
    .step { display: none; }
    .step.active { display: block; }
    .step-header { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
    .step-number { width: 32px; height: 32px; border-radius: 50%; background: #2a2a35; color: #888; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 14px; }
    .step-number.done { background: #065f46; color: #6ee7b7; }
    .step-number.current { background: #c084fc; color: #fff; }
    .step-title { font-size: 18px; font-weight: 600; }
    .stepper { display: flex; gap: 8px; margin-bottom: 32px; }
    .stepper-dot { flex: 1; height: 4px; border-radius: 2px; background: #2a2a35; transition: background .3s; }
    .stepper-dot.done { background: #065f46; }
    .stepper-dot.current { background: #c084fc; }
    .card { background: #111118; border: 1px solid #2a2a35; border-radius: 12px; padding: 20px; margin-bottom: 16px; }
    label { display: block; font-size: 13px; color: #888; margin-bottom: 4px; font-weight: 500; }
    input[type="text"], input[type="number"], select, textarea {
      width: 100%; background: #0a0a0f; border: 1px solid #2a2a35; border-radius: 8px;
      color: #e0e0e0; font-family: inherit; font-size: 14px; padding: 10px 12px; margin-bottom: 12px;
    }
    input:focus, select:focus, textarea:focus { outline: none; border-color: #c084fc; }
    textarea { min-height: 120px; resize: vertical; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 13px; line-height: 1.5; }
    .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    @media (max-width: 600px) { .form-row { grid-template-columns: 1fr; } }
    button { padding: 10px 20px; border-radius: 8px; border: none; font-size: 14px; font-weight: 500; cursor: pointer; transition: all .2s; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-primary { background: #c084fc; color: #fff; }
    .btn-primary:hover:not(:disabled) { background: #a855f7; }
    .btn-secondary { background: #1e1e2a; color: #e0e0e0; border: 1px solid #2a2a35; }
    .btn-secondary:hover:not(:disabled) { background: #2a2a35; }
    .btn-success { background: #065f46; color: #6ee7b7; }
    .btn-success:hover:not(:disabled) { background: #047857; }
    .actions { display: flex; gap: 12px; margin-top: 8px; }
    .status { padding: 8px 16px; border-radius: 8px; font-size: 13px; margin-bottom: 16px; display: none; }
    .status.success { display: block; background: #064e3b; color: #6ee7b7; border: 1px solid #065f46; }
    .status.error { display: block; background: #450a0a; color: #fca5a5; border: 1px solid #7f1d1d; }
    .status.info { display: block; background: #1e1b4b; color: #a5b4fc; border: 1px solid #312e81; }
    .transcript-preview { max-height: 200px; overflow-y: auto; background: #0a0a0f; border: 1px solid #2a2a35; border-radius: 8px; padding: 12px; font-size: 13px; color: #aaa; line-height: 1.5; white-space: pre-wrap; }
    .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid #555; border-top-color: #c084fc; border-radius: 50%; animation: spin .6s linear infinite; margin-right: 6px; vertical-align: middle; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .info-row { display: flex; gap: 16px; margin-bottom: 12px; flex-wrap: wrap; }
    .info-badge { background: #1e1e2a; border: 1px solid #2a2a35; border-radius: 6px; padding: 6px 12px; font-size: 13px; }
    .info-badge strong { color: #c084fc; }
    .generated-preview { min-height: 300px; }
    .char-count { font-size: 12px; color: #666; text-align: right; margin-top: -8px; margin-bottom: 8px; }
    .inline-input { display: flex; gap: 8px; align-items: flex-start; }
    .inline-input input { flex: 1; margin-bottom: 0; }
    .inline-input button { margin-top: 0; white-space: nowrap; }
    .website-preview { max-height: 120px; overflow-y: auto; background: #0a0a0f; border: 1px solid #2a2a35; border-radius: 8px; padding: 10px; font-size: 12px; color: #888; line-height: 1.4; margin-bottom: 12px; }
    .website-badge { display: inline-block; background: #1e1b4b; color: #a5b4fc; border: 1px solid #312e81; border-radius: 6px; padding: 3px 10px; font-size: 12px; margin-bottom: 8px; }
  </style>
</head>
<body>
  <nav class="nav">
    <span class="nav-brand">Vizuara Voice Agent</span>
    <a href="/admin/costs">Costs</a>
    <a href="/admin/feedback">Feedback</a>
    <a href="/admin/add-course" class="active">Add Course</a>
  </nav>

  <div class="container">
    <h1>Add New Course to Knowledge Base</h1>
    <p class="subtitle">Extract transcript from YouTube, generate a structured KB section, review, and sync to VAPI</p>

    <div class="stepper">
      <div class="stepper-dot current" id="dot-0"></div>
      <div class="stepper-dot" id="dot-1"></div>
      <div class="stepper-dot" id="dot-2"></div>
      <div class="stepper-dot" id="dot-3"></div>
    </div>

    <div id="status" class="status"></div>

    <!-- Step 1: YouTube URL -->
    <div class="step active" id="step-0">
      <div class="step-header">
        <div class="step-number current">1</div>
        <div class="step-title">YouTube Video</div>
      </div>
      <div class="card">
        <label for="youtube-url">YouTube URL</label>
        <input type="text" id="youtube-url" placeholder="https://www.youtube.com/watch?v=..." />
        <div class="actions">
          <button class="btn-primary" id="btn-extract" onclick="extractTranscript()">Extract Transcript</button>
          <button class="btn-secondary" onclick="goToStep(1)">Skip &mdash; no video &rarr;</button>
        </div>
      </div>
      <div class="card" id="transcript-result" style="display:none">
        <div class="info-row">
          <div class="info-badge"><strong>Video ID:</strong> <span id="video-title"></span></div>
          <div class="info-badge"><strong>Transcript:</strong> <span id="video-chars"></span> chars</div>
        </div>
        <label>Transcript Preview</label>
        <div class="transcript-preview" id="transcript-preview"></div>
        <div class="actions" style="margin-top:12px">
          <button class="btn-primary" onclick="goToStep(1)">Next: Course Details &rarr;</button>
        </div>
      </div>
    </div>

    <!-- Step 2: Course Details -->
    <div class="step" id="step-1">
      <div class="step-header">
        <div class="step-number">2</div>
        <div class="step-title">Course Details</div>
      </div>
      <div class="card">
        <label for="course-name">Course Name *</label>
        <input type="text" id="course-name" placeholder="e.g. AI/ML Bootcamp Cohort 5" />

        <label for="website-url">Course Website URL (optional)</label>
        <div class="inline-input" style="margin-bottom:4px">
          <input type="text" id="website-url" placeholder="https://vizuara.ai/course-page" style="margin-bottom:0" />
          <button class="btn-secondary" id="btn-scrape" onclick="scrapeWebsite()">Scrape</button>
        </div>
        <div id="website-result" style="display:none">
          <span class="website-badge" id="website-badge"></span>
          <div class="website-preview" id="website-preview"></div>
        </div>

        <div class="form-row">
          <div>
            <label for="course-type">Type</label>
            <select id="course-type">
              <option value="Bootcamp">Bootcamp</option>
              <option value="Workshop">Workshop</option>
              <option value="Minor Program">Minor Program</option>
              <option value="Certification">Certification</option>
              <option value="Course">Course</option>
            </select>
          </div>
          <div>
            <label for="course-duration">Duration</label>
            <input type="text" id="course-duration" placeholder="e.g. 8 weeks" />
          </div>
        </div>

        <div class="form-row">
          <div>
            <label for="course-start">Start Date</label>
            <input type="text" id="course-start" placeholder="e.g. July 15, 2026" />
          </div>
          <div></div>
        </div>

        <div class="form-row">
          <div>
            <label for="price-original">Original Price (INR)</label>
            <input type="number" id="price-original" placeholder="25000" />
          </div>
          <div>
            <label for="price-discounted">Discounted Price (INR)</label>
            <input type="number" id="price-discounted" placeholder="20000" />
          </div>
        </div>

        <label for="target-audience">Target Audience</label>
        <input type="text" id="target-audience" placeholder="e.g. Working professionals, CS students" />

        <label for="prerequisites">Prerequisites</label>
        <input type="text" id="prerequisites" placeholder="e.g. Basic Python, Linear Algebra" />

        <label for="extra-notes">Additional Notes / FAQs</label>
        <textarea id="extra-notes" placeholder="Anything not in the video — special offers, instructor info, enrollment deadlines..."></textarea>

        <div class="actions">
          <button class="btn-secondary" onclick="goToStep(0)">&larr; Back</button>
          <button class="btn-primary" onclick="goToStep(2)">Next: Generate Section &rarr;</button>
        </div>
      </div>
    </div>

    <!-- Step 3: Review Generated Section -->
    <div class="step" id="step-2">
      <div class="step-header">
        <div class="step-number">3</div>
        <div class="step-title">Review Generated Section</div>
      </div>
      <div class="card">
        <div class="actions" style="margin-bottom:12px">
          <button class="btn-primary" id="btn-generate" onclick="generateSection()">Generate KB Section</button>
          <button class="btn-secondary" onclick="goToStep(1)">&larr; Back</button>
        </div>
        <label for="generated-section">Generated Section (editable)</label>
        <textarea id="generated-section" class="generated-preview" placeholder="Click 'Generate' to create a structured KB section from the transcript and course details..."></textarea>
        <div class="char-count" id="section-chars"></div>
        <div class="actions">
          <button class="btn-primary" onclick="goToStep(3)" id="btn-to-save" disabled>Next: Save &amp; Sync &rarr;</button>
        </div>
      </div>
    </div>

    <!-- Step 4: Save & Sync -->
    <div class="step" id="step-3">
      <div class="step-header">
        <div class="step-number">4</div>
        <div class="step-title">Save &amp; Sync</div>
      </div>
      <div class="card">
        <p style="margin-bottom:16px;color:#aaa">Your generated section is ready. Choose how to save it:</p>
        <div class="actions">
          <button class="btn-primary" onclick="appendToKB(false)">Append to Knowledge Base</button>
          <button class="btn-success" onclick="appendToKB(true)">Append &amp; Sync to VAPI</button>
          <button class="btn-secondary" onclick="goToStep(2)">&larr; Back to Edit</button>
        </div>
      </div>
      <div class="card" id="save-result" style="display:none">
        <h3 style="color:#6ee7b7;margin-bottom:8px">Done!</h3>
        <div id="save-details"></div>
        <div class="actions" style="margin-top:12px">
          <button class="btn-primary" onclick="resetWizard()">Add Another Course</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    let currentStep = 0;
    let transcriptData = null;
    let websiteData = null;

    function showStatus(msg, type) {
      const el = document.getElementById('status');
      el.className = 'status ' + type;
      el.textContent = msg;
      if (type === 'success') setTimeout(() => { el.className = 'status'; }, 5000);
    }

    function goToStep(n) {
      document.querySelectorAll('.step').forEach((s, i) => {
        s.classList.toggle('active', i === n);
      });
      document.querySelectorAll('.stepper-dot').forEach((d, i) => {
        d.className = 'stepper-dot' + (i < n ? ' done' : i === n ? ' current' : '');
      });
      currentStep = n;
    }

    async function extractTranscript() {
      const url = document.getElementById('youtube-url').value.trim();
      if (!url) return showStatus('Please enter a YouTube URL', 'error');

      const btn = document.getElementById('btn-extract');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>Extracting...';
      document.getElementById('status').className = 'status';

      try {
        const res = await fetch('/api/youtube/transcript', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        transcriptData = data;
        document.getElementById('video-title').textContent = data.title;
        document.getElementById('video-chars').textContent = data.transcript.length.toLocaleString();
        document.getElementById('transcript-preview').textContent = data.transcript.substring(0, 1000) + (data.transcript.length > 1000 ? '...' : '');
        document.getElementById('transcript-result').style.display = 'block';
        showStatus('Transcript extracted successfully', 'success');
      } catch (err) {
        showStatus('Failed to extract transcript: ' + err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Extract Transcript';
      }
    }

    async function scrapeWebsite() {
      const url = document.getElementById('website-url').value.trim();
      if (!url) return showStatus('Please enter a website URL', 'error');

      const btn = document.getElementById('btn-scrape');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>Scraping...';

      try {
        const res = await fetch('/api/website/scrape', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        websiteData = data;
        document.getElementById('website-badge').textContent = data.charCount.toLocaleString() + ' chars scraped';
        document.getElementById('website-preview').textContent = data.content.substring(0, 500) + (data.content.length > 500 ? '...' : '');
        document.getElementById('website-result').style.display = 'block';
        showStatus('Website scraped successfully', 'success');
      } catch (err) {
        showStatus('Scrape failed: ' + err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Scrape';
      }
    }

    async function generateSection() {
      const name = document.getElementById('course-name').value.trim();
      if (!name) return showStatus('Please enter a course name in Step 2', 'error');
      if (!transcriptData && !websiteData) return showStatus('Please extract a transcript or scrape a website first', 'error');

      const btn = document.getElementById('btn-generate');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>Generating (may take 10-20s)...';

      const metadata = {
        name,
        type: document.getElementById('course-type').value,
        startDate: document.getElementById('course-start').value,
        duration: document.getElementById('course-duration').value,
        priceOriginal: parseInt(document.getElementById('price-original').value) || 0,
        priceDiscounted: parseInt(document.getElementById('price-discounted').value) || 0,
        targetAudience: document.getElementById('target-audience').value,
        prerequisites: document.getElementById('prerequisites').value,
        notes: document.getElementById('extra-notes').value,
      };

      try {
        const res = await fetch('/api/knowledge-base/generate-section', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transcript: transcriptData?.transcript || '', metadata, websiteContent: websiteData?.content || '' })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        document.getElementById('generated-section').value = data.section;
        document.getElementById('section-chars').textContent = data.section.length + ' chars';
        document.getElementById('btn-to-save').disabled = false;
        showStatus('Section generated! Review and edit if needed.', 'success');
      } catch (err) {
        showStatus('Generation failed: ' + err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Generate KB Section';
      }
    }

    // Update char count on edit
    document.getElementById('generated-section').addEventListener('input', function() {
      document.getElementById('section-chars').textContent = this.value.length + ' chars';
      document.getElementById('btn-to-save').disabled = !this.value.trim();
    });

    async function appendToKB(syncToVapi) {
      const section = document.getElementById('generated-section').value.trim();
      if (!section) return showStatus('No section to append', 'error');

      // Build courseLink from form data for automatic suggested link registration
      const courseName = document.getElementById('course-name').value.trim();
      const websiteUrl = document.getElementById('website-url').value.trim();
      let courseLink = null;
      if (courseName && websiteUrl) {
        // Auto-generate keywords from course name words (lowercase, 2+ chars)
        const nameWords = courseName.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);
        const keywords = [courseName.toLowerCase()];
        // Add 2-3 word subphrases as keywords
        const words = courseName.toLowerCase().split(/\\s+/);
        for (let i = 0; i < words.length - 1; i++) {
          keywords.push(words.slice(i, i + 2).join(' '));
          if (i < words.length - 2) keywords.push(words.slice(i, i + 3).join(' '));
        }
        courseLink = { name: courseName, url: websiteUrl, keywords: [...new Set(keywords)] };
      }

      try {
        const res = await fetch('/api/knowledge-base/append', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ section, syncToVapi, courseLink })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        const details = document.getElementById('save-details');
        details.innerHTML = '<p>Section appended to knowledge base.</p>' +
          '<p style="margin-top:8px"><strong>Total KB size:</strong> ' + data.totalKBChars.toLocaleString() + ' chars</p>' +
          (data.linkAdded ? '<p style="color:#a5b4fc;margin-top:4px">Suggested link registered for voice widget.</p>' : '') +
          (data.synced ? '<p style="color:#6ee7b7;margin-top:4px">Synced to VAPI assistant.</p>' : '<p style="color:#888;margin-top:4px">Not synced to VAPI (set VAPI_SERVER_API_KEY and VAPI_ASSISTANT_ID to enable).</p>');
        document.getElementById('save-result').style.display = 'block';
        showStatus('Course added successfully!', 'success');
      } catch (err) {
        showStatus('Save failed: ' + err.message, 'error');
      }
    }

    function resetWizard() {
      document.getElementById('youtube-url').value = '';
      document.getElementById('transcript-result').style.display = 'none';
      document.getElementById('course-name').value = '';
      document.getElementById('website-url').value = '';
      document.getElementById('website-result').style.display = 'none';
      document.getElementById('course-duration').value = '';
      document.getElementById('course-start').value = '';
      document.getElementById('price-original').value = '';
      document.getElementById('price-discounted').value = '';
      document.getElementById('target-audience').value = '';
      document.getElementById('prerequisites').value = '';
      document.getElementById('extra-notes').value = '';
      document.getElementById('generated-section').value = '';
      document.getElementById('section-chars').textContent = '';
      document.getElementById('btn-to-save').disabled = true;
      document.getElementById('save-result').style.display = 'none';
      transcriptData = null;
      websiteData = null;
      goToStep(0);
      document.getElementById('status').className = 'status';
    }
  </script>
</body>
</html>`);
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
