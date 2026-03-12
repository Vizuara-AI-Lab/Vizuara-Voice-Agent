import React, { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Phone, Bot, Loader2, ExternalLink, Mail, Copy, CheckCheck, ChevronDown, AlertTriangle, ThumbsUp, ThumbsDown, X, CheckCircle } from "lucide-react";
import { OpenAIRealtimeService } from "./services/OpenAIRealtimeService";
import { VapiService } from "./services/VapiService";
import KNOWLEDGE_BASE from "./knowledge-base.txt?raw";

// ─── Configuration ──────────────────────────────────────────────────────────
// Edit these to customize the widget for your website.
// The full knowledge base is loaded from src/knowledge-base.txt

const SYSTEM_INSTRUCTION = `## Voice & Accent (HIGHEST PRIORITY — follow this throughout the ENTIRE conversation)
- Accent: Warm Indian English, with the characteristic melodies and intonations of educated urban Indian speech, like a professional from Bangalore or Mumbai
- Pacing: Moderate, with natural pauses typical of Indian conversational English
- Pronunciation: Use retroflex consonants naturally, give each syllable similar weight (syllable-timed rhythm rather than stress-timed)
- Vocabulary: Use natural Indian English expressions like "actually", "basically", "I'll tell you what" — but avoid "Namaste", "Ji", "Kindly", "Please do the needful"
- Currency: Always say "Rupees twenty thousand" not "Rs 20000". Spell out all numbers in words.
- Language: Default to English. Only switch to Hindi if the user speaks 3+ consecutive sentences entirely in Hindi. If Hinglish, continue in English. Never switch languages on your own.

## Personality
You are a friendly Vizuara AI Labs assistant helping callers find the right AI and deep learning course. Keep responses to 1-3 short sentences. Speak like a helpful colleague, not a document. Never use lists or bullet points — you are speaking, not writing.

## STRICT RULES — Never violate these
- You CANNOT arrange calls, schedule meetings, connect users with team members, or take any action beyond this conversation. Never promise to do so.
- If the user wants personalized guidance, EMI options, corporate training, or anything you cannot answer from the knowledge base, tell them to EMAIL the team. Do NOT promise to "connect" them or "have someone reach out".
- The ONLY contact email is: hello@vizuara.com (for general/education inquiries) or rajatdandekar@vizuara.com (for corporate/industry training).
- NEVER make up email addresses. Only use the two above.
- When suggesting the user send an email, just give them the email address. Do NOT offer to draft an email or write one out — the UI handles that automatically.
- NEVER fabricate course names, prices, dates, or instructor credentials — only use what is in the knowledge base below.

## Course Links (mention the relevant URL when recommending a program)
- AI Pods: pods.vizuara.ai
- Minor in GenAI: genai-minor.vizuara.ai
- Minor in Robotics: minor-robotics.vizuara.ai
- Combined Minors: minors.vizuara.ai
- Vision LLMs Bootcamp: vision-transformer.vizuara.ai
- Robot Learning Bootcamp: robotlearningbootcamp.vizuara.ai
- GPU Engineers Bootcamp: 5d-parallelism.vizuara.ai
- RL Research Bootcamp: rlresearcherbootcamp.vizuara.ai
- CV Research Bootcamp: cvresearchbootcamp.vizuara.ai
- AI Agents Bootcamp: agentsbootcamp.vizuara.ai
- Context Engineering Workshop: context-engineering.vizuara.ai

## Knowledge Base
${KNOWLEDGE_BASE}`;

/** OpenAI voice. Options: ash, alloy, echo, coral, sage */
const VOICE_NAME = "Fenrir"; // Maps to "ash"

/** OpenAI model */
const OPENAI_MODEL = "gpt-4o-realtime-preview";

// ─── Course Links Detection ─────────────────────────────────────────────────

const COURSE_LINKS: { name: string; url: string; price?: string; keywords: string[] }[] = [
  { name: "Minor in AI", url: "https://minor.vizuara.ai/", keywords: ["minor in ai", "minor in artificial intelligence"] },
  { name: "Minor in GenAI", url: "https://genai-minor.vizuara.ai/", keywords: ["minor in genai", "genai minor", "generative ai minor", "minor in generative ai", "minor in generative artificial intelligence"] },
  { name: "Minor in Robotics", url: "https://minor-robotics.vizuara.ai/", keywords: ["minor in robotics", "robotics minor", "minor in robot"] },
  { name: "Combined Minors", url: "https://minors.vizuara.ai/", keywords: ["combined minor", "both minors"] },
  { name: "RL Research Bootcamp", url: "https://rlresearcherbootcamp.vizuara.ai/", keywords: ["reinforcement learning", "rl research", "rl bootcamp"] },
  { name: "Hands-on RL Bootcamp", url: "https://hands-on-rl.vizuara.ai/", keywords: ["hands-on rl", "hands on reinforcement"] },
  { name: "CV Research Bootcamp", url: "https://cvresearchbootcamp.vizuara.ai/", keywords: ["cv research", "computer vision research", "computer vision bootcamp"] },
  { name: "Hands-on CV Bootcamp", url: "https://hands-on-cv.vizuara.ai/", keywords: ["hands-on cv", "hands on computer vision"] },
  { name: "Vision LLMs Bootcamp", url: "https://vision-transformer.vizuara.ai/", keywords: ["vision llm", "vision transformer"] },
  { name: "Robot Learning Bootcamp", url: "https://robotlearningbootcamp.vizuara.ai/", price: "\u20B925,000", keywords: ["robot learning"] },
  { name: "GPU Engineers Bootcamp", url: "https://5d-parallelism.vizuara.ai/", price: "from \u20B910,000", keywords: ["gpu engineer", "5d parallelism", "gpu bootcamp"] },
  { name: "AI Agents Bootcamp", url: "https://agentsbootcamp.vizuara.ai/", keywords: ["ai agents bootcamp", "agents bootcamp"] },
  { name: "3-in-1 AI Bootcamp", url: "https://3-in-1.vizuara.ai/", keywords: ["3-in-1", "3 in 1 bootcamp"] },
  { name: "Context Engineering Workshop", url: "https://context-engineering.vizuara.ai/", keywords: ["context engineering"] },
  { name: "Build SLM Workshop", url: "https://slm.vizuara.ai/", keywords: ["build slm", "slm workshop", "small language model"] },
  { name: "AI Pods", url: "https://pods.vizuara.ai/", keywords: ["ai pods", "pods"] },
  { name: "10-Course AI & ML Bundle", url: "https://complete-pathway.vizuara.ai/", keywords: ["10-course", "10 course", "complete pathway", "ai and ml bundle"] },
  { name: "Vizz AI Tutor", url: "https://vizz.vizuara.ai/", keywords: ["vizz ai", "ai tutor", "vizz"] },
  { name: "High School AI Research", url: "https://ai-highschool-research.vizuara.ai/", keywords: ["high school", "highschool research"] },
  { name: "VLA & World Models Bootcamp", url: "https://vla.vizuara.ai/", keywords: ["vla model", "world model", "vision language action", "vla bootcamp"] },
  { name: "Modern Software Developer Bootcamp", url: "https://modern-software-dev.vizuara.ai/", keywords: ["modern software developer", "software developer bootcamp", "vibe coding", "coding agent", "ai-powered development"] },
  { name: "VLA for Autonomous Driving", url: "https://robotlearningmastery.vizuara.ai/", keywords: ["autonomous driving", "self-driving", "vla driving", "toy car", "autonomous driving bootcamp"] },
];

const DOMAIN_TO_COURSE = new Map<string, (typeof COURSE_LINKS)[number]>();
COURSE_LINKS.forEach((c) => {
  try { DOMAIN_TO_COURSE.set(new URL(c.url).hostname, c); } catch {}
});

function detectCourseLinks(transcription: { text: string; isUser: boolean }[]): typeof COURSE_LINKS {
  const aiText = transcription.filter((t) => !t.isUser).map((t) => t.text).join(" ").toLowerCase();
  const userText = transcription.filter((t) => t.isUser).map((t) => t.text).join(" ").toLowerCase();
  const allText = aiText + " " + userText;

  const matched = new Map<string, (typeof COURSE_LINKS)[number]>();

  for (const course of COURSE_LINKS) {
    if (course.keywords.some((k) => allText.includes(k))) {
      matched.set(course.url, course);
    }
  }

  const domainRegex = /([a-z0-9-]+\.vizuara\.ai)/g;
  let m;
  while ((m = domainRegex.exec(aiText)) !== null) {
    const domain = m[1].replace(/\/+$/, "");
    const found = DOMAIN_TO_COURSE.get(domain);
    if (found) matched.set(found.url, found);
  }

  return Array.from(matched.values());
}

function userAsksForLink(transcription: { text: string; isUser: boolean }[]): boolean {
  const recentUser = transcription.filter((t) => t.isUser).slice(-2).map((t) => t.text.toLowerCase()).join(" ");
  return /\b(link|register|sign.?up|enroll|enrol|url|website|how.*(register|join|sign)|where.*(register|join|sign))\b/.test(recentUser);
}

function detectEmailDraft(
  transcription: { text: string; isUser: boolean }[]
): { subject: string; body: string; isDraft: boolean } | null {
  const aiMessages = transcription.filter((t) => !t.isUser);
  if (aiMessages.length === 0) return null;

  for (let i = aiMessages.length - 1; i >= 0; i--) {
    const text = aiMessages[i].text;
    const hasSubject = /subject\s*:/i.test(text);
    const hasSalutation = /\b(dear|hi|hello)\s+\w/i.test(text) && /\b(regards|sincerely|thank|best)\b/i.test(text);
    if (!hasSubject && !hasSalutation) continue;

    const subjectMatch = text.match(/subject\s*:\s*(.+?)(?:\n|---|dear|hi |hello )/i);
    const subject = subjectMatch ? subjectMatch[1].trim() : "";
    const bodyMatch = text.match(/((?:dear|hi|hello)\s+[\s\S]*?(?:regards|sincerely|thank[\s\S]*?|best[\s\S]*?)[\s\S]*?\[?your name\]?)/i);
    const body = bodyMatch ? bodyMatch[1].trim() : text;

    return { subject, body, isDraft: true };
  }

  const recentAI = aiMessages.slice(-2).map((t) => t.text.toLowerCase()).join(" ");
  const suggestsEmail = /\b(email|e-mail|mail)\b/.test(recentAI) && /\b(send|drop|write|draft|shoot|reach out|contact)\b/.test(recentAI);
  if (suggestsEmail) {
    const emailMatch = recentAI.match(/([a-z0-9.]+@vizuara\.com)/);
    const toEmail = emailMatch ? emailMatch[1] : "hello@vizuara.com";
    const allText = transcription.map((t) => t.text).join(" ");
    const topicMatch = allText.match(/\b((?:RL|reinforcement learning|computer vision|CV|GPU|robot|context engineering|vision llm|ai agents|genai|minor|bootcamp|workshop|SLM|sciml)[^\.,!?]*)/i);
    const topic = topicMatch ? topicMatch[1].trim() : "Vizuara program";
    return {
      subject: `Inquiry about ${topic}`,
      body: `Dear Vizuara Team,\n\nI hope you are doing well. I'm interested in learning more about the ${topic}.\n\nCould you please share more details?\n\nThank you for your time.\n\nBest regards,\n[Your Name]`,
      isDraft: false,
    };
  }

  return null;
}

function renderTextWithLinks(text: string): React.ReactNode {
  const urlRegex = /(https?:\/\/[^\s),]+|[a-z0-9-]+\.vizuara\.ai\/?)/gi;
  const parts = text.split(urlRegex);
  if (parts.length === 1) return text;
  return parts.map((part, i) => {
    if (/^https?:\/\//.test(part)) {
      return <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="text-purple-400 underline hover:text-purple-300">{part}</a>;
    }
    if (/[a-z0-9-]+\.vizuara\.ai\/?$/i.test(part)) {
      return <a key={i} href={`https://${part}`} target="_blank" rel="noopener noreferrer" className="text-purple-400 underline hover:text-purple-300">{part}</a>;
    }
    return <span key={i}>{part}</span>;
  });
}

// ─── Server Config Types ────────────────────────────────────────────────────

interface ServerConfig {
  provider: "openai" | "vapi";
  maxCallDurationSeconds: number;
  warningBeforeEndSeconds: number;
  dailyBudgetUsd: number | null;
  dailyCostUsd: number;
  budgetExceeded: boolean;
  vapiPublicKey?: string;
  vapiAssistantId?: string;
}

const DEFAULT_CONFIG: ServerConfig = {
  provider: "vapi",
  maxCallDurationSeconds: 300,
  warningBeforeEndSeconds: 30,
  dailyBudgetUsd: null,
  dailyCostUsd: 0,
  budgetExceeded: false,
};

// ─── Widget Component ───────────────────────────────────────────────────────

const NEGATIVE_REASONS = [
  "Not helpful",
  "Wrong info",
  "Too slow",
  "Hard to understand",
  "Didn't answer my question",
  "Other",
];

export default function VoiceWidget({ serverUrl = "" }: { serverUrl?: string }) {
  const [callState, setCallState] = useState<"idle" | "connecting" | "connected" | "feedback">("idle");
  const [transcription, setTranscription] = useState<{ text: string; isUser: boolean }[]>([]);
  const [volume, setVolume] = useState(0);
  const [emailCopied, setEmailCopied] = useState(false);
  const [emailExpanded, setEmailExpanded] = useState(false);
  const [timeWarning, setTimeWarning] = useState(false);
  const [budgetExceeded, setBudgetExceeded] = useState(false);

  // Feedback state
  const [feedbackRating, setFeedbackRating] = useState<"positive" | "negative" | null>(null);
  const [feedbackReasons, setFeedbackReasons] = useState<string[]>([]);
  const [feedbackComment, setFeedbackComment] = useState("");
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false);
  const [feedbackThankYou, setFeedbackThankYou] = useState(false);

  const openaiServiceRef = React.useRef<OpenAIRealtimeService | null>(null);
  const vapiServiceRef = React.useRef<VapiService | null>(null);
  const endingRef = React.useRef(false);
  const configRef = React.useRef<ServerConfig>(DEFAULT_CONFIG);
  const autoEndTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const warningTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Full transcript (never trimmed) for server submission
  const fullTranscriptRef = React.useRef<{ text: string; isUser: boolean; timestamp: string }[]>([]);
  const callStartTimeRef = React.useRef<string>("");
  const callRecordIdRef = React.useRef<string | null>(null);

  const getOpenAIService = () => {
    if (!openaiServiceRef.current) openaiServiceRef.current = new OpenAIRealtimeService();
    return openaiServiceRef.current;
  };

  const getVapiService = () => {
    if (!vapiServiceRef.current) vapiServiceRef.current = new VapiService();
    return vapiServiceRef.current;
  };

  const fetchConfig = async (): Promise<ServerConfig> => {
    try {
      const res = await fetch(`${serverUrl}/api/config`);
      const data = await res.json();
      configRef.current = data;
      return data;
    } catch (e) {
      console.warn("[VoiceWidget] Failed to fetch config, using defaults");
      return DEFAULT_CONFIG;
    }
  };

  const clearTimers = () => {
    if (autoEndTimerRef.current) { clearTimeout(autoEndTimerRef.current); autoEndTimerRef.current = null; }
    if (warningTimerRef.current) { clearTimeout(warningTimerRef.current); warningTimerRef.current = null; }
    setTimeWarning(false);
  };

  const startTimers = (config: ServerConfig) => {
    clearTimers();
    const maxMs = config.maxCallDurationSeconds * 1000;
    const warnMs = (config.maxCallDurationSeconds - config.warningBeforeEndSeconds) * 1000;

    // Warning timer
    if (warnMs > 0) {
      warningTimerRef.current = setTimeout(() => {
        setTimeWarning(true);
      }, warnMs);
    }

    // Auto-end timer (client-side backup — server also enforces)
    autoEndTimerRef.current = setTimeout(() => {
      console.log("[VoiceWidget] Max call duration reached. Auto-ending call.");
      endCall();
    }, maxMs + 2000); // +2s grace for server to close first
  };

  const resetFeedbackState = () => {
    setFeedbackRating(null);
    setFeedbackReasons([]);
    setFeedbackComment("");
    setFeedbackSubmitting(false);
    setFeedbackThankYou(false);
  };

  const submitCallRecord = async () => {
    const config = configRef.current;
    const vapiCallId = config.provider === "vapi" ? getVapiService().getCallId() : null;

    try {
      const res = await fetch(`${serverUrl}/api/call-record`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript: fullTranscriptRef.current,
          feedback: null,
          provider: config.provider,
          durationSeconds: elapsed,
          vapiCallId,
          startTime: callStartTimeRef.current,
        }),
      });
      const data = await res.json();
      if (data.id) callRecordIdRef.current = data.id;
    } catch (e) {
      console.warn("[VoiceWidget] Failed to submit call record:", e);
    }
  };

  const submitFeedback = async (feedback: { rating: "positive" | "negative"; reasons?: string[]; comment?: string }) => {
    const id = callRecordIdRef.current;
    if (!id) return;
    try {
      await fetch(`${serverUrl}/api/call-record/${id}/feedback`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(feedback),
      });
    } catch (e) {
      console.warn("[VoiceWidget] Failed to submit feedback:", e);
    }
  };

  const handleFeedbackPositive = async () => {
    setFeedbackRating("positive");
    setFeedbackSubmitting(true);
    await submitFeedback({ rating: "positive" });
    setFeedbackSubmitting(false);
    setFeedbackThankYou(true);
    setTimeout(() => {
      setCallState("idle");
      setTranscription([]);
      resetFeedbackState();
    }, 1500);
  };

  const handleFeedbackNegativeSelect = () => {
    setFeedbackRating("negative");
  };

  const handleFeedbackSubmitNegative = async () => {
    setFeedbackSubmitting(true);
    await submitFeedback({
      rating: "negative",
      reasons: feedbackReasons.length > 0 ? feedbackReasons : undefined,
      comment: feedbackComment.trim() || undefined,
    });
    setFeedbackSubmitting(false);
    setFeedbackThankYou(true);
    setTimeout(() => {
      setCallState("idle");
      setTranscription([]);
      resetFeedbackState();
    }, 1500);
  };

  const handleFeedbackSkip = () => {
    setCallState("idle");
    setTranscription([]);
    resetFeedbackState();
  };

  const toggleReason = (reason: string) => {
    setFeedbackReasons((prev) =>
      prev.includes(reason) ? prev.filter((r) => r !== reason) : [...prev, reason]
    );
  };

  const finalizeCall = () => {
    clearTimers();
    setVolume(0);
    setTimeWarning(false);
    if (fullTranscriptRef.current.length > 0) {
      submitCallRecord();
      setCallState("feedback");
    } else {
      setCallState("idle");
      setTranscription([]);
    }
  };

  const startCall = async () => {
    endingRef.current = false;
    setCallState("connecting");
    setTranscription([]);
    setTimeWarning(false);
    fullTranscriptRef.current = [];
    callStartTimeRef.current = new Date().toISOString();
    callRecordIdRef.current = null;
    resetFeedbackState();

    const config = await fetchConfig();

    if (config.budgetExceeded) {
      setBudgetExceeded(true);
      setCallState("idle");
      return;
    }

    try {
      if (config.provider === "vapi" && config.vapiPublicKey && config.vapiAssistantId) {
        // --- VAPI Mode ---
        const service = getVapiService();
        await service.initializeAudio();
        await service.connect({
          serverUrl,
          vapiPublicKey: config.vapiPublicKey,
          vapiAssistantId: config.vapiAssistantId,
          onStatusChange: (s, err) => {
            if (endingRef.current) return;
            if (s === "connected") {
              setCallState("connected");
              startTimers(config);
            } else if (s === "error" || s === "disconnected") {
              if (err) console.error("[VoiceWidget] VAPI Error:", err);
              finalizeCall();
            }
          },
          onTranscription: (text, isUser) => {
            fullTranscriptRef.current.push({ text, isUser, timestamp: new Date().toISOString() });
            setTranscription((prev) => [...prev, { text, isUser }].slice(-6));
          },
          onVolumeChange: (v) => setVolume(v),
        });
      } else {
        // --- OpenAI Realtime Mode ---
        const service = getOpenAIService();
        await service.initializeAudio();

        const now = new Date();
        const dateString = now.toLocaleDateString("en-IN", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
        const timeString = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZoneName: "short" });

        const fullInstruction = `${SYSTEM_INSTRUCTION}\n\nToday: ${dateString}, ${timeString}.`;

        await service.connect({
          serverUrl,
          systemInstruction: fullInstruction,
          voiceName: VOICE_NAME,
          openaiModel: OPENAI_MODEL,
          transcriptionLanguage: "en",
          onStatusChange: (s, err) => {
            if (endingRef.current) return;
            if (s === "connected") {
              setCallState("connected");
              startTimers(config);
            } else if (s === "error" || s === "disconnected") {
              if (err) console.error("[VoiceWidget] Error:", err);
              finalizeCall();
            }
          },
          onTranscription: (text, isUser) => {
            fullTranscriptRef.current.push({ text, isUser, timestamp: new Date().toISOString() });
            setTranscription((prev) => [...prev, { text, isUser }].slice(-6));
          },
          onVolumeChange: (v) => setVolume(v),
          onTimeWarning: () => {
            setTimeWarning(true);
          },
          onTimeExceeded: () => {
            endCall();
          },
        });
      }
    } catch (err: any) {
      console.error("[VoiceWidget] Failed:", err);
      setCallState("idle");
      clearTimers();
    }
  };

  const endCall = async () => {
    endingRef.current = true;
    clearTimers();

    const config = configRef.current;
    if (config.provider === "vapi") {
      await getVapiService().disconnect();
    } else {
      await getOpenAIService().disconnect();
    }

    finalizeCall();
  };

  const handleClick = () => {
    if (budgetExceeded) {
      setBudgetExceeded(false);
      return;
    }
    if (callState === "idle") startCall();
    else if (callState === "connected") endCall();
  };

  const isActive = callState === "connected";
  const isConnecting = callState === "connecting";
  const isFeedback = callState === "feedback";
  const inCall = isActive || isConnecting;

  // Call timer
  const [elapsed, setElapsed] = useState(0);
  const timerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  React.useEffect(() => {
    if (isActive) {
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((prev) => prev + 1), 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isActive]);

  const maxDuration = configRef.current.maxCallDurationSeconds;
  const remaining = Math.max(0, maxDuration - elapsed);

  const formatTime = (s: number) =>
    `${Math.floor(s / 60).toString().padStart(2, "0")}:${(s % 60).toString().padStart(2, "0")}`;

  const transcriptEndRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcription]);

  // Derive suggested course links
  const suggestedLinks = useMemo(() => {
    if (transcription.length === 0) return [];
    const detected = detectCourseLinks(transcription);
    if (detected.length === 0) return [];
    const askedForLink = userAsksForLink(transcription);
    const aiMentionedCourse = transcription.some(
      (t) => !t.isUser && detected.some((c) => c.keywords.some((k) => t.text.toLowerCase().includes(k)))
    );
    return askedForLink || aiMentionedCourse ? detected : [];
  }, [transcription]);

  // Detect email draft
  const emailDraft = useMemo(() => detectEmailDraft(transcription), [transcription]);

  const copyEmailToClipboard = () => {
    if (!emailDraft) return;
    const fullEmail = emailDraft.subject ? `Subject: ${emailDraft.subject}\n\n${emailDraft.body}` : emailDraft.body;
    navigator.clipboard.writeText(fullEmail).then(() => {
      setEmailCopied(true);
      setTimeout(() => setEmailCopied(false), 2000);
    });
  };

  return (
    <>
      {/* Budget exceeded notice */}
      <AnimatePresence>
        {budgetExceeded && !inCall && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="voice-widget-window"
            style={{ textAlign: "center", padding: "24px 16px" }}
          >
            <AlertTriangle size={32} color="#f59e0b" style={{ margin: "0 auto 12px" }} />
            <p style={{ color: "#fff", fontSize: "14px", fontWeight: 600, marginBottom: "8px" }}>
              Daily budget reached
            </p>
            <p style={{ color: "#a3a3a3", fontSize: "12px", marginBottom: "16px" }}>
              Voice calls are paused until tomorrow to manage costs.
            </p>
            <button onClick={() => setBudgetExceeded(false)} className="voice-widget-end-btn" style={{ background: "#525252" }}>
              Dismiss
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Call window */}
      <AnimatePresence>
        {inCall && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.95 }}
            transition={{ type: "spring", stiffness: 300, damping: 25 }}
            className="voice-widget-window"
          >
            {/* Top bar */}
            <div className="voice-widget-topbar">
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <div className={`voice-widget-dot ${isActive ? "active" : "connecting"}`} />
                <span className="voice-widget-status">{isConnecting ? "Connecting..." : "Live Call"}</span>
              </div>
              {isActive && (
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span className="voice-widget-timer">{formatTime(elapsed)}</span>
                  <span style={{ color: "#525252", fontSize: "10px" }}>/</span>
                  <span className={`voice-widget-timer ${timeWarning ? "warning" : ""}`}>
                    {formatTime(remaining)}
                  </span>
                </div>
              )}
            </div>

            {/* Time warning banner */}
            {timeWarning && isActive && (
              <div className="voice-widget-time-warning">
                <AlertTriangle size={12} />
                <span>Call ending in {formatTime(remaining)}</span>
              </div>
            )}

            {/* Avatar + voice visualization */}
            <div className="voice-widget-avatar-section">
              <div style={{ position: "relative" }}>
                {isActive && (
                  <>
                    <span className="voice-widget-ring-1" style={{ transform: `scale(${1 + volume * 0.8})` }} />
                    <span className="voice-widget-ring-2" style={{ transform: `scale(${1 + volume * 0.5})` }} />
                  </>
                )}
                {isConnecting && <span className="voice-widget-pulse-ring" />}
                <div className="voice-widget-avatar">
                  <Bot size={28} color="white" />
                </div>
              </div>
              <p className="voice-widget-name">Vizuara AI</p>
              {isConnecting && <p className="voice-widget-subtext">Setting up voice channel...</p>}

              {/* Volume bars */}
              {isActive && (
                <div className="voice-widget-bars">
                  {[...Array(7)].map((_, i) => (
                    <motion.div
                      key={i}
                      className="voice-widget-bar"
                      animate={{
                        height: Math.max(3, Math.min(20, volume * 25 * (0.6 + Math.sin(Date.now() / 200 + i * 1.2) * 0.4))),
                      }}
                      transition={{ duration: 0.1 }}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Transcript */}
            {isActive && transcription.length > 0 && (
              <div className="voice-widget-transcript">
                <div>
                  {transcription.map((t, i) => (
                    <p key={i} className={`voice-widget-transcript-line ${t.isUser ? "user" : "ai"}`}>
                      <span className={`voice-widget-speaker ${t.isUser ? "user" : "ai"}`}>
                        {t.isUser ? "You" : "AI"}
                      </span>
                      {renderTextWithLinks(t.text)}
                    </p>
                  ))}
                  <div ref={transcriptEndRef} />
                </div>
              </div>
            )}

            {/* Suggested course links */}
            {isActive && suggestedLinks.length > 0 && (
              <div className="voice-widget-links-section">
                <p className="voice-widget-section-label">Suggested Links</p>
                <div>
                  {suggestedLinks.map((course) => (
                    <a key={course.url} href={course.url} target="_blank" rel="noopener noreferrer" className="voice-widget-link">
                      <div>
                        <p className="voice-widget-link-name">{course.name}</p>
                        {course.price && <p className="voice-widget-link-price">{course.price}</p>}
                      </div>
                      <span className="voice-widget-link-action">
                        Register <ExternalLink size={10} />
                      </span>
                    </a>
                  ))}
                </div>
              </div>
            )}

            {/* Email draft card */}
            {isActive && emailDraft && (
              <div className="voice-widget-email-section">
                <div className="voice-widget-email-card">
                  <button onClick={() => setEmailExpanded(!emailExpanded)} className="voice-widget-email-header">
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <Mail size={13} color="#f472b6" />
                      <p className="voice-widget-section-label" style={{ margin: 0 }}>
                        {emailDraft.isDraft ? "Email Draft" : "Suggested Email"}
                      </p>
                    </div>
                    <ChevronDown size={12} color="#a3a3a3" style={{ transform: emailExpanded ? "rotate(180deg)" : "none", transition: "transform 0.2s" }} />
                  </button>
                  {emailExpanded && (
                    <div style={{ padding: "0 12px 12px" }}>
                      {emailDraft.subject && (
                        <p className="voice-widget-email-subject">
                          <strong>Subject:</strong> {emailDraft.subject}
                        </p>
                      )}
                      <p className="voice-widget-email-body">{emailDraft.body}</p>
                    </div>
                  )}
                  <div className="voice-widget-email-copy-bar">
                    <button onClick={copyEmailToClipboard} className="voice-widget-email-copy-btn">
                      {emailCopied ? <><CheckCheck size={11} /> Copied!</> : <><Copy size={11} /> Copy Email</>}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* End call button */}
            <div className="voice-widget-footer">
              <button
                onClick={isActive ? endCall : undefined}
                disabled={isConnecting}
                className={`voice-widget-end-btn ${isConnecting ? "disabled" : ""}`}
              >
                {isConnecting ? (
                  <><Loader2 size={15} className="voice-widget-spinner" /> Connecting...</>
                ) : (
                  <><Phone size={15} /> End Call</>
                )}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Feedback window */}
      <AnimatePresence>
        {isFeedback && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.95 }}
            transition={{ type: "spring", stiffness: 300, damping: 25 }}
            className="voice-widget-window"
          >
            {feedbackThankYou ? (
              <div className="voice-widget-feedback-thanks">
                <div className="voice-widget-feedback-thanks-icon">
                  <CheckCircle size={24} />
                </div>
                <p className="voice-widget-feedback-thanks-text">Thank you!</p>
                <p className="voice-widget-feedback-thanks-sub">Your feedback helps us improve</p>
              </div>
            ) : (
              <div style={{ padding: "24px 20px", position: "relative" }}>
                {/* Skip button */}
                <button onClick={handleFeedbackSkip} className="voice-widget-feedback-skip" title="Skip">
                  <X size={16} />
                </button>

                <p className="voice-widget-feedback-question">How was your call?</p>

                {/* Thumbs up/down */}
                <div className="voice-widget-feedback-buttons">
                  <button
                    onClick={handleFeedbackPositive}
                    className={`voice-widget-feedback-btn positive ${feedbackRating === "positive" ? "selected" : ""}`}
                    disabled={feedbackSubmitting}
                  >
                    <ThumbsUp size={24} />
                  </button>
                  <button
                    onClick={handleFeedbackNegativeSelect}
                    className={`voice-widget-feedback-btn negative ${feedbackRating === "negative" ? "selected" : ""}`}
                    disabled={feedbackSubmitting}
                  >
                    <ThumbsDown size={24} />
                  </button>
                </div>

                {/* Negative feedback detail */}
                {feedbackRating === "negative" && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    className="voice-widget-feedback-reasons"
                  >
                    <p className="voice-widget-feedback-reasons-label">What went wrong?</p>
                    <div className="voice-widget-feedback-chips">
                      {NEGATIVE_REASONS.map((reason) => (
                        <button
                          key={reason}
                          onClick={() => toggleReason(reason)}
                          className={`voice-widget-feedback-chip ${feedbackReasons.includes(reason) ? "selected" : ""}`}
                        >
                          {reason}
                        </button>
                      ))}
                    </div>
                    <textarea
                      className="voice-widget-feedback-text"
                      placeholder="Any additional comments? (optional)"
                      rows={2}
                      value={feedbackComment}
                      onChange={(e) => setFeedbackComment(e.target.value)}
                    />
                    <button
                      onClick={handleFeedbackSubmitNegative}
                      disabled={feedbackSubmitting}
                      className="voice-widget-feedback-submit"
                    >
                      {feedbackSubmitting ? "Submitting..." : "Submit Feedback"}
                    </button>
                  </motion.div>
                )}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* FAB button */}
      {!inCall && !isFeedback && !budgetExceeded && (
        <motion.button
          initial={{ scale: 0, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 260, damping: 20, delay: 0.5 }}
          onClick={handleClick}
          className="voice-widget-fab"
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.95 }}
        >
          <span className="voice-widget-fab-pulse" />
          <Phone size={24} color="white" />
        </motion.button>
      )}
    </>
  );
}
