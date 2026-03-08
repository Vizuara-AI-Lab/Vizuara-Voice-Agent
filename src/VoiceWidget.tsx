import React, { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Phone, Bot, Loader2, ExternalLink, Mail, Copy, CheckCheck, ChevronDown } from "lucide-react";
import { OpenAIRealtimeService } from "./services/OpenAIRealtimeService";

// ─── Configuration ──────────────────────────────────────────────────────────
// Edit these to customize the widget for your website.

/** System instruction — the AI's personality, knowledge, and rules. */
const SYSTEM_INSTRUCTION = `## Voice & Accent (HIGHEST PRIORITY)
- Accent: Warm Indian English, with the characteristic melodies and intonations of educated urban Indian speech
- Pacing: Moderate, with natural pauses typical of Indian conversational English
- Vocabulary: Use natural Indian English expressions like "actually", "basically" — avoid "Namaste", "Ji", "Kindly", "Please do the needful"
- Currency: Always say "Rupees twenty thousand" not "Rs 20000". Spell out all numbers in words.
- Language: Default to English. Only switch to Hindi if the user speaks 3+ consecutive sentences entirely in Hindi.

## Personality
You are a friendly Vizuara AI Labs assistant helping callers find the right AI and deep learning course.
Keep responses to 1-3 short sentences. Speak like a helpful colleague, not a document.
Never use lists or bullet points — you are speaking, not writing.

## STRICT RULES
- You CANNOT arrange calls, schedule meetings, or connect users with team members.
- If the user wants personalized guidance, EMI options, or corporate training, tell them to EMAIL the team.
- Contact emails: hello@vizuara.com (general) or rajatdandekar@vizuara.com (corporate).
- NEVER make up email addresses.

## Course Links (mention relevant URL when recommending)
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
- Context Engineering Workshop: context-engineering.vizuara.ai`;

/** OpenAI voice. Options: ash, alloy, echo, coral, sage */
const VOICE_NAME = "Fenrir"; // Maps to "ash"

/** OpenAI model */
const OPENAI_MODEL = "gpt-4o-realtime-preview";

// ─── Course Links Detection ─────────────────────────────────────────────────

const COURSE_LINKS: { name: string; url: string; price?: string; keywords: string[] }[] = [
  { name: "Minor in AI", url: "https://minor.vizuara.ai/", keywords: ["minor in ai"] },
  { name: "Minor in GenAI", url: "https://genai-minor.vizuara.ai/", keywords: ["minor in genai", "genai minor", "generative ai minor"] },
  { name: "Minor in Robotics", url: "https://minor-robotics.vizuara.ai/", keywords: ["minor in robotics", "robotics minor"] },
  { name: "Combined Minors", url: "https://minors.vizuara.ai/", keywords: ["combined minor", "both minors"] },
  { name: "RL Research Bootcamp", url: "https://rlresearcherbootcamp.vizuara.ai/", keywords: ["reinforcement learning", "rl research", "rl bootcamp"] },
  { name: "Hands-on RL Bootcamp", url: "https://hands-on-rl.vizuara.ai/", keywords: ["hands-on rl", "hands on reinforcement"] },
  { name: "CV Research Bootcamp", url: "https://cvresearchbootcamp.vizuara.ai/", keywords: ["cv research", "computer vision research"] },
  { name: "Hands-on CV Bootcamp", url: "https://hands-on-cv.vizuara.ai/", keywords: ["hands-on cv", "hands on computer vision"] },
  { name: "Vision LLMs Bootcamp", url: "https://vision-transformer.vizuara.ai/", keywords: ["vision llm", "vision transformer"] },
  { name: "Robot Learning Bootcamp", url: "https://robotlearningbootcamp.vizuara.ai/", price: "\u20B925,000", keywords: ["robot learning"] },
  { name: "GPU Engineers Bootcamp", url: "https://5d-parallelism.vizuara.ai/", price: "from \u20B910,000", keywords: ["gpu engineer", "5d parallelism", "gpu bootcamp"] },
  { name: "AI Agents Bootcamp", url: "https://agentsbootcamp.vizuara.ai/", keywords: ["ai agents bootcamp", "agents bootcamp"] },
  { name: "3-in-1 AI Bootcamp", url: "https://3-in-1.vizuara.ai/", keywords: ["3-in-1", "3 in 1 bootcamp"] },
  { name: "Context Engineering Workshop", url: "https://context-engineering.vizuara.ai/", keywords: ["context engineering"] },
  { name: "Build SLM Workshop", url: "https://slm.vizuara.ai/", keywords: ["build slm", "slm workshop", "small language model"] },
  { name: "AI Pods", url: "https://pods.vizuara.ai/", keywords: ["ai pods", "pods"] },
  { name: "10-Course AI & ML Bundle", url: "https://complete-pathway.vizuara.ai/", keywords: ["10-course", "10 course", "complete pathway"] },
  { name: "Vizz AI Tutor", url: "https://vizz.vizuara.ai/", keywords: ["vizz ai", "ai tutor", "vizz"] },
  { name: "High School AI Research", url: "https://ai-highschool-research.vizuara.ai/", keywords: ["high school", "highschool research"] },
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

// ─── Widget Component ───────────────────────────────────────────────────────

export default function VoiceWidget() {
  const [callState, setCallState] = useState<"idle" | "connecting" | "connected">("idle");
  const [transcription, setTranscription] = useState<{ text: string; isUser: boolean }[]>([]);
  const [volume, setVolume] = useState(0);
  const [emailCopied, setEmailCopied] = useState(false);
  const [emailExpanded, setEmailExpanded] = useState(false);
  const serviceRef = React.useRef<OpenAIRealtimeService | null>(null);
  const endingRef = React.useRef(false);

  const getService = () => {
    if (!serviceRef.current) serviceRef.current = new OpenAIRealtimeService();
    return serviceRef.current;
  };

  const startCall = async () => {
    endingRef.current = false;
    setCallState("connecting");
    setTranscription([]);
    const service = getService();

    try {
      await service.initializeAudio();

      const now = new Date();
      const dateString = now.toLocaleDateString("en-IN", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
      const timeString = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZoneName: "short" });

      const fullInstruction = `${SYSTEM_INSTRUCTION}\n\nToday: ${dateString}, ${timeString}.`;

      await service.connect({
        systemInstruction: fullInstruction,
        voiceName: VOICE_NAME,
        openaiModel: OPENAI_MODEL,
        transcriptionLanguage: "en",
        onStatusChange: (s, err) => {
          if (endingRef.current) return;
          if (s === "connected") setCallState("connected");
          else if (s === "error" || s === "disconnected") {
            setCallState("idle");
            if (err) console.error("[VoiceWidget] Error:", err);
          }
        },
        onTranscription: (text, isUser) => {
          setTranscription((prev) => [...prev, { text, isUser }].slice(-6));
        },
        onVolumeChange: (v) => setVolume(v),
      });
    } catch (err: any) {
      console.error("[VoiceWidget] Failed:", err);
      setCallState("idle");
    }
  };

  const endCall = async () => {
    endingRef.current = true;
    const service = getService();
    await service.disconnect();
    setVolume(0);
    setCallState("idle");
    setTranscription([]);
  };

  const handleClick = () => {
    if (callState === "idle") startCall();
    else if (callState === "connected") endCall();
  };

  const isActive = callState === "connected";
  const isConnecting = callState === "connecting";
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
              {isActive && <span className="voice-widget-timer">{formatTime(elapsed)}</span>}
            </div>

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

      {/* FAB button */}
      {!inCall && (
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
