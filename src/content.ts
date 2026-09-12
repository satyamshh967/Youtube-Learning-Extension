interface VideoInfo {
  id: string | null;
  title: string;
  url: string;
}

interface TranscriptSegment {
  start: number;
  timestamp: string;
  text: string;
}

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
    const element =
      document.querySelector<HTMLElement>(selector);

    const title = element?.textContent?.trim();

    if (title) {
      return title;
    }
  }

  const pageTitle = document.title
    .replace(/\s*-\s*YouTube\s*$/i, "")
    .trim();

  if (
    pageTitle &&
    pageTitle.toLowerCase() !== "youtube"
  ) {
    return pageTitle;
  }

  return "YouTube Video";
}

function getVideoInfo(): VideoInfo {
  return {
    id: getVideoId(),
    title: getVideoTitle(),
    url: window.location.href,
  };
}

async function waitForRealTitle(
  timeout = 5000,
): Promise<VideoInfo> {
  const started = Date.now();

  while (Date.now() - started < timeout) {
    const video = getVideoInfo();

    if (
      video.id &&
      video.title !== "YouTube Video" &&
      video.title !== "(111) YouTube"
    ) {
      return video;
    }

    await new Promise((resolve) =>
      window.setTimeout(resolve, 200),
    );
  }

  return getVideoInfo();
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

  waitForRealTitle()
    .then((video) => {
      chrome.runtime
        .sendMessage({
          type: "VIDEO_INFO_UPDATED",
          video,
        })
        .catch(() => {});
    })
    .catch(() => {});
}

function extractJsonObject(
  source: string,
  marker: string,
): unknown {
  const markerIndex =
    source.indexOf(marker);

  if (markerIndex === -1) {
    return null;
  }

  const equalsIndex =
    source.indexOf(
      "=",
      markerIndex + marker.length,
    );

  if (equalsIndex === -1) {
    return null;
  }

  const jsonStart =
    source.indexOf(
      "{",
      equalsIndex,
    );

  if (jsonStart === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (
    let index = jsonStart;
    index < source.length;
    index++
  ) {
    const character =
      source[index];

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
        const json =
          source.slice(
            jsonStart,
            index + 1,
          );

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
  const scripts =
    Array.from(
      document.scripts,
    );

  for (const script of scripts) {
    const content =
      script.textContent ?? "";

    if (
      !content.includes(
        "ytInitialPlayerResponse",
      )
    ) {
      continue;
    }

    const response =
      extractJsonObject(
        content,
        "ytInitialPlayerResponse",
      );

    if (response) {
      return response;
    }
  }

  return null;
}

function getCaptionTracks(): CaptionTrack[] {
  const playerResponse =
    getPlayerResponse();

  const tracks =
    playerResponse
      ?.captions
      ?.playerCaptionsTracklistRenderer
      ?.captionTracks;

  if (!Array.isArray(tracks)) {
    return [];
  }

  return tracks.filter(
    (
      track: unknown,
    ): track is CaptionTrack =>
      typeof track === "object" &&
      track !== null &&
      typeof (
        track as CaptionTrack
      ).baseUrl === "string",
  );
}

function selectCaptionTrack(
  tracks: CaptionTrack[],
): CaptionTrack | null {
  if (tracks.length === 0) {
    return null;
  }

  const englishManual =
    tracks.find(
      (track) =>
        track.languageCode ===
          "en" &&
        track.kind !== "asr",
    );

  if (englishManual) {
    return englishManual;
  }

  const english =
    tracks.find(
      (track) =>
        track.languageCode ===
        "en",
    );

  if (english) {
    return english;
  }

  const manual =
    tracks.find(
      (track) =>
        track.kind !== "asr",
    );

  if (manual) {
    return manual;
  }

  return tracks[0];
}

function decodeHtmlEntities(
  value: string,
): string {
  const textarea =
    document.createElement(
      "textarea",
    );

  textarea.innerHTML = value;

  return textarea.value;
}

function formatTimestamp(
  milliseconds: number,
): string {
  const totalSeconds =
    Math.max(
      0,
      Math.floor(
        milliseconds / 1000,
      ),
    );

  const hours =
    Math.floor(
      totalSeconds / 3600,
    );

  const minutes =
    Math.floor(
      (totalSeconds % 3600) / 60,
    );

  const seconds =
    totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(
      minutes,
    ).padStart(2, "0")}:${String(
      seconds,
    ).padStart(2, "0")}`;
  }

  return `${minutes}:${String(
    seconds,
  ).padStart(2, "0")}`;
}

function parseJson3Transcript(
  data: any,
): TranscriptSegment[] {
  if (
    !Array.isArray(
      data?.events,
    )
  ) {
    return [];
  }

  const segments: TranscriptSegment[] =
    [];

  for (const event of data.events) {
    if (
      !Array.isArray(
        event?.segs,
      )
    ) {
      continue;
    }

    const text =
      event.segs
        .map(
          (segment: any) =>
            segment?.utf8 ?? "",
        )
        .join("")
        .replace(/\s+/g, " ")
        .trim();

    const startMs =
      Number(
        event.tStartMs ?? 0,
      );

    if (
      !text ||
      !Number.isFinite(
        startMs,
      )
    ) {
      continue;
    }

    segments.push({
      start:
        startMs / 1000,
      timestamp:
        formatTimestamp(
          startMs,
        ),
      text,
    });
  }

  return segments;
}

function parseXmlTranscript(
  xml: string,
): TranscriptSegment[] {
  const parser =
    new DOMParser();

  const document =
    parser.parseFromString(
      xml,
      "text/xml",
    );

  const elements =
    Array.from(
      document.querySelectorAll(
        "text",
      ),
    );

  return elements
    .map((element) => {
      const start =
        Number(
          element.getAttribute(
            "start",
          ),
        );

      const text =
        decodeHtmlEntities(
          element.textContent ?? "",
        )
          .replace(
            /\s+/g,
            " ",
          )
          .trim();

      if (
        !Number.isFinite(
          start,
        ) ||
        !text
      ) {
        return null;
      }

      return {
        start,
        timestamp:
          formatTimestamp(
            start * 1000,
          ),
        text,
      };
    })
    .filter(
      (
        segment,
      ): segment is TranscriptSegment =>
        Boolean(segment),
    );
}

async function fetchCaptionTrack(
  track: CaptionTrack,
): Promise<TranscriptSegment[]> {
  const url =
    new URL(
      track.baseUrl,
      window.location.origin,
    );

  url.searchParams.set(
    "fmt",
    "json3",
  );

  const response =
    await fetch(
      url.toString(),
      {
        credentials:
          "include",
      },
    );

  if (!response.ok) {
    throw new Error(
      `YouTube caption request failed with HTTP ${response.status}.`,
    );
  }

  const body =
    await response.text();

  if (!body.trim()) {
    throw new Error(
      "YouTube returned an empty caption track.",
    );
  }

  try {
    const data =
      JSON.parse(body);

    const segments =
      parseJson3Transcript(
        data,
      );

    if (
      segments.length > 0
    ) {
      return segments;
    }
  } catch {
    const segments =
      parseXmlTranscript(
        body,
      );

    if (
      segments.length > 0
    ) {
      return segments;
    }
  }

  throw new Error(
    "YouTube returned no transcript segments.",
  );
}

async function fetchTranscript(): Promise<
  TranscriptSegment[]
> {
  const videoId =
    getVideoId();

  if (!videoId) {
    throw new Error(
      "No YouTube video detected.",
    );
  }

  const tracks =
    getCaptionTracks();

  if (tracks.length === 0) {
    throw new Error(
      "YouTube does not expose captions for this video.",
    );
  }

  const preferredTrack =
    selectCaptionTrack(
      tracks,
    );

  if (!preferredTrack) {
    throw new Error(
      "No usable YouTube caption track was found.",
    );
  }

  try {
    return await fetchCaptionTrack(
      preferredTrack,
    );
  } catch (error) {
    const alternatives =
      tracks.filter(
        (track) =>
          track !==
          preferredTrack,
      );

    for (const track of alternatives) {
      try {
        return await fetchCaptionTrack(
          track,
        );
      } catch {
        continue;
      }
    }

    throw error;
  }
}

function seekVideo(
  time: number,
): boolean {
  const video =
    document.querySelector<HTMLVideoElement>(
      "video",
    );

  if (
    !video ||
    !Number.isFinite(time) ||
    time < 0
  ) {
    return false;
  }

  video.currentTime =
    time;

  return true;
}

chrome.runtime.onMessage.addListener(
  (
    message: ExtensionMessage,
    _sender,
    sendResponse,
  ) => {
    if (
      message.type ===
      "GET_VIDEO_INFO"
    ) {
      sendResponse({
        success: true,
        video:
          getVideoInfo(),
      });

      return false;
    }

    if (
      message.type ===
      "SEEK_VIDEO"
    ) {
      if (
        typeof message.time !==
        "number"
      ) {
        sendResponse({
          success: false,
          error:
            "Invalid seek time.",
        });

        return false;
      }

      const success =
        seekVideo(
          message.time,
        );

      sendResponse({
        success,
        error: success
          ? undefined
          : "YouTube video player was not found.",
      });

      return false;
    }

    if (
      message.type ===
      "GET_TRANSCRIPT"
    ) {
      fetchTranscript()
        .then((segments) => {
          const video =
            getVideoInfo();

          sendResponse({
            success: true,
            transcript: {
              videoId:
                video.id,
              segments,
            },
          });
        })
        .catch(
          (error: unknown) => {
            sendResponse({
              success: false,
              error:
                error instanceof
                Error
                  ? error.message
                  : "Failed to fetch transcript.",
            });
          },
        );

      return true;
    }

    return false;
  },
);

let lastVideoId =
  getVideoId();

let lastUrl =
  window.location.href;

function detectNavigation(): void {
  const currentUrl =
    window.location.href;

  const currentVideoId =
    getVideoId();

  if (
    currentUrl ===
      lastUrl &&
    currentVideoId ===
      lastVideoId
  ) {
    return;
  }

  lastUrl =
    currentUrl;

  lastVideoId =
    currentVideoId;

  window.setTimeout(() => {
    notifyVideoChange();
  }, 500);
}

document.addEventListener(
  "yt-navigate-finish",
  detectNavigation,
);

window.addEventListener(
  "popstate",
  detectNavigation,
);

window.setTimeout(
  notifyVideoChange,
  1500,
);