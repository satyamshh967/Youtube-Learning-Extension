import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import "./App.css";
import type {
  VideoInfo,
  Transcript,
  TranscriptionStatus,
} from "./types/transcript";
import {
  exportToSrt,
  formatTranscriptAsScript,
  formatTranscriptWithTimestamps,
} from "./utils/transcriptAnalysis";
import {
  getApiKey,
  generateAIChapters,
  generateAISummary,
  generateAIScriptFallback,
  formatAIChaptersForExport,
  formatAIChaptersDetailedForExport,
  formatAISummaryForExport,
  type AIChapter,
  type AISummary,
} from "./utils/aiService";

interface ActiveContext {
  tabId: number | null;
  video: VideoInfo | null;
}

interface BackgroundResponse {
  success: boolean;
  context: ActiveContext;
}

type TabType = "transcript" | "summary" | "chapters";

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

function App() {
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    return (localStorage.getItem("yt_companion_theme") as "dark" | "light") || "dark";
  });

  const [video, setVideo] = useState<VideoInfo | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [loading, setLoading] = useState(false);
  const [isSlowLoading, setIsSlowLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedMessage, setCopiedMessage] = useState<string | null>(null);
  const [transcriptionState, setTranscriptionState] =
    useState<TranscriptionStatus>("idle");
  const [activeTab, setActiveTab] = useState<TabType>("transcript");

  const [searchQuery, setSearchQuery] = useState("");
  const [activeMatchIdx, setActiveMatchIdx] = useState(0);

  const [summary, setSummary] = useState<AISummary | null>(null);
  const [chapters, setChapters] = useState<AIChapter[]>([]);

  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    localStorage.setItem("yt_companion_theme", next);
  };

  const showCopied = (msg = "Copied to clipboard") => {
    setCopiedMessage(msg);
    setTimeout(() => setCopiedMessage(null), 2000);
  };

  const populateAnalysis = useCallback(
    async (currTranscript: Transcript) => {
      setSummary(null);
      setChapters([]);

      const apiKey = getApiKey();
      if (!apiKey) {
        setAiError("No Gemini API key configured. Set VITE_GEMINI_API_KEY in your .env file to enable AI summary & chapters.");
        return;
      }

      setAiLoading(true);
      setAiError(null);

      try {
        const [aiSummary, aiChapters] = await Promise.all([
          generateAISummary(
            currTranscript.segments,
            currTranscript.title || video?.title || "Video",
          ),
          generateAIChapters(
            currTranscript.segments,
            currTranscript.title || video?.title || "Video",
            currTranscript.duration ?? video?.duration,
          ),
        ]);

        setSummary(aiSummary);
        setChapters(aiChapters);
      } catch (err) {
        setAiError(
          err instanceof Error ? err.message : "AI generation failed. Please try again.",
        );
      } finally {
        setAiLoading(false);
      }
    },
    [video?.title, video?.duration],
  );

  const handleAIFallbackScript = useCallback(
    async (targetVideo: VideoInfo) => {
      const apiKey = getApiKey();
      if (!apiKey) {
        setError(
          "YouTube captions are unavailable for this video. To have AI automatically generate the full spoken script, summary, and chapters, please add your Gemini API key to .env (VITE_GEMINI_API_KEY).",
        );
        setLoading(false);
        setAiLoading(false);
        setTranscriptionState("failed");
        return;
      }

      setLoading(true);
      setAiLoading(true);
      setError(null);
      setTranscriptionState("loading");

      try {
        const fallbackResult = await generateAIScriptFallback(targetVideo);

        const aiTranscript: Transcript = {
          videoId: targetVideo.id || "unknown",
          title: targetVideo.title,
          language: "en",
          source: "ai_generated",
          duration: targetVideo.duration,
          segments: fallbackResult.segments,
        };

        setTranscript(aiTranscript);
        setSummary(fallbackResult.summary);
        setChapters(fallbackResult.chapters);
        setTranscriptionState("completed");
        setError(null);

        if (targetVideo.id) {
          chrome.storage.local
            .set({
              [`transcript:${targetVideo.id}`]: aiTranscript,
            })
            .catch(() => {});
        }
      } catch (err) {
        setError(
          err instanceof Error
            ? `AI Script generation failed: ${err.message}`
            : "Failed to generate AI script.",
        );
        setTranscriptionState("failed");
      } finally {
        setLoading(false);
        setAiLoading(false);
      }
    },
    [],
  );

  const restoreTranscript = useCallback(
    async (videoId: string) => {
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
          populateAnalysis(cached);
          setTranscriptionState("completed");
          return;
        }

        setTranscript(null);
        setSummary(null);
        setChapters([]);
        setTranscriptionState("idle");
      } catch {
        setTranscript(null);
        setTranscriptionState("idle");
      }
    },
    [populateAnalysis],
  );

  const applyContext = useCallback(
    async (context: ActiveContext) => {
      const nextVideo = context.video;

      if (!nextVideo?.id) {
        setVideo(null);
        setTranscript(null);
        setError(null);
        setLoading(false);
        setTranscriptionState("idle");
        return;
      }

      const isDifferentVideo = video?.id !== nextVideo.id;
      setVideo(nextVideo);

      if (isDifferentVideo) {
        setError(null);
        setTranscript(null);
        setSummary(null);
        setChapters([]);
        setSearchQuery("");
        setActiveMatchIdx(0);
        setLoading(false);
        setTranscriptionState("idle");
        setActiveTab("transcript");
        setAiError(null);
        setAiLoading(false);
        await restoreTranscript(nextVideo.id);
      }
    },
    [restoreTranscript, video?.id],
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

  const showTranscription = async () => {
    if (!video?.id || loading) {
      return;
    }

    setError(null);
    setLoading(true);
    setTranscriptionState("loading");

    try {
      const response = (await chrome.runtime.sendMessage({
        type: "START_TRANSCRIPTION",
      })) as {
        success?: boolean;
        error?: string;
        segmentsCount?: number;
      };

      if (!response?.success) {
        await handleAIFallbackScript(video);
      }
    } catch {
      await handleAIFallbackScript(video);
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

  const matchingIndices = useMemo(() => {
    if (!transcript || !searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase().trim();
    const indices: number[] = [];
    transcript.segments.forEach((seg, idx) => {
      if (seg.text.toLowerCase().includes(q)) {
        indices.push(idx);
      }
    });
    return indices;
  }, [transcript, searchQuery]);

  const scrollToSegment = (index: number) => {
    const el = document.getElementById(`seg-${index}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };

  const nextMatch = () => {
    if (matchingIndices.length === 0) return;
    const nextIdx = (activeMatchIdx + 1) % matchingIndices.length;
    setActiveMatchIdx(nextIdx);
    scrollToSegment(matchingIndices[nextIdx]);
  };

  const prevMatch = () => {
    if (matchingIndices.length === 0) return;
    const prevIdx =
      (activeMatchIdx - 1 + matchingIndices.length) % matchingIndices.length;
    setActiveMatchIdx(prevIdx);
    scrollToSegment(matchingIndices[prevIdx]);
  };

  const clearAll = () => {
    setTranscript(null);
    setSummary(null);
    setChapters([]);
    setTranscriptionState("idle");
    setSearchQuery("");
    setActiveMatchIdx(0);
    setAiError(null);
  };

  const retryAI = () => {
    if (transcript?.source === "ai_generated" && video) {
      handleAIFallbackScript(video);
    } else if (transcript) {
      populateAnalysis(transcript);
    }
  };

  const copyTranscriptScript = () => {
    if (!transcript) return;
    const text = formatTranscriptAsScript(transcript.segments);
    navigator.clipboard.writeText(text).then(() => {
      showCopied("Script copied (clean text)");
    });
  };

  const copyTranscriptWithTimestamps = () => {
    if (!transcript) return;
    const text = formatTranscriptWithTimestamps(transcript.segments);
    navigator.clipboard.writeText(text).then(() => {
      showCopied("Timestamps copied");
    });
  };

  const downloadTranscriptTxt = () => {
    if (!transcript) return;
    const title = video?.title || "youtube-transcript";
    const cleanTitle = title.replace(/[^a-z0-9]/gi, "_").toLowerCase();
    const text = formatTranscriptAsScript(transcript.segments);
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${cleanTitle}_script.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadTranscriptSrt = () => {
    if (!transcript) return;
    const title = video?.title || "youtube-transcript";
    const cleanTitle = title.replace(/[^a-z0-9]/gi, "_").toLowerCase();
    const srtContent = exportToSrt(transcript.segments);
    const blob = new Blob([srtContent], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${cleanTitle}_subtitles.srt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copySummaryText = () => {
    if (!summary) return;
    const text = formatAISummaryForExport(summary, video?.title);
    navigator.clipboard.writeText(text).then(() => {
      showCopied("Summary copied (Markdown)");
    });
  };

  const downloadSummaryMd = () => {
    if (!summary) return;
    const title = video?.title || "youtube-summary";
    const cleanTitle = title.replace(/[^a-z0-9]/gi, "_").toLowerCase();
    const text = formatAISummaryForExport(summary, video?.title);
    const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${cleanTitle}_summary.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyChaptersYouTube = () => {
    if (chapters.length === 0) return;
    const text = formatAIChaptersForExport(chapters);
    navigator.clipboard.writeText(text).then(() => {
      showCopied("YouTube timestamps copied");
    });
  };

  const copyChaptersDetailed = () => {
    if (chapters.length === 0) return;
    const text = formatAIChaptersDetailedForExport(chapters, video?.title);
    navigator.clipboard.writeText(text).then(() => {
      showCopied("Chapters with details copied");
    });
  };

  const downloadChaptersTxt = () => {
    if (chapters.length === 0) return;
    const title = video?.title || "youtube-chapters";
    const cleanTitle = title.replace(/[^a-z0-9]/gi, "_").toLowerCase();
    const text = formatAIChaptersDetailedForExport(chapters, video?.title);
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${cleanTitle}_chapters.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const updateChapterTitle = (id: string, newTitle: string) => {
    setChapters((prev) =>
      prev.map((c) => (c.id === id ? { ...c, title: newTitle } : c)),
    );
  };

  const deleteChapter = (id: string) => {
    setChapters((prev) => prev.filter((c) => c.id !== id));
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
        return;
      }

      if (message?.type === "TRANSCRIPTION_STARTED") {
        setLoading(true);
        setTranscriptionState("loading");
        setError(null);
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

        if (message.videoId && message.videoId !== video.id) {
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
        populateAnalysis(nextTranscript);

        chrome.storage.local
          .set({
            [`transcript:${video.id}`]: nextTranscript,
          })
          .catch(() => {});

        setLoading(false);
        setError(null);
        setTranscriptionState("completed");
        return;
      }

      if (
        message?.type === "TRANSCRIPTION_FAILED" ||
        message?.type === "TRANSCRIPTION_ERROR"
      ) {
        if (message.videoId && message.videoId !== video?.id) {
          return;
        }

        if (video) {
          handleAIFallbackScript(video);
        } else {
          setError(
            message.error ??
              "YouTube captions are unavailable for this video. A full fallback transcription source is not currently available.",
          );
          setLoading(false);
          setTranscriptionState("failed");
        }
        return;
      }
    };

    chrome.runtime.onMessage.addListener(listener);

    return () => {
      chrome.runtime.onMessage.removeListener(listener);
    };
  }, [applyContext, handleAIFallbackScript, loadActiveContext, populateAnalysis, video]);

  useEffect(() => {
    if (!loading) {
      setIsSlowLoading(false);
      return;
    }

    const timer = window.setTimeout(() => {
      setIsSlowLoading(true);
    }, 3200);

    return () => window.clearTimeout(timer);
  }, [loading]);

  const hasFiniteDuration =
    typeof video?.duration === "number" && video.duration > 0;

  const renderHighlightedText = (text: string, isCurrentMatch: boolean) => {
    if (!searchQuery.trim()) {
      return text;
    }
    const q = searchQuery.toLowerCase();
    const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"));

    return parts.map((part, i) =>
      part.toLowerCase() === q ? (
        <mark
          key={i}
          className={`search-mark ${isCurrentMatch ? "current-mark" : ""}`}
        >
          {part}
        </mark>
      ) : (
        part
      ),
    );
  };

  return (
    <div className={`app ${theme}`}>
      <header className="header">
        <div className="header-brand">
          <div className="brand-badge">⚡</div>
          <div>
            <div className="eyebrow">SMART LEARNING</div>
            <h1>YouTube Companion</h1>
          </div>
        </div>

        <div className="header-right">
          {copiedMessage && <span className="copied-pill">✓ {copiedMessage}</span>}
          
          <button
            className="theme-toggle-btn"
            onClick={toggleTheme}
            title={`Switch to ${theme === "dark" ? "Light" : "Dark"} Mode`}
          >
            {theme === "dark" ? "☀️" : "🌙"}
          </button>

          <span
            className={`status-dot ${
              loading || aiLoading
                ? "status-dot-processing"
                : transcriptionState === "completed"
                  ? "status-dot-completed"
                  : ""
            }`}
            title={`Status: ${loading ? "Retrieving transcript..." : aiLoading ? "Generating AI analysis..." : transcriptionState}`}
          />
        </div>
      </header>

      <main className="content">
        {!video ? (
          <section className="home">
            <div className="home-icon">✨</div>
            <div className="eyebrow">YOUR SMART ASSISTANT</div>
            <h2>Learn faster from any video.</h2>
            <p>
              Open any YouTube video to retrieve complete transcripts, search dialogue,
              generate AI-powered structured summaries, and explore smart chapters.
            </p>

            <div className="feature-list">
              <div className="feature-item">
                <span className="feature-num">01</span>
                <div>
                  <strong>Full Instant Transcripts</strong>
                  <small>Read the complete spoken script without video pauses.</small>
                </div>
              </div>
              <div className="feature-item">
                <span className="feature-num">02</span>
                <div>
                  <strong>AI Smart Summaries</strong>
                  <small>Deep overview, key bullet points, explanations, and takeaways.</small>
                </div>
              </div>
              <div className="feature-item">
                <span className="feature-num">03</span>
                <div>
                  <strong>Intelligent Chapters & Search</strong>
                  <small>Search topics and jump to exact timestamps effortlessly.</small>
                </div>
              </div>
            </div>

            <div className="home-hint">💡 Open a YouTube video tab to begin learning.</div>
          </section>
        ) : (
          <>
            <section className="video-card">
              <div className="video-card-top">
                <span className="video-source-badge">YOUTUBE VIDEO</span>
                <div className="video-badges-row">
                  {hasFiniteDuration && (
                    <span className="duration-pill">
                      ⏱ {formatTimestamp(video.duration!)}
                    </span>
                  )}
                  {video.hasCaptions !== undefined && (
                    <span
                      className={`caption-pill ${
                        video.hasCaptions ? "has-caps" : "no-caps"
                      }`}
                    >
                      {video.hasCaptions ? "CC Ready" : "No CC"}
                    </span>
                  )}
                </div>
              </div>

              <h2>{video.title}</h2>
              <span className="video-id">ID: {video.id}</span>
            </section>

            {!transcript && (
              <div className="fetch-section">
                <button
                  className="primary-button full-width"
                  onClick={showTranscription}
                  disabled={loading}
                >
                  {loading ? (
                    <>
                      <div className="btn-spinner" />
                      <span>{aiLoading ? "Generating AI Script & Analysis..." : isSlowLoading ? "Still retrieving transcript..." : "Getting Transcript..."}</span>
                    </>
                  ) : (
                    <span>🚀 Show Video Transcript & Analysis</span>
                  )}
                </button>
              </div>
            )}

            {loading && !transcript && (
              <div className="info-box processing-box">
                <div className="spinner" />
                <div>
                  <strong>{aiLoading ? "AI is generating video script & analysis..." : isSlowLoading ? "Extracting full video audio..." : "Retrieving transcript..."}</strong>
                  <p>{aiLoading ? "Gemini is analyzing the video content and constructing timestamped dialogue, summary, and chapters." : "Please wait a moment while we process the video content."}</p>
                </div>
              </div>
            )}

            {error && !loading && (
              <div className="error-box">
                <div className="error-title">Transcription Notice:</div>
                <div className="error-message">{error}</div>
              </div>
            )}

            {transcript && (
              <section className="main-panel">
                <div className="tab-nav">
                  <button
                    className={`tab-btn ${activeTab === "transcript" ? "active" : ""}`}
                    onClick={() => setActiveTab("transcript")}
                  >
                    📝 Transcript ({transcript.segments.length})
                  </button>
                  <button
                    className={`tab-btn ${activeTab === "summary" ? "active" : ""}`}
                    onClick={() => setActiveTab("summary")}
                  >
                    ✨ AI Summary {aiLoading && <span className="tab-loading-dot" />}
                  </button>
                  <button
                    className={`tab-btn ${activeTab === "chapters" ? "active" : ""}`}
                    onClick={() => setActiveTab("chapters")}
                  >
                    📑 Chapters ({chapters.length})
                  </button>
                </div>

                <div className="action-toolbar">
                  {activeTab === "transcript" && (
                    <div className="button-group">
                      <button
                        className="action-btn primary-action"
                        onClick={copyTranscriptScript}
                        title="Copy transcript formatted as clean written script"
                      >
                        📋 Copy Script
                      </button>
                      <button
                        className="action-btn"
                        onClick={copyTranscriptWithTimestamps}
                        title="Copy transcript with timestamps"
                      >
                        ⏱️ With Timestamps
                      </button>
                      <button
                        className="action-btn"
                        onClick={downloadTranscriptTxt}
                        title="Download script as text file"
                      >
                        📄 .TXT
                      </button>
                      <button
                        className="action-btn"
                        onClick={downloadTranscriptSrt}
                        title="Download subtitles file"
                      >
                        💬 .SRT
                      </button>
                      <button
                        className="action-btn danger-action"
                        onClick={clearAll}
                        title="Reset transcript"
                      >
                        ✕ Clear
                      </button>
                    </div>
                  )}

                  {activeTab === "summary" && (
                    <div className="button-group">
                      <button
                        className="action-btn primary-action"
                        onClick={copySummaryText}
                        disabled={!summary || aiLoading}
                        title="Copy summary in Markdown format"
                      >
                        📋 Copy Summary
                      </button>
                      <button
                        className="action-btn"
                        onClick={downloadSummaryMd}
                        disabled={!summary || aiLoading}
                        title="Download summary as Markdown file"
                      >
                        📑 .MD
                      </button>
                      <button
                        className="action-btn"
                        onClick={retryAI}
                        disabled={aiLoading}
                        title="Regenerate AI analysis"
                      >
                        🔄 {aiLoading ? "Generating..." : "Regenerate"}
                      </button>
                      <button
                        className="action-btn danger-action"
                        onClick={clearAll}
                        title="Reset"
                      >
                        ✕ Clear
                      </button>
                    </div>
                  )}

                  {activeTab === "chapters" && (
                    <div className="button-group">
                      <button
                        className="action-btn primary-action"
                        onClick={copyChaptersYouTube}
                        disabled={chapters.length === 0 || aiLoading}
                        title="Copy YouTube description timestamps"
                      >
                        📋 Copy Timestamps
                      </button>
                      <button
                        className="action-btn"
                        onClick={copyChaptersDetailed}
                        disabled={chapters.length === 0 || aiLoading}
                        title="Copy chapters with summaries"
                      >
                        📄 Copy Details
                      </button>
                      <button
                        className="action-btn"
                        onClick={downloadChaptersTxt}
                        disabled={chapters.length === 0 || aiLoading}
                        title="Download chapters as text"
                      >
                        📑 .TXT
                      </button>
                      <button
                        className="action-btn"
                        onClick={retryAI}
                        disabled={aiLoading}
                        title="Regenerate chapters"
                      >
                        🔄 {aiLoading ? "Generating..." : "Regenerate"}
                      </button>
                      <button
                        className="action-btn danger-action"
                        onClick={clearAll}
                        title="Reset"
                      >
                        ✕ Clear
                      </button>
                    </div>
                  )}
                </div>

                {activeTab === "transcript" && (
                  <div className="tab-pane">
                    {transcript.source === "ai_generated" && (
                      <div className="ai-source-banner">
                        <span className="badge-ai-sparkle">✨</span>
                        <span>AI Reconstructed Script (Generated via Gemini)</span>
                      </div>
                    )}

                    <div className="search-bar">
                      <span className="search-icon">🔍</span>
                      <input
                        ref={searchInputRef}
                        type="text"
                        className="search-input"
                        placeholder="Search dialogue in transcript..."
                        value={searchQuery}
                        onChange={(e) => {
                          setSearchQuery(e.target.value);
                          setActiveMatchIdx(0);
                        }}
                      />
                      {searchQuery && (
                        <div className="search-controls">
                          <span className="match-counter">
                            {matchingIndices.length > 0
                              ? `${activeMatchIdx + 1}/${matchingIndices.length}`
                              : "0 matches"}
                          </span>
                          <button
                            className="search-nav-btn"
                            onClick={prevMatch}
                            disabled={matchingIndices.length === 0}
                            title="Previous match"
                          >
                            ▲
                          </button>
                          <button
                            className="search-nav-btn"
                            onClick={nextMatch}
                            disabled={matchingIndices.length === 0}
                            title="Next match"
                          >
                            ▼
                          </button>
                          <button
                            className="clear-search-btn"
                            onClick={() => {
                              setSearchQuery("");
                              setActiveMatchIdx(0);
                            }}
                            title="Clear search"
                          >
                            ✕
                          </button>
                        </div>
                      )}
                    </div>

                    <div className="transcript-list">
                      {transcript.segments.map((segment, index) => {
                        const isMatch =
                          Boolean(searchQuery.trim()) &&
                          matchingIndices.includes(index);
                        const isCurrentMatch =
                          isMatch &&
                          matchingIndices[activeMatchIdx] === index;

                        return (
                          <div
                            className={`segment-card ${isMatch ? "segment-matched" : ""} ${isCurrentMatch ? "segment-active-match" : ""}`}
                            id={`seg-${index}`}
                            key={`${segment.start}-${index}`}
                          >
                            <button
                              className="segment-time-pill"
                              onClick={() => seekTo(segment.start)}
                              title="Jump to video timestamp"
                            >
                              ▶ {formatTimestamp(segment.start)}
                            </button>
                            <p className="segment-text">
                              {renderHighlightedText(
                                segment.text,
                                isCurrentMatch,
                              )}
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {activeTab === "summary" && (
                  <div className="tab-pane summary-pane">
                    {aiLoading && (
                      <div className="ai-skeleton-container">
                        <div className="ai-loading-status">
                          <div className="ai-pulse-dot" />
                          <span>Generating comprehensive AI summary with Gemini...</span>
                        </div>
                        <div className="skeleton-card">
                          <div className="skeleton-line skeleton-title" />
                          <div className="skeleton-line" />
                          <div className="skeleton-line" />
                          <div className="skeleton-line skeleton-short" />
                        </div>
                        <div className="skeleton-card">
                          <div className="skeleton-line skeleton-title" />
                          <div className="skeleton-line" />
                          <div className="skeleton-line" />
                          <div className="skeleton-line skeleton-short" />
                        </div>
                      </div>
                    )}

                    {aiError && !aiLoading && (
                      <div className="ai-error-banner">
                        <div className="ai-error-header">
                          <span>⚠️ AI Generation Notice</span>
                        </div>
                        <p>{aiError}</p>
                        <button className="retry-btn" onClick={retryAI}>
                          🔄 Retry AI Generation
                        </button>
                      </div>
                    )}

                    {!aiLoading && !aiError && summary && (
                      <div className="summary-cards">
                        <div className="summary-card overview-card">
                          <div className="card-header">
                            <span className="card-icon">💡</span>
                            <h3>Overview</h3>
                          </div>
                          <p className="summary-body">{summary.overview}</p>
                        </div>

                        {summary.mainPoints?.length > 0 && (
                          <div className="summary-card">
                            <div className="card-header">
                              <span className="card-icon">🎯</span>
                              <h3>Key Insights & Main Points</h3>
                            </div>
                            <ul className="styled-list">
                              {summary.mainPoints.map((point, i) => (
                                <li key={i}>
                                  <span className="list-bullet">•</span>
                                  <span>{point}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {summary.importantExplanations?.length > 0 && (
                          <div className="summary-card">
                            <div className="card-header">
                              <span className="card-icon">🔍</span>
                              <h3>Important Explanations & Deep Dive</h3>
                            </div>
                            <ul className="styled-list">
                              {summary.importantExplanations.map((exp, i) => (
                                <li key={i}>
                                  <span className="list-bullet">›</span>
                                  <span>{exp}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {summary.keyConclusions?.length > 0 && (
                          <div className="summary-card conclusions-card">
                            <div className="card-header">
                              <span className="card-icon">🚀</span>
                              <h3>Key Conclusions & Takeaways</h3>
                            </div>
                            <ul className="styled-list">
                              {summary.keyConclusions.map((conc, i) => (
                                <li key={i}>
                                  <span className="list-bullet">✓</span>
                                  <span>{conc}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    )}

                    {!aiLoading && !aiError && !summary && (
                      <div className="empty-panel">
                        <span className="empty-icon">✨</span>
                        <h3>No summary generated yet</h3>
                        <p>Click the button below to generate AI summary.</p>
                        <button className="primary-button" onClick={retryAI}>
                          ⚡ Generate AI Summary
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {activeTab === "chapters" && (
                  <div className="tab-pane chapters-pane">
                    {aiLoading && (
                      <div className="ai-skeleton-container">
                        <div className="ai-loading-status">
                          <div className="ai-pulse-dot" />
                          <span>Generating AI chapter breakdown...</span>
                        </div>
                        <div className="skeleton-card">
                          <div className="skeleton-line skeleton-title" />
                          <div className="skeleton-line" />
                        </div>
                        <div className="skeleton-card">
                          <div className="skeleton-line skeleton-title" />
                          <div className="skeleton-line" />
                        </div>
                      </div>
                    )}

                    {aiError && !aiLoading && (
                      <div className="ai-error-banner">
                        <div className="ai-error-header">
                          <span>⚠️ AI Chapters Notice</span>
                        </div>
                        <p>{aiError}</p>
                        <button className="retry-btn" onClick={retryAI}>
                          🔄 Retry AI Chapters
                        </button>
                      </div>
                    )}

                    {!aiLoading && !aiError && chapters.length > 0 && (
                      <div className="chapters-timeline">
                        {chapters.map((chap) => (
                          <div key={chap.id} className="chapter-item">
                            <button
                              className="chapter-seek-pill"
                              onClick={() => seekTo(chap.startSeconds)}
                              title="Click to seek YouTube video"
                            >
                              ▶ {chap.timestamp}
                            </button>
                            <div className="chapter-body">
                              <input
                                type="text"
                                className="chapter-title-edit"
                                value={chap.title}
                                onChange={(e) =>
                                  updateChapterTitle(chap.id, e.target.value)
                                }
                                title="Click to edit chapter title"
                              />
                              {chap.summary && (
                                <p className="chapter-desc">{chap.summary}</p>
                              )}
                            </div>
                            <button
                              className="chapter-remove-btn"
                              onClick={() => deleteChapter(chap.id)}
                              title="Delete chapter"
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    {!aiLoading && !aiError && chapters.length === 0 && (
                      <div className="empty-panel">
                        <span className="empty-icon">📑</span>
                        <h3>No chapters generated yet</h3>
                        <p>Click below to generate intelligent chapters with timestamps.</p>
                        <button className="primary-button" onClick={retryAI}>
                          ⚡ Generate AI Chapters
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}

export default App;