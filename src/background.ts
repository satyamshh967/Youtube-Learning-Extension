import type { VideoInfo, TranscriptionEvent } from "./types/transcript";

interface ActiveContext {
  tabId: number | null;
  video: VideoInfo | null;
}

const activeContexts = new Map<number, VideoInfo | null>();

let creatingOffscreen: Promise<void> | null = null;
let activeCaptureMode: "offscreen" | "content" | null = null;
let activeTranscriptionVideoId: string | null = null;

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

async function ensureOffscreenDocument(): Promise<void> {
  const offscreenUrl = chrome.runtime.getURL("offscreen.html");

  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl],
  });

  if (contexts.length > 0) {
    return;
  }

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Capture YouTube tab audio for local speech transcription.",
  });

  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

async function sendToOffscreen(
  message: Record<string, unknown>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        target: "offscreen",
        ...message,
      },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        resolve(response);
      },
    );
  });
}

async function getTabMediaStreamId(tabId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId(
      {
        targetTabId: tabId,
      },
      (streamId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!streamId) {
          reject(
            new Error(
              "Extension has not been invoked for the current page (see activeTab permission).",
            ),
          );
          return;
        }
        resolve(streamId);
      },
    );
  });
}

async function startAudioCapture(streamId: string): Promise<void> {
  if (!streamId) {
    throw new Error("No audio capture stream was provided.");
  }

  await ensureOffscreenDocument();

  const response = (await sendToOffscreen({
    type: "START_AUDIO_CAPTURE",
    streamId,
  })) as {
    success?: boolean;
    error?: string;
  };

  if (!response?.success) {
    throw new Error(response?.error ?? "The audio recorder could not start.");
  }
}

async function sendAudioDataUrlToWhisper(
  audioDataUrl: string,
  videoId: string,
): Promise<void> {
  try {
    broadcastEvent({
      type: "TRANSCRIPTION_PROGRESS",
      stage: "sending",
      timestamp: Date.now(),
      videoId,
    });

    const responseBlob = await (await fetch(audioDataUrl)).blob();
    const formData = new FormData();
    formData.append("file", responseBlob, "youtube-audio.webm");

    const response = await fetch("http://127.0.0.1:8000/transcribe", {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      throw new Error(
        `Transcription server returned HTTP ${response.status}.`,
      );
    }

    broadcastEvent({
      type: "TRANSCRIPTION_PROGRESS",
      stage: "parsing",
      timestamp: Date.now(),
      videoId,
    });

    const result = (await response.json()) as {
      language?: string;
      languageProbability?: number;
      segments: Array<{
        start: number;
        end?: number;
        text: string;
      }>;
    };

    broadcastEvent({
      type: "TRANSCRIPTION_COMPLETED",
      transcript: {
        videoId,
        language: result.language,
        languageProbability: result.languageProbability,
        source: "whisper_audio",
        segments: (result.segments || []).map((s) => ({
          start: s.start,
          end: s.end,
          timestamp: "",
          text: s.text,
        })),
      },
      timestamp: Date.now(),
      videoId,
    });
  } catch (error) {
    const errorMsg =
      error instanceof Error ? error.message : "Transcription failed.";
    broadcastEvent({
      type: "TRANSCRIPTION_FAILED",
      error: errorMsg,
      timestamp: Date.now(),
      videoId,
    });
  }
}

// Clicking toolbar icon grants activeTab to tab.id and opens side panel
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

  if (message?.type === "PLAY_VIDEO") {
    getActiveContext().then((context) => {
      if (context.tabId) {
        chrome.tabs.sendMessage(context.tabId, { type: "PLAY_VIDEO" }, (res) => {
          sendResponse(res || { success: true });
        });
      } else {
        sendResponse({ success: false, error: "No active tab." });
      }
    });
    return true;
  }

  if (message?.type === "PAUSE_VIDEO") {
    getActiveContext().then((context) => {
      if (context.tabId) {
        chrome.tabs.sendMessage(context.tabId, { type: "PAUSE_VIDEO" }, (res) => {
          sendResponse(res || { success: true });
        });
      } else {
        sendResponse({ success: false, error: "No active tab." });
      }
    });
    return true;
  }

  if (message?.type === "START_TRANSCRIPTION") {
    getActiveContext()
      .then(async (context) => {
        if (!context.tabId || !context.video?.id) {
          throw new Error("No active YouTube video found.");
        }

        activeTranscriptionVideoId = context.video.id;

        broadcastEvent({
          type: "TRANSCRIPTION_STARTED",
          videoId: context.video.id,
          timestamp: Date.now(),
        });

        // Option 1 Priority: Try extracting complete YouTube captions/transcript if available (unless mode is explicitly forced to 'audio')
        if (message.mode !== "audio") {
          try {
            const captionResponse = (await chrome.tabs.sendMessage(
              context.tabId,
              { type: "GET_TRANSCRIPT" },
            )) as {
              success?: boolean;
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
              captionResponse.transcript.segments.length > 0
            ) {
              // Option 1 successful! Full transcript immediately extracted without needing playback.
              broadcastEvent({
                type: "TRANSCRIPTION_COMPLETED",
                transcript: {
                  videoId: context.video.id,
                  title: context.video.title,
                  duration: context.video.duration,
                  source: "youtube_captions",
                  segments: captionResponse.transcript.segments,
                },
                timestamp: Date.now(),
                videoId: context.video.id,
              });

              sendResponse({
                success: true,
                method: "captions",
                segmentsCount: captionResponse.transcript.segments.length,
              });
              return;
            }
          } catch {
            // Captions unavailable, seamlessly proceed to Option 2 & 3: Audio Transcription
          }
        }

        // Option 2 & 3: Local audio capture with Whisper
        let tabCaptureSucceeded = false;
        try {
          const streamId = await getTabMediaStreamId(context.tabId);
          await startAudioCapture(streamId);
          activeCaptureMode = "offscreen";
          tabCaptureSucceeded = true;
        } catch {
          // Attempt content audio capture fallback
        }

        if (tabCaptureSucceeded) {
          sendResponse({
            success: true,
            method: "tabCapture",
            isPaused: context.video.isPaused,
          });
          return;
        }

        try {
          const contentResponse = (await chrome.tabs.sendMessage(context.tabId, {
            type: "START_CONTENT_AUDIO_CAPTURE",
          })) as { success?: boolean; isPaused?: boolean; error?: string };

          if (contentResponse?.success) {
            activeCaptureMode = "content";
            sendResponse({
              success: true,
              method: "contentCapture",
              isPaused: contentResponse.isPaused ?? context.video.isPaused,
            });
            return;
          }

          throw new Error(
            contentResponse?.error ?? "Content audio capture could not start.",
          );
        } catch (contentError) {
          const errMsg =
            contentError instanceof Error
              ? contentError.message
              : "Could not capture audio. Please ensure the YouTube video is open and playing.";

          broadcastEvent({
            type: "TRANSCRIPTION_FAILED",
            error: errMsg,
            timestamp: Date.now(),
            videoId: context.video.id,
          });

          sendResponse({
            success: false,
            error: errMsg,
          });
        }
      })
      .catch((error) => {
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

  if (message?.type === "STOP_TRANSCRIPTION") {
    getActiveContext()
      .then(async (context) => {
        const videoId = activeTranscriptionVideoId || context.video?.id || "";

        if (activeCaptureMode === "content" && context.tabId) {
          const res = (await chrome.tabs.sendMessage(context.tabId, {
            type: "STOP_CONTENT_AUDIO_CAPTURE",
          })) as { success?: boolean; audioDataUrl?: string; error?: string };

          activeCaptureMode = null;

          if (res?.success && res.audioDataUrl) {
            sendAudioDataUrlToWhisper(res.audioDataUrl, videoId);
            sendResponse({ success: true });
            return;
          }

          throw new Error(res?.error || "Failed to retrieve audio from tab.");
        }

        // Offscreen capture stop
        sendToOffscreen({
          type: "STOP_AUDIO_CAPTURE",
        })
          .then(() => {
            activeCaptureMode = null;
            sendResponse({ success: true });
          })
          .catch((error) => {
            activeCaptureMode = null;
            sendResponse({
              success: false,
              error:
                error instanceof Error
                  ? error.message
                  : "Could not stop audio capture.",
            });
          });
      })
      .catch((error) => {
        activeCaptureMode = null;
        sendResponse({
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Could not stop audio capture.",
        });
      });

    return true;
  }

  if (message?.type === "PAUSE_TRANSCRIPTION") {
    getActiveContext().then(async (context) => {
      if (activeCaptureMode === "content" && context.tabId) {
        await chrome.tabs.sendMessage(context.tabId, {
          type: "PAUSE_CONTENT_AUDIO_CAPTURE",
        });
      }
      sendResponse({ success: true });
    });
    return true;
  }

  if (message?.type === "RESUME_TRANSCRIPTION") {
    getActiveContext().then(async (context) => {
      if (activeCaptureMode === "content" && context.tabId) {
        await chrome.tabs.sendMessage(context.tabId, {
          type: "RESUME_CONTENT_AUDIO_CAPTURE",
        });
      }
      sendResponse({ success: true });
    });
    return true;
  }

  if (message?.type === "CANCEL_TRANSCRIPTION") {
    getActiveContext().then(async (context) => {
      if (context.tabId) {
        chrome.tabs
          .sendMessage(context.tabId, {
            type: "CANCEL_CONTENT_AUDIO_CAPTURE",
          })
          .catch(() => {});
      }
      sendToOffscreen({
        type: "STOP_AUDIO_CAPTURE",
      }).catch(() => {});

      activeCaptureMode = null;
      activeTranscriptionVideoId = null;

      broadcastEvent({
        type: "TRANSCRIPTION_CANCELLED",
        timestamp: Date.now(),
      });

      sendResponse({
        success: true,
      });
    });

    return true;
  }

  // Hook event logging
  if (
    typeof message?.type === "string" &&
    (message.type.startsWith("AUDIO_CAPTURE_") ||
      message.type.startsWith("TRANSCRIPTION_") ||
      message.type === "TRANSCRIPT_SEGMENT_RECEIVED")
  ) {
    console.log(`[TranscriptionEvent] ${message.type}`, message);
    return false;
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