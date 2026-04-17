import OpenAI from "openai";
import { createRequire } from "module";
import puppeteer from "puppeteer-core";

const _require = createRequire(import.meta.url);
const { YoutubeTranscript } = _require("youtube-transcript/dist/youtube-transcript.common.js");

export async function fetchYouTubeTranscript(url: string): Promise<{ transcript: string; title: string }> {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error("Invalid YouTube URL");

  try {
    const segments = await YoutubeTranscript.fetchTranscript(videoId);
    if (!segments?.length) throw new Error("Transcript was empty");
    const transcript = segments.map((s) => s.text).join(" ");

    // Fetch title from YouTube page (lightweight)
    let title = `Video ${videoId}`;
    try {
      const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      });
      const html = await pageRes.text();
      const titleMatch = html.match(/<title>(.+?)<\/title>/);
      if (titleMatch) title = titleMatch[1].replace(" - YouTube", "").trim();
    } catch {}

    return { transcript, title };
  } catch (err: any) {
    throw new Error(`Transcript extraction failed: ${err.message}`);
  }
}

function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  if (/^[a-zA-Z0-9_-]{11}$/.test(url)) return url;
  return null;
}

export interface CourseMetadata {
  name: string;
  type: string;
  startDate: string;
  duration: string;
  priceOriginal: number;
  priceDiscounted: number;
  targetAudience: string;
  prerequisites: string;
  notes: string;
  websiteUrl: string;
  websiteContent: string;
}

function cleanHtmlToText(html: string): string {
  // Strip script, style, nav, footer tags and their content
  html = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  html = html.replace(/<style[\s\S]*?<\/style>/gi, "");
  html = html.replace(/<nav[\s\S]*?<\/nav>/gi, "");
  html = html.replace(/<footer[\s\S]*?<\/footer>/gi, "");

  // Strip all remaining HTML tags
  let text = html.replace(/<[^>]+>/g, " ");

  // Decode common HTML entities
  text = text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");

  // Collapse whitespace
  text = text.replace(/\s+/g, " ").trim();

  // Truncate to 8K chars
  return text;
}

const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export async function scrapeWebsite(url: string): Promise<string> {
  // Try Puppeteer (headless Chrome) first — handles SPAs
  try {
    const browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    await page.goto(url, { waitUntil: "networkidle2", timeout: 20000 });
    const html = await page.content();
    await browser.close();
    const text = cleanHtmlToText(html);
    if (text.length > 50) return text;
  } catch (err: any) {
    console.warn("[Scrape] Puppeteer failed, falling back to fetch:", err.message);
  }

  // Fallback: plain fetch (works for server-rendered pages)
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    return cleanHtmlToText(html);
  } catch (err: any) {
    console.warn("[Scrape] Fetch also failed for", url, err.message);
    return "";
  }
}

const KB_FORMAT_EXAMPLE = `## Program Name — Type (Duration)

### Overview
Brief 2-3 sentence description of the program, what students will learn, and the key outcomes.

### Curriculum & Topics Covered
- **Module 1: Topic Name** — Brief description
- **Module 2: Topic Name** — Brief description
- **Module 3: Topic Name** — Brief description

### Schedule & Format
- **Start Date**: Month Day, Year
- **Duration**: X weeks / months
- **Format**: Live online sessions / Self-paced / Hybrid
- **Schedule**: Days and times

### Pricing
If multiple plans/tiers exist, list each with its price and what's included:

| Plan | Price | Key Inclusions |
|------|-------|----------------|
| Plan Name 1 | ₹XX,XXX | What this tier includes |
| Plan Name 2 | ₹XX,XXX | What this tier includes |

If only one price exists:
| | Price |
|------|-------|
| Original Price | ₹XX,XXX |
| Discounted Price | ₹XX,XXX |

### Who Should Join
- Target audience point 1
- Target audience point 2

### Prerequisites
- Prerequisite 1
- Prerequisite 2

### FAQs
**Q: Common question?**
A: Answer based on available information.

Include FAQs that address practical questions a caller would ask: pricing differences between plans, what's included in each tier, refund policy, certificate details, hardware requirements, etc.`;

export async function generateCourseSection(
  transcript: string,
  metadata: CourseMetadata,
  existingKBSample: string,
  websiteContent: string = ""
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const client = new OpenAI({ apiKey });

  // Truncate transcript if too long (keep first 12K chars for context window efficiency)
  const truncatedTranscript = !transcript
    ? "(No transcript provided — use website content as primary source)"
    : transcript.length > 12000
      ? transcript.substring(0, 12000) + "\n\n[... transcript truncated ...]"
      : transcript;

  const systemPrompt = `You are a knowledge base content writer for Vizuara, an AI education company.
Your job is to generate a structured markdown section for a new course/program that will be added to the company's knowledge base.

The knowledge base is used by a voice AI agent to answer caller questions, so the content must be:
- Factual and specific (dates, prices, durations)
- Well-structured with clear headers for easy retrieval
- Written in third person ("This program covers..." not "You will learn...")

Here is the EXACT format you must follow:

${KB_FORMAT_EXAMPLE}

Here is a sample from the existing knowledge base for style reference (first 2000 chars):
${existingKBSample.substring(0, 2000)}

IMPORTANT RULES:
1. Output ONLY the markdown section — no preamble, no explanation, no code fences
2. Start with ## heading
3. Extract curriculum topics, key highlights, and selling points from the transcript AND website content
4. Use the user-provided metadata for name, type, dates, audience, prerequisites
5. Use the EXACT start date from the metadata. Do NOT default to 2024 or any other year — use the year provided.
6. For PRICING: If website content contains specific prices (₹X,XXX), use those prices and list ALL pricing tiers/plans with what each tier includes. Only fall back to metadata prices if the website has no pricing info. Metadata prices of ₹0 mean "not provided" — never show ₹0 if the website has real prices.
7. If the transcript or website mentions instructors, include them
8. Generate 5-8 relevant FAQs that a phone caller would actually ask — pricing differences between plans, what's included, refund policy, certificate, hardware needs, schedule, etc. Mine BOTH the transcript AND website for these.
9. Keep the tone professional but approachable
10. If website content is provided, it is your PRIMARY source for facts. Extract ALL structured details: pricing tiers and what each includes, curriculum breakdown, instructor bios, testimonials, enrollment info, special offers (e.g. "free for Minor students"), and any other details a caller might ask about. The transcript supplements with narrative context.
11. Do NOT omit information just because it doesn't fit neatly into the template. Add extra subsections if needed (e.g. ### Instructors, ### Special Offers, ### What's Included)`;

  // gpt-4o-mini has 128K context — no need to aggressively truncate website content
  const truncatedWebsite = websiteContent;

  const websiteSection = truncatedWebsite
    ? `\n\n**Website Content**:\n${truncatedWebsite}`
    : "";

  const userPrompt = `Generate a knowledge base section for this course:

**Course Name**: ${metadata.name}
**Type**: ${metadata.type}
**Start Date**: ${metadata.startDate} (USE THIS EXACT DATE — do not change the year)
**Duration**: ${metadata.duration}
**Original Price**: ${metadata.priceOriginal ? "₹" + metadata.priceOriginal.toLocaleString("en-IN") : "Not provided (check website content below)"}
**Discounted Price**: ${metadata.priceDiscounted ? "₹" + metadata.priceDiscounted.toLocaleString("en-IN") : "Not provided (check website content below)"}
**Target Audience**: ${metadata.targetAudience}
**Prerequisites**: ${metadata.prerequisites}
**Additional Notes from User**: ${metadata.notes || "None"}

**Video Transcript**:
${truncatedTranscript}${websiteSection}`;

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.3,
    max_tokens: 4000,
  });

  return response.choices[0]?.message?.content?.trim() || "";
}
