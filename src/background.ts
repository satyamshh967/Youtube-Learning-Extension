interface VideoInfo {
  id: string | null;
  title: string;
  url: string;
}

interface ActiveContext {
  tabId: number | null;
  video: VideoInfo | null;
}

const activeContexts = new Map<number, VideoInfo | null>();

let creatingOffscreen: Promise<void> | null = null;

async function configureSidePanel(): Promise<void> {
  await chrome.sidePanel.setPanelBehavior({
    openPanelOnActionClick: true,
  });

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

function isYouTubeWatchPage(
  url: string | undefined,
): boolean {
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

async function injectContentScript(
  tabId: number,
): Promise<boolean> {
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

async function getVideoFromTab(
  tabId: number,
): Promise<VideoInfo | null> {
  let video = await sendVideoInfoRequest(tabId);

  if (video) {
    activeContexts.set(tabId, video);
    return video;
  }

  if (!(await injectContentScript(tabId))) {
    activeContexts.set(tabId, null);
    return null;
  }

  await new Promise((resolve) => setTimeout(resolve, 100));

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
    justification:
      "Capture YouTube tab audio for local speech transcription.",
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
          reject(
            new Error(
              chrome.runtime.lastError.message,
            ),
          );
          return;
        }

        resolve(response);
      },
    );
  });
}

async function startAudioCapture(
  streamId: string,
): Promise<void> {
  if (!streamId) {
    throw new Error(
      "No audio capture stream was provided.",
    );
  }

  await ensureOffscreenDocument();

  const response =
    (await sendToOffscreen({
      type:
        "START_AUDIO_CAPTURE",
      streamId,
    })) as {
      success?: boolean;
      error?: string;
    };

  if (!response?.success) {
    throw new Error(
      response?.error ??
        "The audio recorder could not start.",
    );
  }
}

chrome.runtime.onInstalled.addListener(() => {
  configureSidePanel().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  configureSidePanel().catch(() => {});
});

chrome.runtime.onMessage.addListener(
  (message, sender, sendResponse) => {
    if (
      message?.type === "VIDEO_INFO_UPDATED" &&
      sender.tab?.id
    ) {
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
          if (
            !context.tabId ||
            !context.video?.id
          ) {
            throw new Error(
              "No active YouTube video found.",
            );
          }

          await startAudioCapture(
            context.tabId,
          );

          sendResponse({
            success: true,
          });
        })
        .catch((error) => {
          sendResponse({
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Could not start transcription.",
          });
        });

      return true;
    }

    if (message?.type === "STOP_TRANSCRIPTION") {
      sendToOffscreen({
        type: "STOP_AUDIO_CAPTURE",
      }).catch(() => {});

      sendResponse({
        success: true,
      });

      return false;
    }

    if (message?.type === "TRANSCRIPTION_STARTED") {
      chrome.runtime
        .sendMessage({
          type: "TRANSCRIPTION_PROCESSING",
        })
        .catch(() => {});

      return false;
    }

    if (message?.type === "TRANSCRIPTION_COMPLETE") {
      chrome.runtime
        .sendMessage({
          type: "TRANSCRIPTION_COMPLETE",
          transcript: message.transcript,
        })
        .catch(() => {});

      return false;
    }

    if (message?.type === "TRANSCRIPTION_ERROR") {
      chrome.runtime
        .sendMessage({
          type: "TRANSCRIPTION_ERROR",
          error: message.error,
        })
        .catch(() => {});

      return false;
    }

    return false;
  },
);

chrome.tabs.onActivated.addListener(async () => {
  await notifySidePanel();
});

chrome.tabs.onUpdated.addListener(
  async (tabId, changeInfo, tab) => {
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
  },
);

chrome.tabs.onRemoved.addListener((tabId) => {
  activeContexts.delete(tabId);
});

configureSidePanel().catch(() => {});