import type { VideoInfo, TranscriptSegment } from "./types/transcript";

interface ExtensionMessage {
  type: string;
  time?: number;
}

interface CaptionTrack {
  baseUrl: string;
  languageCode?: string;
  vssId?: string;
  kind?: string;
  name?: {
    simpleText?: string;
  };
}

let attachedVideo: HTMLVideoElement | null = null;
const playerResponseCache = new Map<string, any>();

function getVideoId(): string | null {
  const url = new URL(window.location.href);

  if (url.pathname !== "/watch") {
    return null;
  }

  return url.searchParams.get("v");
}

function getVideoTitle(): string {
  const selectors = [
    "h1.ytd-watch-metadata",
    "h1.ytd-watch-metadata yt-formatted-string",
    "yt-formatted-string.ytd-video-primary-info-renderer",
    "h1.title",
  ];

  for (const selector of selectors) {
    const element = document.querySelector<HTMLElement>(selector);
    const title = element?.textContent?.trim();

    if (title) {
      return title;
    }
  }

  const pageTitle = document.title
    .replace(/\s*-\s*YouTube\s*$/i, "")
    .trim();

  if (pageTitle && pageTitle.toLowerCase() !== "youtube") {
    return pageTitle;
  }

  return "YouTube Video";
}

function extractJsonObject(source: string, marker: string): unknown {
  const markerIndex = source.indexOf(marker);

  if (markerIndex === -1) {
    return null;
  }

  const equalsIndex = source.indexOf("=", markerIndex + marker.length);

  if (equalsIndex === -1) {
    return null;
  }

  const jsonStart = source.indexOf("{", equalsIndex);

  if (jsonStart === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = jsonStart; index < source.length; index++) {
    const character = source[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (character === "\\") {
        escaped = true;
        continue;
      }

      if (character === '"') {
        inString = false;
      }

      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }

    if (character === "{") {
      depth++;
      continue;
    }

    if (character === "}") {
      depth--;

      if (depth === 0) {
        const json = source.slice(jsonStart, index + 1);

        try {
          return JSON.parse(json);
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

function getPlayerResponseFromMainWorld(): Promise<any | null> {
  return new Promise((resolve) => {
    const eventName = `__yt_companion_${Math.random().toString(36).slice(2)}__`;
    let timeoutId: number;

    const onResponse = (event: Event) => {
      clearTimeout(timeoutId);
      document.removeEventListener(eventName, onResponse);
      try {
        const detail = (event as CustomEvent).detail;
        if (detail) {
          const parsed = typeof detail === "string" ? JSON.parse(detail) : detail;
          resolve(parsed);
          return;
        }
      } catch {}
      resolve(null);
    };

    document.addEventListener(eventName, onResponse, { once: true });

    timeoutId = window.setTimeout(() => {
      document.removeEventListener(eventName, onResponse);
      resolve(null);
    }, 500);

    try {
      const script = document.createElement("script");
      const nonce = document.querySelector("script[nonce]")?.getAttribute("nonce");
      if (nonce) {
        script.setAttribute("nonce", nonce);
      }
      script.textContent = `
        (function() {
          try {
            const player = document.getElementById("movie_player");
            const data = (player && typeof player.getPlayerResponse === "function")
              ? player.getPlayerResponse()
              : window.ytInitialPlayerResponse;
            document.dispatchEvent(new CustomEvent("${eventName}", {
              detail: JSON.stringify(data)
            }));
          } catch(e) {
            document.dispatchEvent(new CustomEvent("${eventName}", { detail: null }));
          }
        })();
      `;
      (document.head || document.documentElement).appendChild(script);
      script.remove();
    } catch {
      clearTimeout(timeoutId);
      document.removeEventListener(eventName, onResponse);
      resolve(null);
    }
  });
}

async function getPlayerResponse(targetVideoId?: string): Promise<any | null> {
  const currentId = targetVideoId || getVideoId();
  if (!currentId) {
    return null;
  }

  if (playerResponseCache.has(currentId)) {
    return playerResponseCache.get(currentId);
  }

  // 1. Try accessing player response from main world (most accurate for SPA & live state)
  try {
    const mainWorldResponse = await getPlayerResponseFromMainWorld();
    if (mainWorldResponse?.videoDetails?.videoId === currentId) {
      playerResponseCache.set(currentId, mainWorldResponse);
      return mainWorldResponse;
    }
  } catch {}

  // 2. Try extracting from current document scripts
  const scripts = Array.from(document.scripts);
  for (const script of scripts) {
    const content = script.textContent ?? "";
    if (!content.includes("ytInitialPlayerResponse")) {
      continue;
    }

    const response = extractJsonObject(content, "ytInitialPlayerResponse") as any;
    if (response?.videoDetails?.videoId === currentId) {
      playerResponseCache.set(currentId, response);
      return response;
    }
  }

  // 3. If single-page navigation occurred or scripts didn't match, fetch the watch page HTML
  try {
    const watchUrl = `https://www.youtube.com/watch?v=${currentId}`;
    const res = await fetch(watchUrl, {
      credentials: "include",
      signal: AbortSignal.timeout(7000),
    });
    if (res.ok) {
      const html = await res.text();
      const response = extractJsonObject(html, "ytInitialPlayerResponse") as any;
      if (response) {
        playerResponseCache.set(currentId, response);
        return response;
      }
    }
  } catch {
    // Network failure or timeout
  }

  return null;
}

function getVideoDuration(): number | null {
  const video = document.querySelector<HTMLVideoElement>("video");
  if (video && Number.isFinite(video.duration) && video.duration > 0) {
    return video.duration;
  }

  const currentId = getVideoId();
  if (currentId && playerResponseCache.has(currentId)) {
    const cached = playerResponseCache.get(currentId);
    const lengthSeconds = Number(cached?.videoDetails?.lengthSeconds);
    if (Number.isFinite(lengthSeconds) && lengthSeconds > 0) {
      return lengthSeconds;
    }
  }

  return null;
}

function getVideoPlaybackState(): { currentTime: number; isPaused: boolean } {
  const video = document.querySelector<HTMLVideoElement>("video");
  return {
    currentTime: video && Number.isFinite(video.currentTime) ? video.currentTime : 0,
    isPaused: video ? video.paused : true,
  };
}

function getVideoInfo(): VideoInfo {
  const { currentTime, isPaused } = getVideoPlaybackState();
  const currentId = getVideoId();
  const cached = currentId ? playerResponseCache.get(currentId) : null;
  const tracks = cached?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

  return {
    id: currentId,
    title: getVideoTitle(),
    url: window.location.href,
    duration: getVideoDuration(),
    currentTime,
    isPaused,
    hasCaptions: Array.isArray(tracks) ? tracks.length > 0 : undefined,
  };
}

async function waitForRealMetadata(timeout = 5000): Promise<VideoInfo> {
  const started = Date.now();

  while (Date.now() - started < timeout) {
    const video = getVideoInfo();

    if (
      video.id &&
      video.title !== "YouTube Video" &&
      video.title !== "(111) YouTube" &&
      typeof video.duration === "number" &&
      video.duration > 0
    ) {
      return video;
    }

    await new Promise((resolve) => window.setTimeout(resolve, 200));
  }

  return getVideoInfo();
}

function attachVideoListeners(): void {
  const video = document.querySelector<HTMLVideoElement>("video");
  if (!video || video === attachedVideo) {
    return;
  }

  attachedVideo = video;

  video.addEventListener("play", () => {
    chrome.runtime
      .sendMessage({
        type: "PLAYBACK_STATE_CHANGED",
        isPaused: false,
        currentTime: video.currentTime,
        duration: video.duration,
      })
      .catch(() => { });
  });

  video.addEventListener("pause", () => {
    chrome.runtime
      .sendMessage({
        type: "PLAYBACK_STATE_CHANGED",
        isPaused: true,
        currentTime: video.currentTime,
        duration: video.duration,
      })
      .catch(() => { });
  });

  video.addEventListener("durationchange", () => {
    notifyVideoChange();
  });

  video.addEventListener("loadedmetadata", () => {
    notifyVideoChange();
  });
}

function notifyVideoChange(): void {
  const videoId = getVideoId();

  if (!videoId) {
    chrome.runtime
      .sendMessage({
        type: "VIDEO_INFO_UPDATED",
        video: getVideoInfo(),
      })
      .catch(() => { });

    return;
  }

  attachVideoListeners();

  // Pre-load player response for fast caption access
  getPlayerResponse(videoId).then(() => {
    waitForRealMetadata()
      .then((video) => {
        chrome.runtime
          .sendMessage({
            type: "VIDEO_INFO_UPDATED",
            video,
          })
          .catch(() => { });
      })
      .catch(() => { });
  }).catch(() => {});
}

async function getCaptionTracks(videoId?: string): Promise<CaptionTrack[]> {
  const playerResponse = await getPlayerResponse(videoId);

  const tracks =
    playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

  if (!Array.isArray(tracks)) {
    return [];
  }

  return tracks.filter(
    (track: unknown): track is CaptionTrack =>
      typeof track === "object" &&
      track !== null &&
      typeof (track as CaptionTrack).baseUrl === "string",
  );
}

function selectCaptionTrack(tracks: CaptionTrack[]): CaptionTrack | null {
  if (tracks.length === 0) {
    return null;
  }

  // 1. English manual captions
  const englishManual = tracks.find(
    (track) =>
      (track.languageCode === "en" || track.languageCode?.startsWith("en-")) &&
      track.kind !== "asr",
  );
  if (englishManual) {
    return englishManual;
  }

  // 2. English auto-generated captions (ASR)
  const englishAsr = tracks.find(
    (track) =>
      track.languageCode === "en" || track.languageCode?.startsWith("en-"),
  );
  if (englishAsr) {
    return englishAsr;
  }

  // 3. Any manual captions in other languages
  const manual = tracks.find((track) => track.kind !== "asr");
  if (manual) {
    return manual;
  }

  // 4. Default fallback track
  return tracks[0];
}

function decodeHtmlEntities(value: string): string {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = value;
  return textarea.value;
}

function formatTimestamp(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(
      seconds,
    ).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function parseTimestampStringToSeconds(ts: string): number {
  const parts = ts.trim().split(":").map((p) => parseInt(p, 10));
  if (parts.length === 3) {
    return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
  }
  if (parts.length === 2) {
    return (parts[0] || 0) * 60 + (parts[1] || 0);
  }
  return parts[0] || 0;
}

function parseJson3Transcript(data: any): TranscriptSegment[] {
  if (!Array.isArray(data?.events)) {
    return [];
  }

  const segments: TranscriptSegment[] = [];
  let lastText = "";

  for (const event of data.events) {
    if (!Array.isArray(event?.segs)) {
      continue;
    }

    const rawText = event.segs
      .map((segment: any) => segment?.utf8 ?? "")
      .join("")
      .replace(/\s+/g, " ")
      .trim();

    const text = decodeHtmlEntities(rawText);
    const startMs = Number(event.tStartMs ?? 0);
    const durationMs = Number(event.dDurationMs ?? 0);

    if (!text || !Number.isFinite(startMs) || text === "\n") {
      continue;
    }

    if (text === lastText) {
      continue;
    }
    lastText = text;

    const start = startMs / 1000;
    const end = durationMs > 0 ? (startMs + durationMs) / 1000 : undefined;

    segments.push({
      start,
      end,
      timestamp: formatTimestamp(startMs),
      endTimestamp:
        end !== undefined ? formatTimestamp(startMs + durationMs) : undefined,
      text,
    });
  }

  return segments;
}

function parseXmlTranscript(xml: string): TranscriptSegment[] {
  const results: TranscriptSegment[] = [];
  let lastText = "";

  // 1. Try regex on legacy <text start="1.23" dur="4.56">text</text>
  const textMatches = Array.from(
    xml.matchAll(/<text\s+[^>]*start="([\d.]+)"(?:\s+[^>]*dur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/gi),
  );

  if (textMatches.length > 0) {
    for (const m of textMatches) {
      const start = parseFloat(m[1]);
      const dur = m[2] ? parseFloat(m[2]) : undefined;
      const raw = m[3].replace(/<[^>]+>/g, "").trim();
      const text = decodeHtmlEntities(raw).replace(/\s+/g, " ").trim();

      if (!Number.isFinite(start) || !text || text === lastText) {
        continue;
      }
      lastText = text;

      const end = dur !== undefined ? start + dur : undefined;
      results.push({
        start,
        end,
        timestamp: formatTimestamp(start * 1000),
        endTimestamp: end !== undefined ? formatTimestamp(end * 1000) : undefined,
        text,
      });
    }

    if (results.length > 0) {
      return results;
    }
  }

  // 2. Try regex on SRV3 <p t="1230" d="4560"><s>text</s></p>
  const pMatches = Array.from(
    xml.matchAll(/<p\s+[^>]*t="(\d+)"(?:\s+[^>]*d="(\d+)")?[^>]*>([\s\S]*?)<\/p>/gi),
  );

  if (pMatches.length > 0) {
    for (const m of pMatches) {
      const startMs = parseInt(m[1], 10);
      const durMs = m[2] ? parseInt(m[2], 10) : undefined;
      const raw = m[3].replace(/<[^>]+>/g, "").trim();
      const text = decodeHtmlEntities(raw).replace(/\s+/g, " ").trim();

      if (!Number.isFinite(startMs) || !text || text === lastText) {
        continue;
      }
      lastText = text;

      const start = startMs / 1000;
      const end = durMs !== undefined ? (startMs + durMs) / 1000 : undefined;
      results.push({
        start,
        end,
        timestamp: formatTimestamp(startMs),
        endTimestamp: end !== undefined ? formatTimestamp(startMs + (durMs || 0)) : undefined,
        text,
      });
    }

    if (results.length > 0) {
      return results;
    }
  }

  // 3. Fallback: DOMParser
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, "text/xml");
    const textEls = Array.from(doc.querySelectorAll("text"));

    if (textEls.length > 0) {
      for (const el of textEls) {
        const start = Number(el.getAttribute("start"));
        const dur = Number(el.getAttribute("dur") ?? 0);
        const text = decodeHtmlEntities(el.textContent ?? "").replace(/\s+/g, " ").trim();

        if (!Number.isFinite(start) || !text || text === lastText) {
          continue;
        }
        lastText = text;

        const end = dur > 0 ? start + dur : undefined;
        results.push({
          start,
          end,
          timestamp: formatTimestamp(start * 1000),
          endTimestamp: end !== undefined ? formatTimestamp(end * 1000) : undefined,
          text,
        });
      }
    } else {
      const pEls = Array.from(doc.querySelectorAll("p"));
      for (const el of pEls) {
        const startMs = Number(el.getAttribute("t"));
        const durMs = Number(el.getAttribute("d") ?? 0);
        const text = decodeHtmlEntities(el.textContent ?? "").replace(/\s+/g, " ").trim();

        if (!Number.isFinite(startMs) || !text || text === lastText) {
          continue;
        }
        lastText = text;

        const start = startMs / 1000;
        const end = durMs > 0 ? (startMs + durMs) / 1000 : undefined;
        results.push({
          start,
          end,
          timestamp: formatTimestamp(startMs),
          endTimestamp: end !== undefined ? formatTimestamp(startMs + durMs) : undefined,
          text,
        });
      }
    }
  } catch {}

  return results;
}

function parseVttTranscript(vtt: string): TranscriptSegment[] {
  const lines = vtt.split(/\r?\n/);
  const segments: TranscriptSegment[] = [];
  let currentStart: number | null = null;
  let currentEnd: number | undefined = undefined;
  let currentText = "";
  let lastText = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const timeMatch = line.match(
      /(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{3})/,
    );

    if (timeMatch) {
      if (currentStart !== null && currentText.trim()) {
        const text = decodeHtmlEntities(currentText.trim()).replace(/\s+/g, " ");
        if (text && text !== lastText) {
          segments.push({
            start: currentStart,
            end: currentEnd,
            timestamp: formatTimestamp(currentStart * 1000),
            endTimestamp: currentEnd !== undefined ? formatTimestamp(currentEnd * 1000) : undefined,
            text,
          });
          lastText = text;
        }
      }

      const sHrs = timeMatch[1] ? parseInt(timeMatch[1], 10) : 0;
      const sMin = parseInt(timeMatch[2], 10);
      const sSec = parseInt(timeMatch[3], 10);
      const sMs = parseInt(timeMatch[4], 10);
      currentStart = sHrs * 3600 + sMin * 60 + sSec + sMs / 1000;

      const eHrs = timeMatch[5] ? parseInt(timeMatch[5], 10) : 0;
      const eMin = parseInt(timeMatch[6], 10);
      const eSec = parseInt(timeMatch[7], 10);
      const eMs = parseInt(timeMatch[8], 10);
      currentEnd = eHrs * 3600 + eMin * 60 + eSec + eMs / 1000;
      currentText = "";
    } else if (
      currentStart !== null &&
      line &&
      !line.startsWith("WEBVTT") &&
      !line.startsWith("NOTE") &&
      !/^\d+$/.test(line)
    ) {
      const clean = line.replace(/<[^>]+>/g, "").trim();
      if (clean) {
        currentText = currentText ? `${currentText} ${clean}` : clean;
      }
    }
  }

  if (currentStart !== null && currentText.trim()) {
    const text = decodeHtmlEntities(currentText.trim()).replace(/\s+/g, " ");
    if (text && text !== lastText) {
      segments.push({
        start: currentStart,
        end: currentEnd,
        timestamp: formatTimestamp(currentStart * 1000),
        endTimestamp: currentEnd !== undefined ? formatTimestamp(currentEnd * 1000) : undefined,
        text,
      });
    }
  }

  return segments;
}

function parseTranscriptBody(body: string): TranscriptSegment[] {
  if (!body || !body.trim()) {
    return [];
  }

  const trimmed = body.trim();

  // 1. JSON3 format
  if (trimmed.startsWith("{")) {
    try {
      const data = JSON.parse(trimmed);
      const segs = parseJson3Transcript(data);
      if (segs.length > 0) {
        return segs;
      }
    } catch {}
  }

  // 2. WebVTT format
  if (trimmed.startsWith("WEBVTT") || trimmed.includes("-->")) {
    const segs = parseVttTranscript(trimmed);
    if (segs.length > 0) {
      return segs;
    }
  }

  // 3. XML format (Legacy or SRV3)
  if (
    trimmed.startsWith("<") ||
    trimmed.includes("<transcript") ||
    trimmed.includes("<timedtext") ||
    trimmed.includes("<p ") ||
    trimmed.includes("<text ")
  ) {
    const segs = parseXmlTranscript(trimmed);
    if (segs.length > 0) {
      return segs;
    }
  }

  return [];
}

function extractSegmentsFromDom(): TranscriptSegment[] {
  const segmentElements = Array.from(
    document.querySelectorAll<HTMLElement>(
      "ytd-transcript-segment-renderer, ytd-transcript-search-panel-renderer ytd-transcript-segment-renderer",
    ),
  );

  if (segmentElements.length === 0) {
    return [];
  }

  const results: TranscriptSegment[] = [];
  let lastText = "";

  for (const el of segmentElements) {
    const tsEl = el.querySelector<HTMLElement>(
      ".segment-timestamp, [class*='segment-timestamp'], .yt-core-attributed-string",
    );
    const textEl = el.querySelector<HTMLElement>(
      ".segment-text, [class*='segment-text']",
    );

    let tsText = (tsEl?.textContent || "").trim();
    const match = tsText.match(/(\d{1,2}:)?\d{2}:\d{2}/);
    if (match) {
      tsText = match[0];
    }

    let text = (textEl?.textContent || "").trim();
    if (!text && tsText) {
      text = (el.textContent || "").replace(tsText, "").trim();
    }

    text = decodeHtmlEntities(text).replace(/\s+/g, " ").trim();
    if (!text || text === lastText) {
      continue;
    }
    lastText = text;

    const start = parseTimestampStringToSeconds(tsText);
    results.push({
      start,
      timestamp: tsText || formatTimestamp(start * 1000),
      text,
    });
  }

  for (let i = 0; i < results.length; i++) {
    if (i < results.length - 1) {
      results[i].end = results[i + 1].start;
      results[i].endTimestamp = results[i + 1].timestamp;
    }
  }

  return results;
}

function findAndClickShowTranscriptButton(): boolean {
  if (document.querySelector("ytd-transcript-segment-renderer")) {
    return true;
  }

  // 1. Direct transcript button in description
  const directBtn = document.querySelector<HTMLElement>(
    "ytd-video-description-transcript-section-renderer button, " +
    "ytd-video-description-transcript-section-renderer ytd-button-renderer, " +
    "button[aria-label*='transcript' i], " +
    "button[aria-label*='Transcript' i]",
  );
  if (directBtn) {
    directBtn.click();
    return true;
  }

  // 2. If description is collapsed, click "more" / expand
  const expandBtn = document.querySelector<HTMLElement>(
    "#expand, #description-inline-expander #expand, tp-yt-paper-button#expand",
  );
  if (expandBtn && expandBtn.offsetParent !== null) {
    try {
      expandBtn.click();
    } catch {}
  }

  // 3. Search buttons in description
  const description = document.querySelector("#description, #description-inline-expander, ytd-watch-metadata");
  if (description) {
    const buttons = Array.from(
      description.querySelectorAll<HTMLElement>("button, ytd-button-renderer, tp-yt-paper-button"),
    );
    for (const btn of buttons) {
      const text = (btn.getAttribute("aria-label") || btn.textContent || "").toLowerCase();
      if (text.includes("transcript")) {
        btn.click();
        return true;
      }
    }
  }

  // 4. Try the "More actions" menu under the video
  const moreActionsBtn = document.querySelector<HTMLElement>(
    "#actions button[aria-label*='More' i], #actions-inner button[aria-label*='More' i]",
  );
  if (moreActionsBtn) {
    try {
      moreActionsBtn.click();
      window.setTimeout(() => {
        const items = Array.from(
          document.querySelectorAll<HTMLElement>("ytd-menu-service-item-renderer, tp-yt-paper-item"),
        );
        for (const item of items) {
          if ((item.textContent || "").toLowerCase().includes("transcript")) {
            item.click();
            break;
          }
        }
      }, 100);
    } catch {}
  }

  return false;
}

async function extractTranscriptFromDom(timeoutMs = 2500): Promise<TranscriptSegment[]> {
  let segments = extractSegmentsFromDom();
  if (segments.length > 0) {
    return segments;
  }

  findAndClickShowTranscriptButton();

  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    await new Promise((resolve) => window.setTimeout(resolve, 150));
    segments = extractSegmentsFromDom();
    if (segments.length > 0) {
      return segments;
    }
  }

  return [];
}

async function fetchCaptionTrack(
  track: CaptionTrack,
): Promise<TranscriptSegment[]> {
  const rawBase = track.baseUrl.replace(/&amp;/g, "&");

  // Create list of URLs to try:
  // 1. Raw unmodified baseUrl (signature is valid for this exact URL)
  // 2. fmt=srv3 (XML v3 format)
  // 3. fmt=vtt (WebVTT format)
  // 4. fmt=json3 (JSON3 format)
  const variants: string[] = [rawBase];

  try {
    const uSrv = new URL(rawBase, window.location.origin);
    if (!uSrv.searchParams.has("fmt")) {
      uSrv.searchParams.set("fmt", "srv3");
      variants.push(uSrv.toString());
    }
  } catch {}

  try {
    const uVtt = new URL(rawBase, window.location.origin);
    if (!uVtt.searchParams.has("fmt")) {
      uVtt.searchParams.set("fmt", "vtt");
      variants.push(uVtt.toString());
    }
  } catch {}

  try {
    const uJson = new URL(rawBase, window.location.origin);
    if (!uJson.searchParams.has("fmt")) {
      uJson.searchParams.set("fmt", "json3");
      variants.push(uJson.toString());
    }
  } catch {}

  for (const url of variants) {
    try {
      const response = await fetch(url, {
        credentials: "include",
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        continue;
      }

      const body = await response.text();
      if (!body || !body.trim()) {
        continue;
      }

      const segments = parseTranscriptBody(body);
      if (segments.length > 0) {
        return segments;
      }
    } catch {
      // Try next variant
    }
  }

  // Fallback: try rawBase with credentials: "omit" in case cookies interfered
  try {
    const response = await fetch(rawBase, {
      credentials: "omit",
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      const body = await response.text();
      if (body && body.trim()) {
        const segments = parseTranscriptBody(body);
        if (segments.length > 0) {
          return segments;
        }
      }
    }
  } catch {}

  throw new Error("YouTube returned an empty caption track.");
}

async function fetchTranscript(): Promise<{ segments: TranscriptSegment[]; language?: string }> {
  const videoId = getVideoId();

  if (!videoId) {
    throw new Error("No YouTube video detected.");
  }

  // Tier 1: Try YouTube native DOM transcript (fast, already authenticated, 100% formatted)
  try {
    const domSegments = await extractTranscriptFromDom(1000);
    if (domSegments.length > 0) {
      return {
        segments: domSegments,
        language: "en",
      };
    }
  } catch {
    // Continue to network fetching
  }

  // Tier 2: Caption tracks from player response
  const tracks = await getCaptionTracks(videoId);

  if (tracks.length > 0) {
    const preferredTrack = selectCaptionTrack(tracks);
    const orderedTracks = preferredTrack
      ? [preferredTrack, ...tracks.filter((track) => track !== preferredTrack)]
      : tracks;

    for (const track of orderedTracks) {
      try {
        const segments = await fetchCaptionTrack(track);
        if (segments.length > 0) {
          return {
            segments,
            language: track.languageCode || track.name?.simpleText || "en",
          };
        }
      } catch {
        continue;
      }
    }
  }

  // Tier 3: DOM transcript retry with longer timeout (in case the panel took time to load from YouTube's server)
  try {
    const domSegments = await extractTranscriptFromDom(2500);
    if (domSegments.length > 0) {
      return {
        segments: domSegments,
        language: "en",
      };
    }
  } catch {
    // Continue to error
  }

  if (tracks.length === 0) {
    throw new Error(
      "YouTube captions are unavailable for this video. Captions or transcripts have not been provided by the creator or YouTube for this video.",
    );
  }

  throw new Error(
    "Could not retrieve transcript from YouTube captions or page transcript. Please make sure transcripts/captions are enabled for this video.",
  );
}

function seekVideo(time: number): boolean {
  const video = document.querySelector<HTMLVideoElement>("video");

  if (!video || !Number.isFinite(time) || time < 0) {
    return false;
  }

  video.currentTime = time;

  // Also seek YouTube custom player if exposed
  try {
    const moviePlayer = document.getElementById("movie_player") as any;
    if (typeof moviePlayer?.seekTo === "function") {
      moviePlayer.seekTo(time, true);
    }
  } catch {
    // Ignore
  }

  return true;
}

chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, _sender, sendResponse) => {
    if (message.type === "GET_VIDEO_INFO") {
      sendResponse({
        success: true,
        video: getVideoInfo(),
      });

      return false;
    }

    if (message.type === "SEEK_VIDEO") {
      if (typeof message.time !== "number") {
        sendResponse({
          success: false,
          error: "Invalid seek time.",
        });

        return false;
      }

      const success = seekVideo(message.time);

      sendResponse({
        success,
        error: success ? undefined : "YouTube video player was not found.",
      });

      return false;
    }

    if (message.type === "GET_TRANSCRIPT") {
      fetchTranscript()
        .then(({ segments, language }) => {
          const video = getVideoInfo();

          sendResponse({
            success: true,
            transcript: {
              videoId: video.id,
              language,
              duration: video.duration,
              source: "youtube_captions",
              segments,
            },
          });
        })
        .catch((error: unknown) => {
          sendResponse({
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "YouTube captions are unavailable for this video. A full fallback transcription source is not currently available.",
          });
        });

      return true;
    }

    return false;
  },
);

let lastVideoId = getVideoId();
let lastUrl = window.location.href;

function detectNavigation(): void {
  const currentUrl = window.location.href;
  const currentVideoId = getVideoId();

  if (currentUrl === lastUrl && currentVideoId === lastVideoId) {
    return;
  }

  lastUrl = currentUrl;
  lastVideoId = currentVideoId;

  window.setTimeout(() => {
    notifyVideoChange();
  }, 400);
}

document.addEventListener("yt-navigate-finish", detectNavigation);
window.addEventListener("popstate", detectNavigation);
window.setTimeout(notifyVideoChange, 1000);