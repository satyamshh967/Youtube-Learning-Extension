import {
  useCallback,
  useEffect,
  useState,
} from "react";
import "./App.css";

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

interface Transcript {
  videoId: string;
  segments: TranscriptSegment[];
}

interface ActiveContext {
  tabId: number | null;
  video: VideoInfo | null;
}

interface BackgroundResponse {
  success: boolean;
  context: ActiveContext;
}

interface RuntimeMessage {
  type?: string;
  context?: ActiveContext;
  transcript?: {
    segments?: Array<{
      start: number;
      end?: number;
      text: string;
    }>;
  };
  error?: string;
}

type TranscriptionState =
  | "idle"
  | "capturing"
  | "processing";

function formatTimestamp(
  seconds: number,
): string {
  const totalSeconds = Math.max(
    0,
    Math.floor(seconds),
  );

  const hours = Math.floor(
    totalSeconds / 3600,
  );

  const minutes = Math.floor(
    (totalSeconds % 3600) / 60,
  );

  const remainingSeconds =
    totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(
      minutes,
    ).padStart(2, "0")}:${String(
      remainingSeconds,
    ).padStart(2, "0")}`;
  }

  return `${minutes}:${String(
    remainingSeconds,
  ).padStart(2, "0")}`;
}

function App() {
  const [video, setVideo] =
    useState<VideoInfo | null>(null);

  const [transcript, setTranscript] =
    useState<Transcript | null>(null);

  const [loading, setLoading] =
    useState(false);

  const [error, setError] =
    useState<string | null>(null);

  const [transcriptionState, setTranscriptionState] =
    useState<TranscriptionState>(
      "idle",
    );

  const restoreTranscript =
    useCallback(
      async (
        videoId: string,
      ) => {
        try {
          const key =
            `transcript:${videoId}`;

          const result =
            await chrome.storage.local.get(
              key,
            );

          const cached =
            result[key] as
              | Transcript
              | undefined;

          if (
            cached &&
            cached.videoId ===
              videoId &&
            Array.isArray(
              cached.segments,
            ) &&
            cached.segments.length > 0
          ) {
            setTranscript(cached);
            return;
          }

          setTranscript(null);
        } catch {
          setTranscript(null);
        }
      },
      [],
    );

  const applyContext =
    useCallback(
      async (
        context: ActiveContext,
      ) => {
        const nextVideo =
          context.video;

        if (!nextVideo?.id) {
          setVideo(null);
          setTranscript(null);
          setError(null);
          setLoading(false);
          setTranscriptionState(
            "idle",
          );
          return;
        }

        setVideo(nextVideo);

        if (
          transcript?.videoId !==
          nextVideo.id
        ) {
          setTranscript(null);
        }

        if (
          transcriptionState ===
          "idle"
        ) {
          setLoading(false);
        }

        setError(null);

        await restoreTranscript(
          nextVideo.id,
        );
      },
      [
        restoreTranscript,
        transcriptionState,
        transcript?.videoId,
      ],
    );

  const loadActiveContext =
    useCallback(async () => {
      try {
        const response =
          (await chrome.runtime.sendMessage(
            {
              type:
                "GET_ACTIVE_CONTEXT",
            },
          )) as BackgroundResponse;

        if (
          response?.success &&
          response.context
        ) {
          await applyContext(
            response.context,
          );
        }
      } catch {
        setVideo(null);
        setTranscript(null);
        setError(null);
      }
    }, [applyContext]);

  const startTranscription =
  async () => {
    if (!video?.id) {
      return;
    }

    setError(null);
    setLoading(true);

    try {
      const tabs =
        await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });

      const activeTab =
        tabs[0];

      if (!activeTab?.id) {
        throw new Error(
          "No active YouTube tab found.",
        );
      }

      const currentUrl =
        activeTab.url ?? "";

      if (
        !currentUrl.includes(
          "youtube.com/watch",
        )
      ) {
        throw new Error(
          "The active tab is not a YouTube video.",
        );
      }

      const streamId =
        await chrome.tabCapture.getMediaStreamId(
          {
            targetTabId:
              activeTab.id,
          },
        );

      if (!streamId) {
        throw new Error(
          "Chrome did not provide an audio capture stream.",
        );
      }

      const response =
        (await chrome.runtime.sendMessage(
          {
            type:
              "START_AUDIO_CAPTURE",
            streamId,
            tabId:
              activeTab.id,
          },
        )) as {
          success?: boolean;
          error?: string;
        };

      if (!response?.success) {
        throw new Error(
          response?.error ??
            "The audio recorder could not start.",
        );
      }

      setTranscriptionState(
        "capturing",
      );

      setLoading(false);
    } catch (error) {
      setLoading(false);
      setTranscriptionState(
        "idle",
      );

      setError(
        error instanceof Error
          ? error.message
          : "Could not start transcription.",
      );
    }
  };setLoading(true);
      setError(null);

      try {
        const response =
          (await chrome.runtime.sendMessage(
            {
              type:
                "STOP_TRANSCRIPTION",
            },
          )) as {
            success?: boolean;
            error?: string;
          };

        if (!response?.success) {
          throw new Error(
            response?.error ??
              "Could not stop transcription.",
          );
        }
      } catch (error) {
        setLoading(false);

        setError(
          error instanceof Error
            ? error.message
            : "Could not stop transcription.",
        );
      }
    };

  const seekTo =
    async (time: number) => {
      try {
        const response =
          (await chrome.runtime.sendMessage(
            {
              type:
                "GET_ACTIVE_CONTEXT",
            },
          )) as BackgroundResponse;

        if (
          !response?.success ||
          !response.context
        ) {
          return;
        }

        const tabId =
          response.context.tabId;

        const currentVideo =
          response.context.video;

        if (
          !tabId ||
          !currentVideo?.id ||
          currentVideo.id !==
            video?.id
        ) {
          await applyContext(
            response.context,
          );
          return;
        }

        await chrome.tabs.sendMessage(
          tabId,
          {
            type: "SEEK_VIDEO",
            time,
          },
        );
      } catch {
        setError(
          "Could not communicate with the YouTube page.",
        );
      }
    };

  useEffect(() => {
    loadActiveContext();

    const listener = (
      message: RuntimeMessage,
    ) => {
      if (
        message.type ===
          "ACTIVE_CONTEXT_UPDATED" &&
        message.context
      ) {
        applyContext(
          message.context,
        );

        return;
      }

      if (
        message.type ===
        "TRANSCRIPTION_PROCESSING"
      ) {
        setLoading(true);
        setError(null);
        setTranscriptionState(
          "processing",
        );

        return;
      }

      if (
        message.type ===
          "TRANSCRIPTION_COMPLETE" &&
        message.transcript
      ) {
        const currentVideo =
          video;

        if (
          !currentVideo?.id ||
          !message.transcript
            .segments
        ) {
          setLoading(false);
          setTranscriptionState(
            "idle",
          );
          return;
        }

        const nextTranscript: Transcript =
          {
            videoId:
              currentVideo.id,
            segments:
              message.transcript.segments
                .filter(
                  (
                    segment,
                  ) =>
                    Number.isFinite(
                      segment.start,
                    ) &&
                    segment.text.trim()
                      .length > 0,
                )
                .map(
                  (
                    segment,
                  ) => ({
                    start:
                      segment.start,
                    timestamp:
                      formatTimestamp(
                        segment.start,
                      ),
                    text:
                      segment.text
                        .replace(
                          /\s+/g,
                          " ",
                        )
                        .trim(),
                  }),
                ),
          };

        setTranscript(
          nextTranscript,
        );

        chrome.storage.local
          .set({
            [`transcript:${currentVideo.id}`]:
              nextTranscript,
          })
          .catch(() => {});

        setLoading(false);
        setError(null);
        setTranscriptionState(
          "idle",
        );

        return;
      }

      if (
        message.type ===
        "TRANSCRIPTION_ERROR"
      ) {
        setError(
          message.error ??
            "Transcription failed.",
        );

        setLoading(false);
        setTranscriptionState(
          "idle",
        );
      }
    };

    chrome.runtime.onMessage.addListener(
      listener,
    );

    return () => {
      chrome.runtime.onMessage.removeListener(
        listener,
      );
    };
  }, [
    applyContext,
    loadActiveContext,
    video,
  ]);

  return (
    <div className="app">
      <header className="header">
        <div>
          <div className="eyebrow">
            LEARNING COMPANION
          </div>

          <h1>
            YouTube Companion
          </h1>
        </div>

        <span className="status-dot" />
      </header>

      <main className="content">
        {!video ? (
          <section className="home">
            <div className="home-icon">
              ▶
            </div>

            <div className="eyebrow">
              YOUR LEARNING SPACE
            </div>

            <h2>
              Learn from
              <br />
              any video.
            </h2>

            <p>
              Open a YouTube
              educational video and
              turn it into an
              interactive learning
              experience.
            </p>

            <div className="feature-list">
              <div className="feature">
                <span>01</span>

                <div>
                  <strong>
                    Smart transcripts
                  </strong>

                  <small>
                    Read and navigate
                    every part of a
                    video.
                  </small>
                </div>
              </div>

              <div className="feature">
                <span>02</span>

                <div>
                  <strong>
                    AI-powered learning
                  </strong>

                  <small>
                    Summaries, chapters,
                    notes and questions.
                  </small>
                </div>
              </div>

              <div className="feature">
                <span>03</span>

                <div>
                  <strong>
                    Build your knowledge
                  </strong>

                  <small>
                    Save what you learn
                    and revisit it later.
                  </small>
                </div>
              </div>
            </div>

            <div className="home-hint">
              Open a YouTube video to
              get started.
            </div>
          </section>
        ) : (
          <>
            <section className="video-card">
              <div className="label">
                CURRENT VIDEO
              </div>

              <h2>
                {video.title}
              </h2>

              <div className="video-id">
                {video.id}
              </div>
            </section>

            <section className="section">
              <div className="section-header">
                <div>
                  <div className="label">
                    TRANSCRIPT
                  </div>

                  <h2>
                    {transcript
                      ? `${transcript.segments.length} segments`
                      : "Video Transcript"}
                  </h2>
                </div>

                {!transcript && (
                  <button
                    className="primary-button"
                    onClick={
                      transcriptionState ===
                      "capturing"
                        ? stopTranscription
                        : startTranscription
                    }
                    disabled={
                      loading
                    }
                  >
                    {transcriptionState ===
                    "capturing"
                      ? "Stop & Transcribe"
                      : transcriptionState ===
                          "processing"
                        ? "Transcribing..."
                        : loading
                          ? "Starting..."
                          : "Load Transcript"}
                  </button>
                )}
              </div>

              {transcriptionState ===
                "capturing" && (
                <div className="error">
                  Recording the video
                  audio. Click
                  <strong>
                    {" "}
                    Stop & Transcribe
                  </strong>{" "}
                  when ready.
                </div>
              )}

              {transcriptionState ===
                "processing" && (
                <div className="error">
                  Transcribing audio with
                  the local Whisper server.
                </div>
              )}

              {error && (
                <div className="error">
                  {error}
                </div>
              )}

              {transcript && (
                <div className="transcript">
                  {transcript.segments.map(
                    (
                      segment,
                      index,
                    ) => (
                      <button
                        className="segment"
                        key={`${segment.start}-${index}`}
                        onClick={() =>
                          seekTo(
                            segment.start,
                          )
                        }
                      >
                        <span className="timestamp">
                          {
                            segment.timestamp
                          }
                        </span>

                        <span className="segment-text">
                          {
                            segment.text
                          }
                        </span>
                      </button>
                    ),
                  )}
                </div>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}

export default App;