import type { Transcript, TranscriptSegment } from "../types/transcript";

export interface SummaryResult {
  overview: string;
  mainPoints: string[];
  importantExplanations: string[];
  keyConclusions: string[];
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

export function formatTranscriptAsScript(segments: TranscriptSegment[]): string {
  if (!segments || segments.length === 0) return "";

  const paragraphs: string[] = [];
  let currentParagraph: string[] = [];
  let lastEnd = 0;

  for (const seg of segments) {
    const text = seg.text.trim();
    if (!text) continue;

    const hasLongPause = seg.start - lastEnd > 3.5 && lastEnd > 0;
    const isParagraphLong = currentParagraph.length >= 6;

    if ((hasLongPause || isParagraphLong) && currentParagraph.length > 0) {
      paragraphs.push(currentParagraph.join(" "));
      currentParagraph = [];
    }

    currentParagraph.push(text);
    lastEnd = seg.end !== undefined && seg.end > seg.start ? seg.end : seg.start + 3;
  }

  if (currentParagraph.length > 0) {
    paragraphs.push(currentParagraph.join(" "));
  }

  return paragraphs.join("\n\n");
}

export function formatTranscriptWithTimestamps(segments: TranscriptSegment[]): string {
  function formatTime(sec: number): string {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const rem = s % 60;
    if (h > 0) {
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
    }
    return `${String(m).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
  }

  return segments
    .map((seg) => {
      const startStr = formatTime(seg.start);
      const endStr = seg.end !== undefined && seg.end > seg.start ? ` - ${formatTime(seg.end)}` : "";
      return `[${startStr}${endStr}] ${seg.text}`;
    })
    .join("\n");
}

export function formatSummaryForExport(
  summary: SummaryResult,
  videoTitle = "Video Summary",
): string {
  const sections: string[] = [
    `# ${videoTitle}`,
    "",
    "## Overview",
    summary.overview || "No overview available.",
    "",
    "## Key Points",
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

  const fullTextSegments = segments.filter((s) => s.text && s.text.trim().length > 10);
  const total = fullTextSegments.length;

  const introSlice = fullTextSegments.slice(0, Math.min(6, Math.ceil(total * 0.15)));
  const introText = introSlice.map((s) => s.text).join(" ");
  const overview = cleanSentence(
    introText.slice(0, 350) || `${transcript.title || "This video"} covers key topics outlined in the transcript below.`,
  );

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
    if (mainPoints.length >= 6) break;
    const text = seg.text.trim();
    if (
      text.length > 35 &&
      keyPhrasePatterns.some((p) => p.test(text)) &&
      !mainPoints.some((p) => p.includes(text.slice(0, 20)))
    ) {
      mainPoints.push(cleanSentence(text));
    }
  }

  if (mainPoints.length < 3 && middleSegments.length > 0) {
    const step = Math.max(1, Math.floor(middleSegments.length / 5));
    for (let i = 0; i < middleSegments.length && mainPoints.length < 6; i += step) {
      const text = middleSegments[i].text.trim();
      if (text.length > 25 && !mainPoints.includes(text)) {
        mainPoints.push(cleanSentence(text));
      }
    }
  }

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

  const keyConclusions: string[] = [];
  const endingSlice = fullTextSegments.slice(Math.max(0, Math.floor(total * 0.8)));
  for (const seg of endingSlice) {
    if (keyConclusions.length >= 4) break;
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
