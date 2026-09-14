import type { VideoInfo, TranscriptSegment } from "./types/transcript";

(function injectHideTranscriptPanelStyle(): void {
  const existing = document.getElementById("__yt_hide_native_transcript__");
  if (existing) return;
  const style = document.createElement("style");
  style.id = "__yt_hide_native_transcript__";
  style.textContent = `
    ytd-engagement-panel-section-list-renderer[target-id*="transcript"],
    ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"],
    ytd-engagement-panel-section-list-renderer:has(ytd-transcript-renderer),
    ytd-engagement-panel-section-list-renderer:has(ytd-transcript-search-panel-renderer),
    ytd-transcript-renderer,
    ytd-transcript-search-panel-renderer,
    ytd-engagement-panel-section-list-renderer[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"][target-id*="transcript"],
    #panels ytd-engagement-panel-section-list-renderer[target-id*="transcript"] {
      display: none !important;
      visibility: hidden !important;
      width: 0 !important;
      height: 0 !important;
      max-height: 0 !important;
      max-width: 0 !important;
      opacity: 0 !important;
      pointer-events: none !important;
      position: absolute !important;
      top: -9999px !important;
      left: -9999px !important;
      z-index: -9999 !important;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
})();

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

function getVideoDescription(): string {
  const descEl = document.querySelector<HTMLElement>(
    "#description-inline-expander, ytd-watch-metadata #description, #description",
  );
  return descEl?.textContent?.trim() || "";
}

function getVideoChannel(): string {
  const channelEl = document.querySelector<HTMLElement>(
    "#channel-name, ytd-channel-name, #owner #text, #upload-info #channel-name",
  );
  return channelEl?.textContent?.trim() || "";
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

  try {
    const mainWorldResponse = await getPlayerResponseFromMainWorld();
    if (mainWorldResponse?.videoDetails?.videoId === currentId) {
      playerResponseCache.set(currentId, mainWorldResponse);
      return mainWorldResponse;
    }
  } catch {}

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
  } catch {}

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
    description: getVideoDescription(),
    channelName: getVideoChannel(),
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
      .catch(() => {});
  });

  video.addEventListener("pause", () => {
    chrome.runtime
      .sendMessage({
        type: "PLAYBACK_STATE_CHANGED",
        isPaused: true,
        currentTime: video.currentTime,
        duration: video.duration,
      })
      .catch(() => {});
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
      .catch(() => {});

    return;
  }

  attachVideoListeners();

  getPlayerResponse(videoId)
    .then(() => {
      waitForRealMetadata()
        .then((video) => {
          chrome.runtime
            .sendMessage({
              type: "VIDEO_INFO_UPDATED",
              video,
            })
            .catch(() => {});
        })
        .catch(() => {});
    })
    .catch(() => {});
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

  const englishManual = tracks.find(
    (track) =>
      (track.languageCode === "en" || track.languageCode?.startsWith("en-")) &&
      track.kind !== "asr",
  );
  if (englishManual) {
    return englishManual;
  }

  const englishAsr = tracks.find(
    (track) =>
      track.languageCode === "en" || track.languageCode?.startsWith("en-"),
  );
  if (englishAsr) {
    return englishAsr;
  }

  const manual = tracks.find((track) => track.kind !== "asr");
  if (manual) {
    return manual;
  }

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

  const textMatches = Array.from(
    xml.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/gi),
  );

  if (textMatches.length > 0) {
    for (const m of textMatches) {
      const attrs = m[1];
      const startMatch = attrs.match(/\bstart="([\d.]+)"/i);
      const durMatch = attrs.match(/\bdur="([\d.]+)"/i);
      if (!startMatch) continue;

      const start = parseFloat(startMatch[1]);
      const dur = durMatch ? parseFloat(durMatch[1]) : undefined;
      const raw = m[2].replace(/<[^>]+>/g, "").trim();
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

  const pMatches = Array.from(
    xml.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi),
  );

  if (pMatches.length > 0) {
    for (const m of pMatches) {
      const attrs = m[1];
      const tMatch = attrs.match(/\bt="(\d+)"/i);
      const dMatch = attrs.match(/\bd="(\d+)"/i);
      if (!tMatch) continue;

      const startMs = parseInt(tMatch[1], 10);
      const durMs = dMatch ? parseInt(dMatch[1], 10) : undefined;
      const raw = m[2].replace(/<[^>]+>/g, "").trim();
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

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, "text/xml");
    const textEls = Array.from(doc.getElementsByTagName("text"));

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
      const pEls = Array.from(doc.getElementsByTagName("p"));
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

  if (trimmed.startsWith("{")) {
    try {
      const data = JSON.parse(trimmed);
      const segs = parseJson3Transcript(data);
      if (segs.length > 0) {
        return segs;
      }
    } catch {}
  }

  if (trimmed.startsWith("WEBVTT") || trimmed.includes("-->")) {
    const segs = parseVttTranscript(trimmed);
    if (segs.length > 0) {
      return segs;
    }
  }

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

async function fetchCaptionText(url: string): Promise<string | null> {
  try {
    const bgRes = (await chrome.runtime.sendMessage({
      type: "FETCH_CAPTION_URL",
      url,
    })) as { success?: boolean; text?: string };
    if (bgRes?.success && bgRes.text && bgRes.text.trim()) {
      return bgRes.text;
    }
  } catch {}

  try {
    const res = await fetch(url);
    if (res.ok) {
      const text = await res.text();
      if (text && text.trim()) {
        return text;
      }
    }
  } catch {}

  return null;
}

function closeTranscriptPanel(): void {
  try {
    const closeBtn = document.querySelector<HTMLElement>(
      'ytd-engagement-panel-section-list-renderer[target-id*="transcript"] #visibility-button button, ' +
      'ytd-engagement-panel-section-list-renderer[target-id*="transcript"] button[aria-label*="Close" i], ' +
      'ytd-engagement-panel-section-list-renderer[target-id*="transcript"] [id="visibility-button"]'
    );
    if (closeBtn) {
      closeBtn.click();
    }
    const panels = document.querySelectorAll<HTMLElement>(
      'ytd-engagement-panel-section-list-renderer[target-id*="transcript"]'
    );
    panels.forEach((p) => {
      p.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN");
      p.style.setProperty("display", "none", "important");
    });
  } catch {}
}

const panelObserver = new MutationObserver(() => {
  const openPanels = document.querySelectorAll<HTMLElement>(
    'ytd-engagement-panel-section-list-renderer[target-id*="transcript"][visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"], ' +
    'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]'
  );
  if (openPanels.length > 0) {
    closeTranscriptPanel();
  }
});
panelObserver.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["visibility"],
});

function extractSegmentsFromDom(): TranscriptSegment[] {
  const segmentElements = Array.from(
    document.querySelectorAll<HTMLElement>(
      "ytd-transcript-segment-renderer, ytd-transcript-search-panel-renderer ytd-transcript-segment-renderer, .ytd-transcript-segment-list-renderer ytd-transcript-segment-renderer, [class*='transcript-segment']"
    ),
  );

  if (segmentElements.length === 0) {
    return [];
  }

  const results: TranscriptSegment[] = [];
  let lastText = "";

  for (const el of segmentElements) {
    const fullText = el.textContent || "";
    const timeMatch = fullText.match(/(\d{1,2}:)?\d{2}:\d{2}/);
    let tsText = timeMatch ? timeMatch[0] : "";

    const tsEl = el.querySelector<HTMLElement>(
      ".segment-timestamp, [class*='segment-timestamp'], [class*='timestamp'], .yt-core-attributed-string, yt-formatted-string"
    );
    if (!tsText && tsEl?.textContent) {
      tsText = tsEl.textContent.trim();
    }

    const textEl = el.querySelector<HTMLElement>(
      ".segment-text, [class*='segment-text'], yt-formatted-string.segment-text, .yt-core-attributed-string--link-inherit-color"
    );

    let text = textEl?.textContent?.trim() || "";
    if (!text && tsText) {
      text = fullText.replace(tsText, "").trim();
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

function expandDescription(): void {
  const expandBtn = document.querySelector<HTMLElement>(
    "#expand, #description-inline-expander #expand, tp-yt-paper-button#expand, [id='expand']",
  );
  if (expandBtn && expandBtn.offsetParent !== null) {
    try {
      expandBtn.click();
    } catch {}
  }

  const desc = document.querySelector<HTMLElement>(
    "#description, #description-inline-expander, ytd-watch-metadata #description",
  );
  if (desc && desc.getAttribute("collapsed") !== null) {
    try {
      desc.click();
    } catch {}
  }
}

function findShowTranscriptButton(): HTMLElement | null {
  const directBtn = document.querySelector<HTMLElement>(
    "ytd-video-description-transcript-section-renderer button, " +
    "ytd-video-description-transcript-section-renderer ytd-button-renderer, " +
    "ytd-video-description-transcript-section-renderer tp-yt-paper-button, " +
    "ytd-video-description-transcript-section-renderer",
  );
  if (directBtn) {
    const innerBtn = directBtn.querySelector<HTMLElement>("button") || directBtn;
    return innerBtn;
  }

  const ariaBtn = document.querySelector<HTMLElement>(
    "button[aria-label*='transcript' i], button[aria-label*='Transcript' i]",
  );
  if (ariaBtn) {
    return ariaBtn;
  }

  const description = document.querySelector("#description, #description-inline-expander, ytd-watch-metadata");
  if (description) {
    const buttons = Array.from(
      description.querySelectorAll<HTMLElement>("button, ytd-button-renderer, tp-yt-paper-button, [role='button']"),
    );
    for (const btn of buttons) {
      const text = (btn.getAttribute("aria-label") || btn.textContent || "").toLowerCase();
      if (text.includes("transcript")) {
        return btn;
      }
    }
  }

  const moreActionsBtn = document.querySelector<HTMLElement>(
    "#actions button[aria-label*='More' i], #actions-inner button[aria-label*='More' i]",
  );
  if (moreActionsBtn) {
    try {
      moreActionsBtn.click();
      const items = Array.from(
        document.querySelectorAll<HTMLElement>("ytd-menu-service-item-renderer, tp-yt-paper-item, ytd-menu-navigation-item-renderer"),
      );
      for (const item of items) {
        if ((item.textContent || "").toLowerCase().includes("transcript")) {
          return item;
        }
      }
    } catch {}
  }

  return null;
}

async function extractTranscriptFromDom(timeoutMs = 3500): Promise<TranscriptSegment[]> {
  try {
    let segments = extractSegmentsFromDom();
    if (segments.length > 0) {
      closeTranscriptPanel();
      return segments;
    }

    expandDescription();

    const startTime = Date.now();
    let clicked = false;

    while (Date.now() - startTime < timeoutMs) {
      segments = extractSegmentsFromDom();
      if (segments.length > 0) {
        closeTranscriptPanel();
        return segments;
      }

      if (!clicked) {
        const btn = findShowTranscriptButton();
        if (btn) {
          btn.click();
          clicked = true;
        } else {
          expandDescription();
        }
      }

      await new Promise((resolve) => window.setTimeout(resolve, 200));
    }

    const finalSegments = extractSegmentsFromDom();
    closeTranscriptPanel();
    return finalSegments;
  } catch {
    closeTranscriptPanel();
    return [];
  }
}

async function fetchCaptionTrack(
  track: CaptionTrack,
): Promise<TranscriptSegment[]> {
  const rawBase = track.baseUrl.replace(/&amp;/g, "&");

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
    const text = await fetchCaptionText(url);
    if (text) {
      const segments = parseTranscriptBody(text);
      if (segments.length > 0) {
        return segments;
      }
    }
  }

  throw new Error("YouTube returned an empty caption track.");
}

async function fetchTranscript(): Promise<{ segments: TranscriptSegment[]; language?: string }> {
  const videoId = getVideoId();

  if (!videoId) {
    throw new Error("No YouTube video detected.");
  }

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

  try {
    const domSegments = await extractTranscriptFromDom(3500);
    if (domSegments.length > 0) {
      return {
        segments: domSegments,
        language: "en",
      };
    }
  } catch {}

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

  try {
    const moviePlayer = document.getElementById("movie_player") as any;
    if (typeof moviePlayer?.seekTo === "function") {
      moviePlayer.seekTo(time, true);
    }
  } catch {}

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