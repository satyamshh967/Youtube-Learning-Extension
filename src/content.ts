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

async function getPlayerResponse(targetVideoId?: string): Promise<any | null> {
  const currentId = targetVideoId || getVideoId();
  if (!currentId) {
    return null;
  }

  if (playerResponseCache.has(currentId)) {
    return playerResponseCache.get(currentId);
  }

  // 1. Try extracting from current document scripts
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

  // 2. If single-page navigation occurred or scripts didn't match, fetch the watch page HTML
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

    // Avoid duplicate lines common in auto-generated captions
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
  const parser = new DOMParser();
  const document = parser.parseFromString(xml, "text/xml");
  const elements = Array.from(document.querySelectorAll("text"));
  const results: TranscriptSegment[] = [];
  let lastText = "";

  for (const element of elements) {
    const start = Number(element.getAttribute("start"));
    const dur = Number(element.getAttribute("dur") ?? 0);

    const text = decodeHtmlEntities(element.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim();

    if (!Number.isFinite(start) || !text) {
      continue;
    }

    if (text === lastText) {
      continue;
    }
    lastText = text;

    const end = dur > 0 ? start + dur : undefined;

    results.push({
      start,
      end,
      timestamp: formatTimestamp(start * 1000),
      endTimestamp:
        end !== undefined ? formatTimestamp(end * 1000) : undefined,
      text,
    });
  }

  return results;
}

async function fetchCaptionTrack(
  track: CaptionTrack,
): Promise<TranscriptSegment[]> {
  const url = new URL(track.baseUrl, window.location.origin);
  url.searchParams.set("fmt", "json3");

  const response = await fetch(url.toString(), {
    credentials: "include",
    signal: AbortSignal.timeout(7000),
  });

  if (!response.ok) {
    throw new Error(
      `YouTube caption request failed with HTTP ${response.status}.`,
    );
  }

  const body = await response.text();

  if (!body.trim()) {
    throw new Error("YouTube returned an empty caption track.");
  }

  try {
    const data = JSON.parse(body);
    const segments = parseJson3Transcript(data);
    if (segments.length > 0) {
      return segments;
    }
  } catch {
    const segments = parseXmlTranscript(body);
    if (segments.length > 0) {
      return segments;
    }
  }

  throw new Error("YouTube returned no transcript segments.");
}

async function fetchTranscript(): Promise<{ segments: TranscriptSegment[]; language?: string }> {
  const videoId = getVideoId();

  if (!videoId) {
    throw new Error("No YouTube video detected.");
  }

  const tracks = await getCaptionTracks(videoId);

  if (tracks.length === 0) {
    throw new Error(
      "YouTube captions are unavailable for this video. A full fallback transcription source is not currently available.",
    );
  }

  const preferredTrack = selectCaptionTrack(tracks);

  if (!preferredTrack) {
    throw new Error("No usable YouTube caption track was found.");
  }

  try {
    const segments = await fetchCaptionTrack(preferredTrack);
    return {
      segments,
      language: preferredTrack.languageCode || preferredTrack.name?.simpleText,
    };
  } catch (error) {
    const alternatives = tracks.filter((track) => track !== preferredTrack);

    for (const track of alternatives) {
      try {
        const segments = await fetchCaptionTrack(track);
        return {
          segments,
          language: track.languageCode || track.name?.simpleText,
        };
      } catch {
        continue;
      }
    }

    throw error;
  }
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