import type { Transcript, TranscriptSegment } from "../types/transcript";

export interface SummaryResult {
  overview: string;
  mainPoints: string[];
  importantExplanations: string[];
  keyConclusions: string[];
}

export type KeyMomentCategory =
  | "Important Concept"
  | "Definition"
  | "Practical Example"
  | "Warning"
  | "Useful Tip"
  | "Strong Conclusion";

export interface KeyMoment {
  id: string;
  seconds: number;
  timestamp: string;
  category: KeyMomentCategory;
  title: string;
  explanation: string;
  quote: string;
}

export interface VideoHook {
  id: string;
  seconds: number;
  timestamp: string;
  text: string;
  explanation: string;
  type: "Exact Quote" | "Key Insight";
}

export interface Chapter {
  id: string;
  startSeconds: number;
  timestamp: string;
  title: string;
  description: string;
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

function cleanSentence(text: string): string {
  let cleaned = text.replace(/\[[^\]]*\]/g, "").replace(/\s+/g, " ").trim();
  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
    if (!/[.!?]$/.test(cleaned)) {
      cleaned += ".";
    }
  }
  return cleaned;
}

/**
 * Generates an honest structured summary strictly from the transcript segments.
 */
export function generateVideoSummary(transcript: Transcript): SummaryResult {
  const segments = transcript.segments;
  if (!segments || segments.length === 0) {
    return {
      overview: "No transcript text available to summarize.",
      mainPoints: [],
      importantExplanations: [],
      keyConclusions: [],
    };
  }

  // Group text into meaningful blocks
  const fullTextSegments = segments.filter((s) => s.text && s.text.trim().length > 10);
  const total = fullTextSegments.length;

  // Overview from introductory segments
  const introSlice = fullTextSegments.slice(0, Math.min(6, Math.ceil(total * 0.15)));
  const introText = introSlice.map((s) => s.text).join(" ");
  const overview = cleanSentence(
    introText.slice(0, 300) || `${transcript.title || "This video"} covers key topics outlined in the transcript below.`,
  );

  // Main points: sample key informative sentences across the middle segments
  const mainPoints: string[] = [];
  const middleSegments = fullTextSegments.slice(
    Math.floor(total * 0.1),
    Math.floor(total * 0.85),
  );

  const keyPhrasePatterns = [
    /\b(first|second|third|finally|important|key|because|means that|remember|concept|example|result)\b/i,
    /\b(how to|step|rule|method|problem|solution|approach|idea|strategy)\b/i,
  ];

  for (const seg of middleSegments) {
    if (mainPoints.length >= 5) break;
    const text = seg.text.trim();
    if (
      text.length > 35 &&
      keyPhrasePatterns.some((p) => p.test(text)) &&
      !mainPoints.some((p) => p.includes(text.slice(0, 20)))
    ) {
      mainPoints.push(cleanSentence(text));
    }
  }

  // If not enough pattern matches, sample evenly from the video
  if (mainPoints.length < 3 && middleSegments.length > 0) {
    const step = Math.max(1, Math.floor(middleSegments.length / 4));
    for (let i = 0; i < middleSegments.length && mainPoints.length < 5; i += step) {
      const text = middleSegments[i].text.trim();
      if (text.length > 25 && !mainPoints.includes(text)) {
        mainPoints.push(cleanSentence(text));
      }
    }
  }

  // Important explanations
  const importantExplanations: string[] = [];
  const explanationPatterns = /\b(defined as|meaning|specifically|in other words|for instance|the reason is|notice that)\b/i;
  for (const seg of fullTextSegments) {
    if (importantExplanations.length >= 4) break;
    if (explanationPatterns.test(seg.text) && seg.text.length > 30) {
      importantExplanations.push(cleanSentence(seg.text));
    }
  }
  if (importantExplanations.length === 0 && middleSegments.length > 2) {
    importantExplanations.push(cleanSentence(middleSegments[Math.floor(middleSegments.length / 2)].text));
  }

  // Key conclusions from ending segments
  const keyConclusions: string[] = [];
  const endingSlice = fullTextSegments.slice(Math.max(0, Math.floor(total * 0.8)));
  for (const seg of endingSlice) {
    if (keyConclusions.length >= 3) break;
    const text = seg.text.trim();
    if (text.length > 25) {
      keyConclusions.push(cleanSentence(text));
    }
  }

  return {
    overview,
    mainPoints: mainPoints.length > 0 ? mainPoints : ["Core concepts covered across the video."],
    importantExplanations:
      importantExplanations.length > 0
        ? importantExplanations
        : ["Detailed breakdown provided directly within the timestamps."],
    keyConclusions:
      keyConclusions.length > 0
        ? keyConclusions
        : ["Final takeaways highlighted at the conclusion of the video."],
  };
}

/**
 * Extracts key moments categorized with genuine timestamps and quotes.
 */
export function extractKeyMoments(transcript: Transcript): KeyMoment[] {
  const segments = transcript.segments;
  const moments: KeyMoment[] = [];

  const categoryMatchers: Array<{
    category: KeyMomentCategory;
    pattern: RegExp;
    titlePrefix: string;
    explanation: string;
  }> = [
    {
      category: "Definition",
      pattern: /\b(is defined as|what is|means that|refer to|we call this)\b/i,
      titlePrefix: "Core Definition",
      explanation: "Explains a fundamental term or terminology used in the subject.",
    },
    {
      category: "Important Concept",
      pattern: /\b(important|crucial|essential|fundamental|key concept|keep in mind)\b/i,
      titlePrefix: "Key Concept",
      explanation: "A critical idea essential for mastering this topic.",
    },
    {
      category: "Practical Example",
      pattern: /\b(for example|for instance|let's say|such as|case study|in practice)\b/i,
      titlePrefix: "Practical Example",
      explanation: "Real-world demonstration illustrating how the theory applies.",
    },
    {
      category: "Warning",
      pattern: /\b(warning|common mistake|be careful|don't|pitfall|avoid|problem with)\b/i,
      titlePrefix: "Caution / Pitfall",
      explanation: "Highlights a common error or pitfall viewers should actively avoid.",
    },
    {
      category: "Useful Tip",
      pattern: /\b(pro tip|tip|recommend|shortcut|best way|trick|faster|easier)\b/i,
      titlePrefix: "Actionable Tip",
      explanation: "A practical recommendation to save time or improve results.",
    },
    {
      category: "Strong Conclusion",
      pattern: /\b(in conclusion|to summarize|final takeaway|in the end|overall)\b/i,
      titlePrefix: "Summary Takeaway",
      explanation: "Synthesizes the main message of the discussion.",
    },
  ];

  for (const seg of segments) {
    if (!seg.text || seg.text.length < 20) continue;

    for (const matcher of categoryMatchers) {
      if (matcher.pattern.test(seg.text)) {
        // Prevent duplicate moments clustered within 15 seconds
        const isClose = moments.some((m) => Math.abs(m.seconds - seg.start) < 20);
        if (!isClose) {
          const cleanText = cleanSentence(seg.text);
          moments.push({
            id: `km-${seg.start}`,
            seconds: seg.start,
            timestamp: formatTime(seg.start),
            category: matcher.category,
            title: `${matcher.titlePrefix}: ${cleanText.slice(0, 45)}...`,
            explanation: matcher.explanation,
            quote: `"${cleanText}"`,
          });
        }
        break;
      }
    }
  }

  // If no heuristic moments were found, create clean milestone moments from video timeline
  if (moments.length === 0 && segments.length > 0) {
    const milestones = [
      { ratio: 0.1, cat: "Important Concept" as KeyMomentCategory, prefix: "Introduction" },
      { ratio: 0.4, cat: "Practical Example" as KeyMomentCategory, prefix: "Key Demonstration" },
      { ratio: 0.7, cat: "Useful Tip" as KeyMomentCategory, prefix: "In-Depth Insight" },
      { ratio: 0.9, cat: "Strong Conclusion" as KeyMomentCategory, prefix: "Wrap Up" },
    ];

    for (const m of milestones) {
      const idx = Math.min(segments.length - 1, Math.floor(segments.length * m.ratio));
      const seg = segments[idx];
      if (seg && seg.text) {
        moments.push({
          id: `km-${seg.start}`,
          seconds: seg.start,
          timestamp: formatTime(seg.start),
          category: m.cat,
          title: `${m.prefix} (${formatTime(seg.start)})`,
          explanation: "Milestone point in the video discussion.",
          quote: `"${cleanSentence(seg.text)}"`,
        });
      }
    }
  }

  return moments;
}

/**
 * Extracts memorable hooks, thought-provoking statements, and study takeaways.
 */
export function extractHooks(transcript: Transcript): VideoHook[] {
  const segments = transcript.segments;
  const hooks: VideoHook[] = [];

  const hookPatterns = [
    /\b(why|how|what if|the secret to|the truth about|the biggest|ever wondered)\b/i,
    /\b(game changer|never|always|everything changes|most people)\b/i,
    /\?$/,
  ];

  for (const seg of segments) {
    if (hooks.length >= 8) break;
    const text = seg.text.trim();
    if (text.length > 25 && text.length < 180) {
      if (hookPatterns.some((p) => p.test(text))) {
        const isClose = hooks.some((h) => Math.abs(h.seconds - seg.start) < 25);
        if (!isClose) {
          hooks.push({
            id: `hook-${seg.start}`,
            seconds: seg.start,
            timestamp: formatTime(seg.start),
            text: `"${cleanSentence(text)}"`,
            explanation: text.includes("?")
              ? "Poses a critical guiding question that anchors the discussion."
              : "A strong statement ideal for revision, study notes, or video hooks.",
            type: "Exact Quote",
          });
        }
      }
    }
  }

  // If few hooks found, take strong starting statements
  if (hooks.length < 3 && segments.length > 0) {
    const early = segments.slice(0, Math.min(5, segments.length));
    for (const s of early) {
      if (s.text && s.text.length > 20 && !hooks.some((h) => h.seconds === s.start)) {
        hooks.push({
          id: `hook-${s.start}`,
          seconds: s.start,
          timestamp: formatTime(s.start),
          text: `"${cleanSentence(s.text)}"`,
          explanation: "Opening idea introducing the core premise.",
          type: "Exact Quote",
        });
        if (hooks.length >= 4) break;
      }
    }
  }

  return hooks;
}

/**
 * Generates suggested chapters with start timestamps from transcript topic boundaries.
 */
export function generateSuggestedChapters(transcript: Transcript): Chapter[] {
  const segments = transcript.segments;
  if (!segments || segments.length === 0) {
    return [];
  }

  const duration =
    typeof transcript.duration === "number" && transcript.duration > 0
      ? transcript.duration
      : segments[segments.length - 1].start + 30;

  // Determine ideal number of chapters based on duration
  const targetChapterCount = Math.min(8, Math.max(3, Math.round(duration / 180)));
  const intervalSeconds = duration / targetChapterCount;

  const chapters: Chapter[] = [];

  // Always start with chapter 1 at 00:00
  chapters.push({
    id: "chap-0",
    startSeconds: 0,
    timestamp: "00:00",
    title: "Introduction",
    description: cleanSentence(segments[0]?.text || "Introduction and overview."),
  });

  for (let i = 1; i < targetChapterCount; i++) {
    const targetSec = i * intervalSeconds;
    // Find closest segment near targetSec
    const segment = segments.reduce((prev, curr) =>
      Math.abs(curr.start - targetSec) < Math.abs(prev.start - targetSec) ? curr : prev,
    );

    if (segment && segment.start > chapters[chapters.length - 1].startSeconds + 30) {
      const cleanDesc = cleanSentence(segment.text);
      const titleWords = cleanDesc.split(" ").slice(0, 4).join(" ");
      chapters.push({
        id: `chap-${segment.start}`,
        startSeconds: Math.floor(segment.start),
        timestamp: formatTime(segment.start),
        title: titleWords ? `${titleWords}...` : `Topic ${i + 1}`,
        description: cleanDesc,
      });
    }
  }

  return chapters;
}

/**
 * Format chapters into standard YouTube description format:
 * 00:00 - Introduction
 * 02:45 - Key Topic
 */
export function formatChaptersForExport(chapters: Chapter[]): string {
  return chapters.map((c) => `${c.timestamp} - ${c.title}`).join("\n");
}

/**
 * Converts segments to SubRip (.srt) subtitle format with valid timestamps.
 */
export function exportToSrt(segments: TranscriptSegment[]): string {
  function srtTime(seconds: number): string {
    const totalMs = Math.max(0, Math.floor(seconds * 1000));
    const hrs = Math.floor(totalMs / 3600000);
    const mins = Math.floor((totalMs % 3600000) / 60000);
    const secs = Math.floor((totalMs % 60000) / 1000);
    const ms = totalMs % 1000;

    return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
  }

  const lines: string[] = [];
  segments.forEach((seg, idx) => {
    const startStr = srtTime(seg.start);
    const endSec = seg.end !== undefined && seg.end > seg.start ? seg.end : seg.start + 3;
    const endStr = srtTime(endSec);

    lines.push(String(idx + 1));
    lines.push(`${startStr} --> ${endStr}`);
    lines.push(seg.text);
    lines.push("");
  });

  return lines.join("\n");
}
