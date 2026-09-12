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

let contentRecorder: MediaRecorder | null = null;
let contentChunks: Blob[] = [];
let contentStream: MediaStream | null = null;
let attachedVideo: HTMLVideoElement | null = null;

function cleanupContentAudio(): void {
  if (contentStream) {
    contentStream.getTracks().forEach((track) => track.stop());
    contentStream = null;
  }
  contentRecorder = null;
  contentChunks = [];
}

function startContentAudioRecording(): { success: boolean; isPaused: boolean } {
  cleanupContentAudio();

  const video = document.querySelector<HTMLVideoElement>("video");
  if (!video) {
    throw new Error("No YouTube video player element was found on this page.");
  }

  const stream = (video as any).captureStream
    ? (video as any).captureStream()
    : (video as any).mozCaptureStream
      ? (video as any).mozCaptureStream()
      : null;

  if (!stream) {
    throw new Error("The browser could not capture the stream from the video element.");
  }

  const audioTracks = stream.getAudioTracks();
  if (!audioTracks || audioTracks.length === 0) {
    throw new Error("No audio track found in the video stream. Please ensure the video is loaded.");
  }

  contentStream = new MediaStream(audioTracks);

  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";

  contentRecorder = new MediaRecorder(contentStream, { mimeType });
  contentChunks = [];

  contentRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      contentChunks.push(event.data);
      const totalBytes = contentChunks.reduce((acc, c) => acc + c.size, 0);

      chrome.runtime
        .sendMessage({
          type: "AUDIO_CAPTURE_PROGRESS",
          chunks: contentChunks.length,
          bytes: totalBytes,
          durationMs: contentChunks.length * 1000,
          timestamp: Date.now(),
        })
        .catch(() => { });
    }
  };

  contentRecorder.onerror = () => {
    chrome.runtime
      .sendMessage({
        type: "TRANSCRIPTION_FAILED",
        error: "Audio recording failed in YouTube tab.",
        timestamp: Date.now(),
      })
      .catch(() => { });
  };

  contentRecorder.start(1000);

  chrome.runtime
    .sendMessage({
      type: "AUDIO_CAPTURE_STARTED",
      timestamp: Date.now(),
    })
    .catch(() => { });

  return { success: true, isPaused: video.paused };
}

function stopContentAudioRecording(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!contentRecorder || contentRecorder.state === "inactive") {
      cleanupContentAudio();
      reject(new Error("No active audio recorder found."));
      return;
    }

    contentRecorder.onstop = () => {
      try {
        const blob = new Blob(contentChunks, { type: "audio/webm" });
        cleanupContentAudio();

        if (blob.size === 0) {
          reject(new Error("Captured audio was empty."));
          return;
        }

        const reader = new FileReader();
        reader.onloadend = () => {
          resolve(reader.result as string);
        };
        reader.onerror = () => {
          reject(new Error("Failed to read audio blob."));
        };
        reader.readAsDataURL(blob);
      } catch (err) {
        cleanupContentAudio();
        reject(err);
      }
    };

    contentRecorder.stop();
  });
}

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

function getPlayerResponse(): any | null {
  const scripts = Array.from(document.scripts);

  for (const script of scripts) {
    const content = script.textContent ?? "";

    if (!content.includes("ytInitialPlayerResponse")) {
      continue;
    }

    const response = extractJsonObject(content, "ytInitialPlayerResponse");

    if (response) {
      return response;
    }
  }

  return null;
}

function getVideoDuration(): number | null {
  const video = document.querySelector<HTMLVideoElement>("video");
  if (video && Number.isFinite(video.duration) && video.duration > 0) {
    return video.duration;
  }

  const playerResponse = getPlayerResponse();
  const lengthSeconds = Number(playerResponse?.videoDetails?.lengthSeconds);
  if (Number.isFinite(lengthSeconds) && lengthSeconds > 0) {
    return lengthSeconds;
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

function hasAvailableCaptions(): boolean {
  const tracks = getCaptionTracks();
  return tracks.length > 0;
}

function getVideoInfo(): VideoInfo {
  const { currentTime, isPaused } = getVideoPlaybackState();
  return {
    id: getVideoId(),
    title: getVideoTitle(),
    url: window.location.href,
    duration: getVideoDuration(),
    currentTime,
    isPaused,
    hasCaptions: hasAvailableCaptions(),
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
}

function getCaptionTracks(): CaptionTrack[] {
  const playerResponse = getPlayerResponse();

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
    (track) => track.languageCode === "en" && track.kind !== "asr",
  );

  if (englishManual) {
    return englishManual;
  }

  const english = tracks.find((track) => track.languageCode === "en");

  if (english) {
    return english;
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

function parseJson3Transcript(data: any): TranscriptSegment[] {
  if (!Array.isArray(data?.events)) {
    return [];
  }

  const segments: TranscriptSegment[] = [];

  for (const event of data.events) {
    if (!Array.isArray(event?.segs)) {
      continue;
    }

    const text = event.segs
      .map((segment: any) => segment?.utf8 ?? "")
      .join("")
      .replace(/\s+/g, " ")
      .trim();

    const startMs = Number(event.tStartMs ?? 0);
    const durationMs = Number(event.dDurationMs ?? 0);

    if (!text || !Number.isFinite(startMs)) {
      continue;
    }

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

  for (const element of elements) {
    const start = Number(element.getAttribute("start"));
    const dur = Number(element.getAttribute("dur") ?? 0);

    const text = decodeHtmlEntities(element.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim();

    if (!Number.isFinite(start) || !text) {
      continue;
    }

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

async function fetchTranscript(): Promise<TranscriptSegment[]> {
  const videoId = getVideoId();

  if (!videoId) {
    throw new Error("No YouTube video detected.");
  }

  const tracks = getCaptionTracks();

  if (tracks.length === 0) {
    throw new Error("YouTube does not expose captions for this video.");
  }

  const preferredTrack = selectCaptionTrack(tracks);

  if (!preferredTrack) {
    throw new Error("No usable YouTube caption track was found.");
  }

  try {
    return await fetchCaptionTrack(preferredTrack);
  } catch (error) {
    const alternatives = tracks.filter((track) => track !== preferredTrack);

    for (const track of alternatives) {
      try {
        return await fetchCaptionTrack(track);
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

    if (message.type === "PLAY_VIDEO") {
      const video = document.querySelector<HTMLVideoElement>("video");
      if (video) {
        video
          .play()
          .then(() => sendResponse({ success: true }))
          .catch((err) =>
            sendResponse({
              success: false,
              error: err instanceof Error ? err.message : "Could not play video.",
            }),
          );
        return true;
      }
      sendResponse({ success: false, error: "No video element found." });
      return false;
    }

    if (message.type === "PAUSE_VIDEO") {
      const video = document.querySelector<HTMLVideoElement>("video");
      if (video) {
        video.pause();
        sendResponse({ success: true });
        return false;
      }
      sendResponse({ success: false, error: "No video element found." });
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
        .then((segments) => {
          const video = getVideoInfo();

          sendResponse({
            success: true,
            transcript: {
              videoId: video.id,
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
                : "Failed to fetch transcript.",
          });
        });

      return true;
    }

    if (message.type === "START_CONTENT_AUDIO_CAPTURE") {
      try {
        const result = startContentAudioRecording();
        sendResponse(result);
      } catch (err) {
        sendResponse({
          success: false,
          error:
            err instanceof Error ? err.message : "Could not start audio capture.",
        });
      }
      return false;
    }

    if (message.type === "STOP_CONTENT_AUDIO_CAPTURE") {
      stopContentAudioRecording()
        .then((audioDataUrl) => {
          sendResponse({ success: true, audioDataUrl });
        })
        .catch((err) => {
          sendResponse({
            success: false,
            error:
              err instanceof Error ? err.message : "Could not stop audio capture.",
          });
        });
      return true;
    }

    if (message.type === "PAUSE_CONTENT_AUDIO_CAPTURE") {
      if (contentRecorder && contentRecorder.state === "recording") {
        contentRecorder.pause();
        chrome.runtime
          .sendMessage({
            type: "TRANSCRIPTION_PAUSED",
            timestamp: Date.now(),
          })
          .catch(() => { });
      }
      sendResponse({ success: true });
      return false;
    }

    if (message.type === "RESUME_CONTENT_AUDIO_CAPTURE") {
      if (contentRecorder && contentRecorder.state === "paused") {
        contentRecorder.resume();
        chrome.runtime
          .sendMessage({
            type: "TRANSCRIPTION_RESUMED",
            timestamp: Date.now(),
          })
          .catch(() => { });
      }
      sendResponse({ success: true });
      return false;
    }

    if (message.type === "CANCEL_CONTENT_AUDIO_CAPTURE") {
      cleanupContentAudio();
      sendResponse({ success: true });
      return false;
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
  }, 500);
}

document.addEventListener("yt-navigate-finish", detectNavigation);

window.addEventListener("popstate", detectNavigation);

window.setTimeout(notifyVideoChange, 1500);