import type { VideoInfo, TranscriptionEvent } from "./types/transcript";

interface ActiveContext {
  tabId: number | null;
  video: VideoInfo | null;
}

const activeContexts = new Map<number, VideoInfo | null>();
let inFlightTranscriptionVideoId: string | null = null;

function broadcastEvent(event: TranscriptionEvent): void {
  chrome.runtime.sendMessage(event).catch(() => {});
}

async function configureSidePanel(): Promise<void> {
  await chrome.sidePanel.setOptions({
    path: "index.html",
    enabled: true,
  });
}

async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });

  return tabs[0];
}

function isYouTubeWatchPage(url: string | undefined): boolean {
  if (!url) {
    return false;
  }

  try {
    const parsed = new URL(url);

    return (
      parsed.hostname === "www.youtube.com" &&
      parsed.pathname === "/watch" &&
      Boolean(parsed.searchParams.get("v"))
    );
  } catch {
    return false;
  }
}

async function injectContentScript(tabId: number): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });

    return true;
  } catch {
    return false;
  }
}

async function sendVideoInfoRequest(
  tabId: number,
): Promise<VideoInfo | null> {
  try {
    const response = (await chrome.tabs.sendMessage(tabId, {
      type: "GET_VIDEO_INFO",
    })) as {
      success?: boolean;
      video?: VideoInfo;
    };

    if (response?.success && response.video) {
      return response.video;
    }
  } catch {
    return null;
  }

  return null;
}

async function getVideoFromTab(tabId: number): Promise<VideoInfo | null> {
  let video = await sendVideoInfoRequest(tabId);

  if (video) {
    activeContexts.set(tabId, video);
    return video;
  }

  if (!(await injectContentScript(tabId))) {
    activeContexts.set(tabId, null);
    return null;
  }

  await new Promise((resolve) => setTimeout(resolve, 150));

  video = await sendVideoInfoRequest(tabId);

  activeContexts.set(tabId, video);

  return video;
}

async function getActiveContext(): Promise<ActiveContext> {
  const tab = await getActiveTab();

  if (!tab?.id || !isYouTubeWatchPage(tab.url)) {
    if (tab?.id) {
      activeContexts.set(tab.id, null);
    }

    return {
      tabId: tab?.id ?? null,
      video: null,
    };
  }

  const video = await getVideoFromTab(tab.id);

  return {
    tabId: tab.id,
    video,
  };
}

async function notifySidePanel(): Promise<void> {
  const context = await getActiveContext();

  try {
    await chrome.runtime.sendMessage({
      type: "ACTIVE_CONTEXT_UPDATED",
      context,
    });
  } catch {
    return;
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (tab?.windowId) {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  }
});

chrome.runtime.onInstalled.addListener(() => {
  configureSidePanel().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  configureSidePanel().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "VIDEO_INFO_UPDATED" && sender.tab?.id) {
    const tabId = sender.tab.id;
    const video = message.video as VideoInfo;

    activeContexts.set(tabId, video);

    chrome.runtime
      .sendMessage({
        type: "ACTIVE_CONTEXT_UPDATED",
        context: {
          tabId,
          video,
        },
      })
      .catch(() => {});

    return false;
  }

  if (message?.type === "PLAYBACK_STATE_CHANGED" && sender.tab?.id) {
    const tabId = sender.tab.id;
    const existing = activeContexts.get(tabId);
    if (existing) {
      existing.isPaused = message.isPaused;
      existing.currentTime = message.currentTime;
      if (typeof message.duration === "number" && message.duration > 0) {
        existing.duration = message.duration;
      }
    }

    chrome.runtime
      .sendMessage({
        type: "PLAYBACK_STATE_CHANGED",
        isPaused: message.isPaused,
        currentTime: message.currentTime,
        duration: message.duration,
      })
      .catch(() => {});

    return false;
  }

  if (message?.type === "GET_ACTIVE_CONTEXT") {
    getActiveContext()
      .then((context) => {
        sendResponse({
          success: true,
          context,
        });
      })
      .catch((error) => {
        sendResponse({
          success: false,
          context: {
            tabId: null,
            video: null,
          },
          error:
            error instanceof Error
              ? error.message
              : "Could not read active video.",
        });
      });

    return true;
  }

  if (message?.type === "START_TRANSCRIPTION") {
    getActiveContext()
      .then(async (context) => {
        if (!context.tabId || !context.video?.id) {
          throw new Error("No active YouTube video found. Please open a YouTube video.");
        }

        const videoId = context.video.id;

        if (inFlightTranscriptionVideoId === videoId) {
          sendResponse({ success: true, inFlight: true });
          return;
        }

        inFlightTranscriptionVideoId = videoId;

        broadcastEvent({
          type: "TRANSCRIPTION_STARTED",
          videoId,
          timestamp: Date.now(),
        });

        try {
          const captionResponse = (await chrome.tabs.sendMessage(
            context.tabId,
            { type: "GET_TRANSCRIPT" },
          )) as {
            success?: boolean;
            error?: string;
            transcript?: {
              videoId: string;
              duration?: number | null;
              source?: "youtube_captions";
              segments: any[];
            };
          };

          if (
            captionResponse?.success &&
            captionResponse.transcript &&
            Array.isArray(captionResponse.transcript.segments) &&
            captionResponse.transcript.segments.length > 0
          ) {
            broadcastEvent({
              type: "TRANSCRIPTION_COMPLETED",
              transcript: {
                videoId,
                title: context.video.title,
                duration: context.video.duration,
                source: "youtube_captions",
                segments: captionResponse.transcript.segments,
              },
              timestamp: Date.now(),
              videoId,
            });

            sendResponse({
              success: true,
              segmentsCount: captionResponse.transcript.segments.length,
            });
            return;
          }

          const failureReason =
            captionResponse?.error ||
            "YouTube captions are unavailable for this video. A full fallback transcription source is not currently available.";

          broadcastEvent({
            type: "TRANSCRIPTION_FAILED",
            error: failureReason,
            timestamp: Date.now(),
            videoId,
          });

          sendResponse({
            success: false,
            error: failureReason,
          });
        } catch (tabError) {
          const errorMsg =
            tabError instanceof Error
              ? tabError.message
              : "Failed to communicate with YouTube tab. Please refresh the page.";

          broadcastEvent({
            type: "TRANSCRIPTION_FAILED",
            error: errorMsg,
            timestamp: Date.now(),
            videoId,
          });

          sendResponse({
            success: false,
            error: errorMsg,
          });
        } finally {
          inFlightTranscriptionVideoId = null;
        }
      })
      .catch((error) => {
        inFlightTranscriptionVideoId = null;
        const errorMsg =
          error instanceof Error
            ? error.message
            : "Could not start transcription.";

        broadcastEvent({
          type: "TRANSCRIPTION_FAILED",
          error: errorMsg,
          timestamp: Date.now(),
        });

        sendResponse({
          success: false,
          error: errorMsg,
        });
      });

    return true;
  }

  if (message?.type === "FETCH_CAPTION_URL" && typeof message.url === "string") {
    fetch(message.url)
      .then(async (res) => {
        if (!res.ok) {
          sendResponse({ success: false, status: res.status });
          return;
        }
        const text = await res.text();
        sendResponse({ success: true, text });
      })
      .catch((err) => {
        sendResponse({ success: false, error: String(err) });
      });
    return true;
  }

  return false;
});

chrome.tabs.onActivated.addListener(async () => {
  await notifySidePanel();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!tab.active) {
    return;
  }

  if (changeInfo.url) {
    if (isYouTubeWatchPage(tab.url)) {
      setTimeout(() => {
        notifySidePanel().catch(() => {});
      }, 500);
    } else {
      activeContexts.set(tabId, null);
      await notifySidePanel();
    }

    return;
  }

  if (changeInfo.status === "complete") {
    setTimeout(() => {
      notifySidePanel().catch(() => {});
    }, 500);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  activeContexts.delete(tabId);
});

configureSidePanel().catch(() => {});