import {
  useCallback,
  useEffect,
  useState,
} from "react";
import "./App.css";
import type {
  VideoInfo,
  Transcript,
  TranscriptSegment,
  TranscriptionStatus,
} from "./types/transcript";

interface ActiveContext {
  tabId: number | null;
  video: VideoInfo | null;
}

interface BackgroundResponse {
  success: boolean;
  context: ActiveContext;
}

function formatTimestamp(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(
      2,
      "0",
    )}:${String(remainingSeconds).padStart(2, "0")}`;
  }

  return `${String(minutes).padStart(2, "0")}:${String(
    remainingSeconds,
  ).padStart(2, "0")}`;
}

function formatTimestampRange(start: number, end?: number): string {
  const startStr = formatTimestamp(start);
  if (end !== undefined && end > start) {
    return `[${startStr} - ${formatTimestamp(end)}]`;
  }
  return `[${startStr}]`;
}

function App() {
  const [video, setVideo] = useState<VideoInfo | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [transcriptionState, setTranscriptionState] =
    useState<TranscriptionStatus>("idle");
  const [capturedAudioDuration, setCapturedAudioDuration] = useState<number>(0);
  const [capturedBytes, setCapturedBytes] = useState<number>(0);
  const [processingStage, setProcessingStage] = useState<string>("");

  const restoreTranscript = useCallback(async (videoId: string) => {
    try {
      const key = `transcript:${videoId}`;
      const result = await chrome.storage.local.get(key);
      const cached = result[key] as Transcript | undefined;

      if (
        cached &&
        cached.videoId === videoId &&
        Array.isArray(cached.segments) &&
        cached.segments.length > 0
      ) {
        setTranscript(cached);
        return;
      }

      setTranscript(null);
    } catch {
      setTranscript(null);
    }
  }, []);

  const applyContext = useCallback(
    async (context: ActiveContext) => {
      const nextVideo = context.video;

      if (!nextVideo?.id) {
        setVideo(null);
        setTranscript(null);
        setError(null);
        setLoading(false);
        setTranscriptionState("idle");
        setCapturedAudioDuration(0);
        setCapturedBytes(0);
        return;
      }

      const isDifferentVideo = video?.id !== nextVideo.id;
      setVideo(nextVideo);

      if (isDifferentVideo) {
        setError(null);
        setTranscript(null);
        setTranscriptionState("idle");
        setLoading(false);
        setCapturedAudioDuration(0);
        setCapturedBytes(0);
      }

      if (transcript?.videoId !== nextVideo.id) {
        setTranscript(null);
      }

      await restoreTranscript(nextVideo.id);
    },
    [restoreTranscript, transcript?.videoId, video?.id],
  );

  const loadActiveContext = useCallback(async () => {
    try {
      const response = (await chrome.runtime.sendMessage({
        type: "GET_ACTIVE_CONTEXT",
      })) as BackgroundResponse;

      if (response?.success && response.context) {
        await applyContext(response.context);
      }
    } catch {
      setVideo(null);
      setTranscript(null);
    }
  }, [applyContext]);

  const startTranscription = async (mode: "auto" | "audio" = "auto") => {
    if (!video?.id) {
      return;
    }

    if (
      transcriptionState === "capturing" ||
      transcriptionState === "transcribing" ||
      transcriptionState === "finalizing"
    ) {
      return;
    }

    setError(null);
    setLoading(true);
    setTranscriptionState("detecting_video");
    setCapturedAudioDuration(0);
    setCapturedBytes(0);

    try {
      setTranscriptionState("preparing");
      const response = (await chrome.runtime.sendMessage({
        type: "START_TRANSCRIPTION",
        mode,
      })) as {
        success?: boolean;
        error?: string;
        method?: string;
        isPaused?: boolean;
      };

      if (!response?.success) {
        throw new Error(
          response?.error ?? "Failed to start transcription process.",
        );
      }

      if (response.method === "captions") {
        setTranscriptionState("finalizing");
        setLoading(false);
        return;
      }

      // Audio capture mode started
      setTranscriptionState(response.isPaused ? "paused" : "capturing");
      setLoading(false);
    } catch (err) {
      setLoading(false);
      setTranscriptionState("failed");
      setError(
        err instanceof Error ? err.message : "Could not start transcription.",
      );
    }
  };

  const stopTranscription = async () => {
    setLoading(true);
    setTranscriptionState("transcribing");
    setProcessingStage("Processing audio with local Whisper engine...");

    try {
      const response = (await chrome.runtime.sendMessage({
        type: "STOP_TRANSCRIPTION",
      })) as { success?: boolean; error?: string };

      if (!response?.success) {
        throw new Error(
          response?.error ?? "Failed to stop audio transcription.",
        );
      }
    } catch (err) {
      setLoading(false);
      setTranscriptionState("failed");
      setError(
        err instanceof Error ? err.message : "Could not stop transcription.",
      );
    }
  };

  const playVideoOnTab = async () => {
    try {
      await chrome.runtime.sendMessage({ type: "PLAY_VIDEO" });
      setTranscriptionState("capturing");
    } catch {
      // Ignore
    }
  };

  const pauseVideoOnTab = async () => {
    try {
      await chrome.runtime.sendMessage({ type: "PAUSE_VIDEO" });
      setTranscriptionState("paused");
    } catch {
      // Ignore
    }
  };

  const cancelTranscription = async () => {
    try {
      await chrome.runtime.sendMessage({
        type: "CANCEL_TRANSCRIPTION",
      });
    } catch {
      // Ignore
    } finally {
      setTranscriptionState("cancelled");
      setLoading(false);
      setCapturedAudioDuration(0);
      setCapturedBytes(0);
      setProcessingStage("");
      setTimeout(() => {
        setTranscriptionState("idle");
      }, 1000);
    }
  };

  const seekTo = async (time: number) => {
    try {
      const response = (await chrome.runtime.sendMessage({
        type: "GET_ACTIVE_CONTEXT",
      })) as BackgroundResponse;

      if (!response?.success || !response.context) {
        return;
      }

      const tabId = response.context.tabId;
      const currentVideo = response.context.video;

      if (!tabId || !currentVideo?.id || currentVideo.id !== video?.id) {
        await applyContext(response.context);
        return;
      }

      await chrome.tabs.sendMessage(tabId, {
        type: "SEEK_VIDEO",
        time,
      });
    } catch {
      setError("Could not seek video. Please verify the YouTube tab is active.");
    }
  };

  const copyTranscriptToClipboard = () => {
    if (!transcript) return;
    const text = transcript.segments
      .map((s) => `${formatTimestampRange(s.start, s.end)} ${s.text}`)
      .join("\n");
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const downloadTranscript = () => {
    if (!transcript) return;
    const title = video?.title || "youtube-transcript";
    const text = [
      `Title: ${title}`,
      `Video ID: ${transcript.videoId}`,
      `Source: ${transcript.source || "Transcription"}`,
      `Language: ${transcript.language || "auto"}`,
      "",
      ...transcript.segments.map(
        (s) => `${formatTimestampRange(s.start, s.end)} ${s.text}`,
      ),
    ].join("\n");

    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.replace(/[^a-z0-9]/gi, "_").toLowerCase()}_transcript.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  useEffect(() => {
    loadActiveContext();

    const listener = (message: any) => {
      if (message?.type === "ACTIVE_CONTEXT_UPDATED" && message.context) {
        applyContext(message.context);
        return;
      }

      if (message?.type === "PLAYBACK_STATE_CHANGED") {
        setVideo((prev) =>
          prev
            ? {
                ...prev,
                isPaused: message.isPaused,
                currentTime: message.currentTime,
                duration: message.duration ?? prev.duration,
              }
            : prev,
        );

        if (transcriptionState === "capturing" && message.isPaused) {
          setTranscriptionState("paused");
        } else if (transcriptionState === "paused" && !message.isPaused) {
          setTranscriptionState("capturing");
        }
        return;
      }

      if (message?.type === "TRANSCRIPTION_STARTED") {
        setLoading(true);
        setTranscriptionState("preparing");
        setError(null);
        return;
      }

      if (message?.type === "AUDIO_CAPTURE_STARTED") {
        setLoading(false);
        setTranscriptionState("capturing");
        setError(null);
        return;
      }

      if (message?.type === "AUDIO_CAPTURE_PROGRESS") {
        const seconds = Math.round((message.durationMs ?? 0) / 1000);
        setCapturedAudioDuration(seconds);
        setCapturedBytes(message.bytes ?? 0);
        if (transcriptionState !== "paused") {
          setTranscriptionState("capturing");
        }
        return;
      }

      if (message?.type === "TRANSCRIPTION_PAUSED") {
        setTranscriptionState("paused");
        return;
      }

      if (message?.type === "TRANSCRIPTION_RESUMED") {
        setTranscriptionState("capturing");
        return;
      }

      if (message?.type === "TRANSCRIPTION_PROGRESS") {
        setLoading(true);
        setTranscriptionState("transcribing");
        if (message.stage === "sending") {
          setProcessingStage("Sending recorded audio to Whisper server...");
        } else if (message.stage === "parsing") {
          setProcessingStage("Transcribing speech with Whisper neural model...");
        }
        return;
      }

      if (
        (message?.type === "TRANSCRIPTION_COMPLETED" ||
          message?.type === "TRANSCRIPTION_COMPLETE") &&
        message.transcript
      ) {
        if (!video?.id || !message.transcript.segments) {
          setLoading(false);
          setTranscriptionState("idle");
          return;
        }

        const rawSegments = message.transcript.segments as Array<{
          start: number;
          end?: number;
          text: string;
        }>;

        const nextTranscript: Transcript = {
          videoId: video.id,
          title: video.title,
          language: message.transcript.language,
          languageProbability: message.transcript.languageProbability,
          source: message.transcript.source || "youtube_captions",
          duration: video.duration,
          segments: rawSegments
            .filter(
              (segment) =>
                Number.isFinite(segment.start) &&
                segment.text &&
                segment.text.trim().length > 0,
            )
            .map((segment) => ({
              start: segment.start,
              end: segment.end,
              timestamp: formatTimestamp(segment.start),
              endTimestamp:
                segment.end !== undefined
                  ? formatTimestamp(segment.end)
                  : undefined,
              text: segment.text.replace(/\s+/g, " ").trim(),
            })),
        };

        setTranscript(nextTranscript);

        chrome.storage.local
          .set({
            [`transcript:${video.id}`]: nextTranscript,
          })
          .catch(() => {});

        setLoading(false);
        setError(null);
        setTranscriptionState("completed");
        setProcessingStage("");

        setTimeout(() => {
          setTranscriptionState("idle");
        }, 1500);

        return;
      }

      if (
        message?.type === "TRANSCRIPTION_FAILED" ||
        message?.type === "TRANSCRIPTION_ERROR"
      ) {
        setError(message.error ?? "Transcription process failed.");
        setLoading(false);
        setTranscriptionState("failed");
        setProcessingStage("");
        return;
      }

      if (message?.type === "TRANSCRIPTION_CANCELLED") {
        setTranscriptionState("cancelled");
        setLoading(false);
        setCapturedAudioDuration(0);
        setCapturedBytes(0);
        setProcessingStage("");
        setTimeout(() => {
          setTranscriptionState("idle");
        }, 1200);
        return;
      }
    };

    chrome.runtime.onMessage.addListener(listener);

    return () => {
      chrome.runtime.onMessage.removeListener(listener);
    };
  }, [applyContext, loadActiveContext, transcriptionState, video]);

  const hasFiniteDuration =
    typeof video?.duration === "number" && video.duration > 0;

  return (
    <div className="app">
      <header className="header">
        <div>
          <div className="eyebrow">LEARNING COMPANION</div>
          <h1>YouTube Companion</h1>
        </div>
        <span
          className={`status-dot ${
            transcriptionState === "capturing"
              ? "status-dot-capturing"
              : transcriptionState === "transcribing" ||
                transcriptionState === "preparing" ||
                transcriptionState === "detecting_video" ||
                transcriptionState === "finalizing"
                ? "status-dot-processing"
                : transcriptionState === "paused"
                  ? "status-dot-paused"
                  : ""
          }`}
          title={`Status: ${transcriptionState}`}
        />
      </header>

      <main className="content">
        {!video ? (
          <section className="home">
            <div className="home-icon">▶</div>
            <div className="eyebrow">YOUR LEARNING SPACE</div>
            <h2>
              Learn from
              <br />
              any video.
            </h2>
            <p>
              Open any YouTube educational video to generate full transcripts,
              summaries, and jump to any topic.
            </p>

            <div className="feature-list">
              <div className="feature">
                <span>01</span>
                <div>
                  <strong>Instant complete transcripts</strong>
                  <small>
                    Extracts full video text even when paused or fast-forwarded.
                  </small>
                </div>
              </div>
              <div className="feature">
                <span>02</span>
                <div>
                  <strong>Clickable timestamps</strong>
                  <small>Jump directly to relevant parts of the video.</small>
                </div>
              </div>
              <div className="feature">
                <span>03</span>
                <div>
                  <strong>Local Whisper AI fallback</strong>
                  <small>
                    High-accuracy speech-to-text for videos without captions.
                  </small>
                </div>
              </div>
            </div>

            <div className="home-hint">Open a YouTube video to get started.</div>
          </section>
        ) : (
          <>
            <section className="video-card">
              <div className="video-card-top">
                <div className="label">CURRENT VIDEO</div>
                {hasFiniteDuration && (
                  <span className="duration-pill">
                    ⏱ {formatTimestamp(video.duration!)}
                  </span>
                )}
              </div>

              <h2>{video.title}</h2>

              <div className="video-meta-row">
                <span className="video-id">{video.id}</span>
                <span className="playback-pill">
                  {video.isPaused ? "⏸ Paused" : "▶ Playing"}
                </span>
                {video.hasCaptions !== undefined && (
                  <span
                    className={`caption-pill ${video.hasCaptions ? "has-caps" : "no-caps"}`}
                  >
                    {video.hasCaptions ? "CC Available" : "No CC (Audio AI)"}
                  </span>
                )}
              </div>
            </section>

            <section className="section">
              <div className="section-header">
                <div>
                  <div className="label">TRANSCRIPT</div>
                  <h2>
                    {transcript
                      ? `${transcript.segments.length} segments`
                      : "Full Video Transcript"}
                  </h2>
                </div>

                {!transcript && (
                  <div className="button-group">
                    {transcriptionState === "capturing" ||
                    transcriptionState === "paused" ? (
                      <>
                        <button
                          className="primary-button danger-button"
                          onClick={stopTranscription}
                          disabled={loading}
                        >
                          Stop & Transcribe
                        </button>
                        {transcriptionState === "capturing" ? (
                          <button
                            className="secondary-button"
                            onClick={pauseVideoOnTab}
                            title="Pause video playback and audio capture"
                          >
                            Pause
                          </button>
                        ) : (
                          <button
                            className="secondary-button"
                            onClick={playVideoOnTab}
                            title="Resume video playback and audio capture"
                          >
                            Play & Resume
                          </button>
                        )}
                        <button
                          className="secondary-button"
                          onClick={cancelTranscription}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className="primary-button"
                          onClick={() => startTranscription("auto")}
                          disabled={loading}
                          title="Generate complete transcript (instant from captions, or via Whisper)"
                        >
                          {transcriptionState === "detecting_video"
                            ? "Detecting..."
                            : transcriptionState === "preparing"
                              ? "Preparing..."
                              : transcriptionState === "transcribing"
                                ? "Transcribing..."
                                : transcriptionState === "finalizing"
                                  ? "Finalizing..."
                                  : loading
                                    ? "Starting..."
                                    : "Start Transcription"}
                        </button>

                        <button
                          className="secondary-button"
                          onClick={() => startTranscription("audio")}
                          disabled={loading}
                          title="Force audio capture and transcription via local Whisper"
                        >
                          Record Audio
                        </button>
                      </>
                    )}
                  </div>
                )}

                {transcript && (
                  <div className="button-group">
                    <button
                      className="secondary-button"
                      onClick={copyTranscriptToClipboard}
                      title="Copy entire transcript to clipboard"
                    >
                      {copied ? "✓ Copied" : "Copy"}
                    </button>
                    <button
                      className="secondary-button"
                      onClick={downloadTranscript}
                      title="Download transcript as text file"
                    >
                      Download
                    </button>
                    <button
                      className="secondary-button"
                      onClick={() => setTranscript(null)}
                      title="Clear transcript to re-run or inspect again"
                    >
                      Clear
                    </button>
                  </div>
                )}
              </div>

              {/* Status & Guidance Boxes */}
              {transcriptionState === "detecting_video" && (
                <div className="info-box processing-box">
                  <div className="spinner" />
                  <div>
                    <strong>Detecting YouTube Video...</strong>
                    <p>
                      Reading video details and verifying transcript
                      availability.
                    </p>
                  </div>
                </div>
              )}

              {transcriptionState === "preparing" && (
                <div className="info-box processing-box">
                  <div className="spinner" />
                  <div>
                    <strong>Preparing Full Transcript...</strong>
                    <p>
                      Checking complete YouTube transcript tracks from 00:00 to{" "}
                      {hasFiniteDuration
                        ? formatTimestamp(video.duration!)
                        : "end"}
                      . Works even when video is paused.
                    </p>
                  </div>
                </div>
              )}

              {transcriptionState === "capturing" && (
                <div className="info-box capturing-box">
                  <div className="pulse-indicator" />
                  <div>
                    <strong>Live Audio Capture in Progress</strong>
                    <p className="capture-timer">
                      Captured:{" "}
                      <strong>{formatTimestamp(capturedAudioDuration)}</strong>{" "}
                      {hasFiniteDuration && (
                        <span> / {formatTimestamp(video.duration!)}</span>
                      )}{" "}
                      ({Math.round(capturedBytes / 1024)} KB)
                    </p>
                    <p className="capture-hint">
                      Audio is recording from the playing video. Click{" "}
                      <strong>Stop & Transcribe</strong> when finished.
                    </p>
                  </div>
                </div>
              )}

              {transcriptionState === "paused" && (
                <div className="info-box paused-box">
                  <div className="pause-icon">⏸</div>
                  <div>
                    <strong>Video is Paused</strong>
                    <p>
                      {capturedAudioDuration > 0
                        ? `Capture paused at ${formatTimestamp(capturedAudioDuration)}. Live capture requires video playback.`
                        : "Live audio capture cannot record while the video is paused. Click Play on YouTube or use the button below."}
                    </p>
                    <div className="box-action-row">
                      <button
                        className="primary-button small-button"
                        onClick={playVideoOnTab}
                      >
                        ▶ Play Video & Record
                      </button>
                      {capturedAudioDuration > 0 && (
                        <button
                          className="secondary-button small-button"
                          onClick={stopTranscription}
                        >
                          Transcribe Captured Audio Now
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {transcriptionState === "transcribing" && (
                <div className="info-box processing-box">
                  <div className="spinner" />
                  <div>
                    <strong>Transcribing Audio with Whisper</strong>
                    <p>
                      {processingStage ||
                        "Processing audio through local neural model..."}
                    </p>
                    <small className="honest-hint">
                      This processes the complete recorded audio without faking
                      progress.
                    </small>
                  </div>
                </div>
              )}

              {transcriptionState === "finalizing" && (
                <div className="info-box success-box">
                  <div className="spinner" />
                  <div>
                    <strong>Finalizing Complete Transcript...</strong>
                    <p>
                      Organizing timestamped segments from beginning to end.
                    </p>
                  </div>
                </div>
              )}

              {transcriptionState === "completed" && (
                <div className="info-box success-box">
                  ✓ Full transcript successfully loaded!
                </div>
              )}

              {transcriptionState === "cancelled" && (
                <div className="info-box cancelled-box">
                  Transcription was cancelled.
                </div>
              )}

              {error && (
                <div className="error">
                  <div className="error-title">Transcription Notice / Error:</div>
                  <div>{error}</div>

                  {error.includes("activeTab") ||
                  error.includes("invoked") ||
                  error.includes("permission") ? (
                    <div className="error-help">
                      <strong>How to grant permission:</strong>
                      <br />
                      1. Click the <strong>extension icon</strong> in your
                      Chrome toolbar (or press <code>Alt+Shift+Y</code>).
                      <br />
                      2. Ensure the YouTube video is open in your tab.
                      <br />
                      3. Click <strong>Start Transcription</strong> again.
                    </div>
                  ) : error.includes("Failed to fetch") ||
                    error.includes("server") ||
                    error.includes("8000") ? (
                    <div className="error-help">
                      <strong>Whisper Server Notice:</strong>
                      <br />
                      If capturing audio, make sure the local server is running:
                      <br />
                      <code>cd transcriber && uvicorn server:app --reload</code>
                    </div>
                  ) : null}
                </div>
              )}

              {/* Transcript Display */}
              {transcript && (
                <div className="transcript">
                  <div className="transcript-metadata">
                    <span className="source-tag">
                      {transcript.source === "youtube_captions"
                        ? "★ YouTube Captions (Full Video)"
                        : "⚡ Whisper AI Transcription"}
                    </span>

                    {transcript.language && (
                      <span className="lang-tag">
                        Language:{" "}
                        <strong>{transcript.language.toUpperCase()}</strong>
                      </span>
                    )}

                    <span className="transcript-count">
                      {transcript.segments.length} segments
                    </span>
                  </div>

                  {transcript.segments.map((segment, index) => (
                    <button
                      className="segment"
                      key={`${segment.start}-${index}`}
                      onClick={() => seekTo(segment.start)}
                      title="Click to seek video to this timestamp"
                    >
                      <span className="timestamp">
                        {formatTimestampRange(segment.start, segment.end)}
                      </span>
                      <span className="segment-text">{segment.text}</span>
                    </button>
                  ))}
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