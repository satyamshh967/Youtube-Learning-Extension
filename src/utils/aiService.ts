const MODEL_CANDIDATES = [
  import.meta.env.VITE_GEMINI_MODEL,
  "gemini-3.6-flash",
  "gemini-2.5-flash",
  "gemini-1.5-flash",
].filter(Boolean) as string[];

const GEMINI_API_KEY: string = import.meta.env.VITE_GEMINI_API_KEY || "";

export function getApiKey(): string | null {
  return GEMINI_API_KEY || null;
}

export interface AIChapter {
  id: string;
  startSeconds: number;
  timestamp: string;
  title: string;
  summary: string;
}

export interface AISummary {
  overview: string;
  mainPoints: string[];
  importantExplanations: string[];
  keyConclusions: string[];
}

function formatTime(seconds: number): string {
  const totalSecs = Math.max(0, Math.floor(seconds));
  const hrs = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;

  if (hrs > 0) {
    return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

interface TranscriptSegmentInput {
  start: number;
  end?: number;
  text: string;
}

function buildTranscriptText(
  segments: TranscriptSegmentInput[],
  maxChars = 120000,
): string {
  const lines: string[] = [];
  let charCount = 0;

  for (const seg of segments) {
    const line = `[${formatTime(seg.start)}] ${seg.text}`;
    if (charCount + line.length > maxChars) break;
    lines.push(line);
    charCount += line.length;
  }

  return lines.join("\n");
}

async function callGemini(apiKey: string, prompt: string): Promise<string> {
  let lastError: Error | null = null;

  for (const model of MODEL_CANDIDATES) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 8192,
          },
        }),
      });

      if (response.ok) {
        const data = await response.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return text;
      }

      const errorBody = await response.text().catch(() => "");
      if (response.status === 400 || response.status === 403) {
        throw new Error("Invalid API key or permission denied. Please check your Gemini API key.");
      }

      if (response.status === 404) {
        lastError = new Error(`Model ${model} not available: ${errorBody.slice(0, 150)}`);
        continue;
      }

      throw new Error(`Gemini API error (${response.status}): ${errorBody.slice(0, 200)}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (
        lastError.message.includes("Invalid API key") ||
        lastError.message.includes("permission denied")
      ) {
        throw lastError;
      }
    }
  }

  throw lastError || new Error("Failed to generate content with Gemini.");
}

export async function generateAIChapters(
  segments: TranscriptSegmentInput[],
  videoTitle: string,
  durationSeconds: number | null | undefined,
): Promise<AIChapter[]> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("No API key configured. Set VITE_GEMINI_API_KEY in your .env file.");

  const transcriptText = buildTranscriptText(segments, 120000);
  const durationStr = durationSeconds
    ? `The video is approximately ${formatTime(durationSeconds)} long.`
    : "";

  const prompt = `You are an expert video analyst and educator. Given the following timestamped transcript of a YouTube video titled "${videoTitle}", generate a list of chapters that divide the video into logical topic sections.

${durationStr}

Rules:
- The first chapter MUST start at 00:00.
- Each chapter timestamp MUST accurately match a point in the video where a new topic or discussion begins.
- Create between 4 to 12 chapters depending on video length and topic diversity.
- Each chapter needs a concise, descriptive title (3-8 words) and a 1-2 sentence informative summary explaining what is covered in that section.
- Chapters should represent meaningful topic shifts.

Respond ONLY with valid JSON — an array of objects with these exact keys:
- "startSeconds" (number, seconds from start)
- "timestamp" (string, formatted as MM:SS or HH:MM:SS)
- "title" (string)
- "summary" (string)

Transcript:
${transcriptText}`;

  const raw = await callGemini(apiKey, prompt);

  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error("Could not parse chapters from AI response.");
  }

  const parsed = JSON.parse(jsonMatch[0]) as Array<{
    startSeconds: number;
    timestamp: string;
    title: string;
    summary: string;
  }>;

  return parsed.map((ch, i) => ({
    id: `ai-chap-${i}`,
    startSeconds: ch.startSeconds,
    timestamp: ch.timestamp || formatTime(ch.startSeconds),
    title: ch.title,
    summary: ch.summary,
  }));
}

export async function generateAISummary(
  segments: TranscriptSegmentInput[],
  videoTitle: string,
): Promise<AISummary> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("No API key configured. Set VITE_GEMINI_API_KEY in your .env file.");

  const transcriptText = buildTranscriptText(segments, 120000);

  const prompt = `You are an elite research assistant and content analyst. Given the following timestamped transcript of a YouTube video titled "${videoTitle}", generate a thorough, high-value, structured summary.

Requirements:
1. Overview: Write a comprehensive 3-5 sentence paragraph explaining what the video is about, the central problem or thesis, who it is for, and the ultimate value delivered.
2. Main Points: Provide 6-10 rich, informative bullet points highlighting the core arguments, facts, methods, steps, and key concepts discussed across the video.
3. Important Explanations: Provide 3-6 detailed breakdowns of complex ideas, technical concepts, step-by-step methodologies, or examples explained by the speaker.
4. Key Conclusions & Takeaways: Provide 3-5 concrete, actionable takeaways, final conclusions, or lessons that the viewer should walk away with.

Rules:
- Be specific, detailed, and directly reference real information and terms from the transcript.
- Avoid vague generic statements like "the speaker discusses several topics".
- Return ONLY valid JSON with no conversational prefix/suffix.

Respond ONLY with valid JSON with these exact keys:
- "overview" (string)
- "mainPoints" (array of strings)
- "importantExplanations" (array of strings)
- "keyConclusions" (array of strings)

Transcript:
${transcriptText}`;

  const raw = await callGemini(apiKey, prompt);

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("Could not parse summary from AI response.");
  }

  const parsed = JSON.parse(jsonMatch[0]) as AISummary;

  return {
    overview: parsed.overview || "Summary could not be generated.",
    mainPoints: Array.isArray(parsed.mainPoints) ? parsed.mainPoints : [],
    importantExplanations: Array.isArray(parsed.importantExplanations) ? parsed.importantExplanations : [],
    keyConclusions: Array.isArray(parsed.keyConclusions) ? parsed.keyConclusions : [],
  };
}

export function formatAIChaptersForExport(chapters: AIChapter[]): string {
  return chapters.map((c) => `${c.timestamp} ${c.title}`).join("\n");
}

export function formatAIChaptersDetailedForExport(
  chapters: AIChapter[],
  videoTitle = "Video Chapters",
): string {
  const lines: string[] = [
    `# ${videoTitle} - Chapters`,
    "",
    "## YouTube Timestamps",
    ...chapters.map((c) => `${c.timestamp} ${c.title}`),
    "",
    "## Chapter Details & Summaries",
    ...chapters.map(
      (c) => `### [${c.timestamp}] ${c.title}\n${c.summary || "No description."}\n`,
    ),
  ];
  return lines.join("\n");
}

export function formatAISummaryForExport(
  summary: AISummary,
  videoTitle = "Video Summary",
): string {
  const sections: string[] = [
    `# ${videoTitle}`,
    "",
    "## Overview",
    summary.overview || "No overview available.",
    "",
    "## Main Points",
    ...(summary.mainPoints?.length
      ? summary.mainPoints.map((p) => `• ${p}`)
      : ["• None"]),
    "",
    "## Important Explanations",
    ...(summary.importantExplanations?.length
      ? summary.importantExplanations.map((e) => `• ${e}`)
      : ["• None"]),
    "",
    "## Key Conclusions & Takeaways",
    ...(summary.keyConclusions?.length
      ? summary.keyConclusions.map((c) => `• ${c}`)
      : ["• None"]),
  ];

  return sections.join("\n");
}

export interface AIScriptFallbackResult {
  segments: Array<{
    start: number;
    end?: number;
    timestamp: string;
    endTimestamp?: string;
    text: string;
  }>;
  summary: AISummary;
  chapters: AIChapter[];
}

export async function generateAIScriptFallback(video: {
  id: string | null;
  title: string;
  description?: string;
  channelName?: string;
  duration?: number | null;
}): Promise<AIScriptFallbackResult> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("No API key configured. Set VITE_GEMINI_API_KEY in your .env file.");

  const durationSec = video.duration && video.duration > 0 ? video.duration : 600;
  const durationStr = formatTime(durationSec);

  const prompt = `You are an elite video analyst and transcript creator. A YouTube video titled "${video.title}" does not have native YouTube subtitles.

Video Information:
- Title: ${video.title}
- Channel: ${video.channelName || "Unknown"}
- Duration: approximately ${durationStr} (${Math.round(durationSec)} seconds)
- Description / Context:
${(video.description || "No description provided").slice(0, 3000)}

Your goal is to generate a comprehensive, highly accurate, professional educational reconstruction of this video's spoken dialogue script with timestamps, structured summary, and chapter divisions.

Respond ONLY with valid JSON with this exact schema:
{
  "segments": [
    {
      "start": 0,
      "end": 15,
      "timestamp": "00:00",
      "text": "Spoken dialogue here..."
    }
  ],
  "chapters": [
    {
      "startSeconds": 0,
      "timestamp": "00:00",
      "title": "Introduction",
      "summary": "Chapter description..."
    }
  ],
  "summary": {
    "overview": "3-5 detailed sentences...",
    "mainPoints": ["Point 1", "Point 2", "Point 3", "Point 4", "Point 5", "Point 6"],
    "importantExplanations": ["Explanation 1", "Explanation 2", "Explanation 3"],
    "keyConclusions": ["Conclusion 1", "Conclusion 2", "Conclusion 3"]
  }
}

Guidelines:
- "segments": Generate 15 to 40 chronological script segments spanning across the video from 00:00 to ${durationStr}. Each segment must contain realistic, informative, complete spoken sentences matching the tutorial or topic.
- "chapters": Generate 4 to 10 logical topic chapters with accurate timestamps.
- "summary": Generate an in-depth, structured summary covering the whole video.
- Be highly specific and technical to the actual subject. Return ONLY JSON.`;

  const raw = await callGemini(apiKey, prompt);

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("Could not parse AI script reconstruction.");
  }

  const parsed = JSON.parse(jsonMatch[0]);

  const rawSegments = Array.isArray(parsed.segments) ? parsed.segments : [];
  const segments = rawSegments.map((s: any, idx: number) => {
    const start = typeof s.start === "number" ? s.start : idx * 20;
    const end = typeof s.end === "number" ? s.end : start + 15;
    const ts = s.timestamp || formatTime(start);
    return {
      start,
      end,
      timestamp: ts,
      endTimestamp: formatTime(end),
      text: s.text || "",
    };
  });

  const rawChapters = Array.isArray(parsed.chapters) ? parsed.chapters : [];
  const chapters: AIChapter[] = rawChapters.map((ch: any, idx: number) => ({
    id: `ai-chap-${idx}`,
    startSeconds: typeof ch.startSeconds === "number" ? ch.startSeconds : 0,
    timestamp: ch.timestamp || formatTime(ch.startSeconds || 0),
    title: ch.title || `Chapter ${idx + 1}`,
    summary: ch.summary || "",
  }));

  const summary: AISummary = {
    overview: parsed.summary?.overview || "Video analysis generated by AI.",
    mainPoints: Array.isArray(parsed.summary?.mainPoints) ? parsed.summary.mainPoints : [],
    importantExplanations: Array.isArray(parsed.summary?.importantExplanations) ? parsed.summary.importantExplanations : [],
    keyConclusions: Array.isArray(parsed.summary?.keyConclusions) ? parsed.summary.keyConclusions : [],
  };

  return { segments, summary, chapters };
}
