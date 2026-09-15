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
    return (localStorage.getItem("yt_companion_theme") as "dark" | "light") || "light";
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
      <main className="content">
        <section className="hero-banner-card">
          <div className="hero-top-nav">
            <div className="hero-brand-pill">
              <div className="hero-brand-icon">⚡</div>
              <span className="hero-brand-title">YouTube Companion</span>
            </div>

            <div className="hero-nav-actions">
              {copiedMessage && <span className="hero-copied-toast">✓ {copiedMessage}</span>}
              <button
                className="hero-theme-toggle"
                onClick={toggleTheme}
                title={`Switch to ${theme === "dark" ? "Light" : "Dark"} Mode`}
              >
                {theme === "dark" ? "☀️" : "🌙"}
              </button>
              <span
                className={`hero-status-beacon ${
                  loading || aiLoading
                    ? "beacon-processing"
                    : transcriptionState === "completed"
                      ? "beacon-active"
                      : ""
                }`}
                title={`Status: ${loading ? "Retrieving transcript..." : aiLoading ? "Generating AI analysis..." : transcriptionState}`}
              />
            </div>
          </div>

          <div className="hero-center-aura">
            <div className="aura-ring aura-outer" />
            <div className="aura-ring aura-inner" />
            <div className="aura-core-badge">
              {loading || aiLoading ? (
                <div className="aura-spinner" />
              ) : transcript ? (
                <span className="aura-emoji">🚀</span>
              ) : video ? (
                <span className="aura-emoji">🎬</span>
              ) : (
                <span className="aura-emoji">✨</span>
              )}
            </div>
          </div>

          <div className="hero-text-block">
            <h2>
              {transcript
                ? "Woohoo! Video Insights Ready!"
                : loading || aiLoading
                  ? "Analyzing Video with AI..."
                  : video
                    ? "Video Ready to Analyze!"
                    : "Supercharge Your Learning!"}
            </h2>
            <p>
              {transcript
                ? "Dialogue extracted, AI summary created, and smart chapters organized."
                : loading || aiLoading
                  ? "Extracting speech dialogue and structuring educational takeaways..."
                  : video
                    ? "Click below to retrieve transcripts, generate AI summaries, and chapters."
                    : "Open any YouTube video to automatically extract transcripts and AI summaries."}
            </p>
          </div>

          <div className="hero-inset-card">
            {video ? (
              <>
                <div className="hero-video-pill">
                  <span className="video-status-check">🟢</span>
                  <span className="hero-video-title" title={video.title}>
                    {video.title}
                  </span>
                  {!transcript && (
                    <button
                      className="hero-pill-btn"
                      onClick={showTranscription}
                      disabled={loading}
                    >
                      {loading ? "Analyzing..." : "Analyze ⚡"}
                    </button>
                  )}
                </div>
                <div className="hero-meta-row">
                  {hasFiniteDuration && (
                    <span className="meta-tag">
                      ⏱ {formatTimestamp(video.duration!)}
                    </span>
                  )}
                  {video.channelName && (
                    <span className="meta-tag">
                      📺 {video.channelName}
                    </span>
                  )}
                  {video.hasCaptions !== undefined && (
                    <span className={`meta-tag ${video.hasCaptions ? "meta-caps-yes" : "meta-caps-no"}`}>
                      {video.hasCaptions ? "CC Ready" : "No CC (AI)"}
                    </span>
                  )}
                  {video.id && (
                    <span className="meta-tag meta-id">
                      ID: {video.id}
                    </span>
                  )}
                </div>
              </>
            ) : (
              <div className="hero-video-pill">
                <span className="video-status-check">💡</span>
                <span className="hero-video-title">
                  No active YouTube video detected
                </span>
                <span className="hero-pill-tag">Open Video</span>
              </div>
            )}
          </div>
        </section>

        {!video && (
          <section className="results-container">
            <div className="section-label-row">
              <span className="section-label">Smart Learning Features</span>
              <span className="section-count-badge">5 Modules</span>
            </div>

            <div className="features-chip-grid">
              <div className="feature-chip">
                <span className="chip-icon">✨</span>
                <div className="chip-info">
                  <strong>Full Instant Transcripts</strong>
                  <small>Read complete spoken dialogue cleanly</small>
                </div>
              </div>
              <div className="feature-chip">
                <span className="chip-icon">🧠</span>
                <div className="chip-info">
                  <strong>Deep AI Summaries</strong>
                  <small>Overviews, key insights & takeaways</small>
                </div>
              </div>
              <div className="feature-chip">
                <span className="chip-icon">📑</span>
                <div className="chip-info">
                  <strong>Smart Topic Chapters</strong>
                  <small>Organized timeline with descriptions</small>
                </div>
              </div>
              <div className="feature-chip">
                <span className="chip-icon">🔍</span>
                <div className="chip-info">
                  <strong>Dialogue Search & Jump</strong>
                  <small>Find phrases and seek player instantly</small>
                </div>
              </div>
              <div className="feature-chip">
                <span className="chip-icon">📥</span>
                <div className="chip-info">
                  <strong>One-Click Exports</strong>
                  <small>Download clean TXT, Markdown, SRT</small>
                </div>
              </div>
            </div>

            <div className="empty-hint-card">
              <span>💡 Open any YouTube video tab to start learning immediately.</span>
            </div>
          </section>
        )}

        {video && !transcript && (
          <section className="results-container">
            {!loading && !error && (
              <div className="start-action-card">
                <button
                  className="hero-action-button"
                  onClick={showTranscription}
                  disabled={loading}
                >
                  <span>🚀 Show Video Transcript & Analysis</span>
                </button>
                <p className="start-subtext">
                  Instant transcript scraping, AI summary generation, and smart chapter timestamps.
                </p>
              </div>
            )}

            {loading && (
              <div className="status-banner processing-banner">
                <div className="banner-spinner" />
                <div>
                  <strong>{aiLoading ? "AI is generating video script & analysis..." : isSlowLoading ? "Extracting full video audio..." : "Retrieving transcript..."}</strong>
                  <p>{aiLoading ? "Gemini is analyzing video metadata and constructing timestamped dialogue, summary, and chapters." : "Please wait a moment while we process the video content."}</p>
                </div>
              </div>
            )}

            {error && !loading && (
              <div className="status-banner error-banner">
                <div className="banner-error-header">
                  <span>⚠️ Notice</span>
                </div>
                <p>{error}</p>
                <button className="banner-retry-btn" onClick={showTranscription}>
                  🔄 Try Again
                </button>
              </div>
            )}
          </section>
        )}

        {video && transcript && (
          <section className="results-container">
            <div className="section-label-row">
              <span className="section-label">Exploration & Insights</span>
              {transcript.source === "ai_generated" && (
                <span className="ai-reconstructed-pill">✨ AI Script</span>
              )}
            </div>

            <div className="nav-tabs-pill-row">
              <button
                className={`nav-tab-pill ${activeTab === "transcript" ? "active" : ""}`}
                onClick={() => setActiveTab("transcript")}
              >
                <span>📝 Transcript</span>
                <span className="tab-pill-count">{transcript.segments.length}</span>
              </button>
              <button
                className={`nav-tab-pill ${activeTab === "summary" ? "active" : ""}`}
                onClick={() => setActiveTab("summary")}
              >
                <span>✨ AI Summary</span>
                {aiLoading && <span className="tab-pill-spinner" />}
              </button>
              <button
                className={`nav-tab-pill ${activeTab === "chapters" ? "active" : ""}`}
                onClick={() => setActiveTab("chapters")}
              >
                <span>📑 Chapters</span>
                <span className="tab-pill-count">{chapters.length}</span>
              </button>
            </div>

            <div className="chips-action-row">
              {activeTab === "transcript" && (
                <>
                  <button
                    className="action-chip primary-chip"
                    onClick={copyTranscriptScript}
                    title="Copy clean script without timestamps"
                  >
                    <span>📋 Copy Script</span>
                  </button>
                  <button
                    className="action-chip"
                    onClick={copyTranscriptWithTimestamps}
                    title="Copy with timestamps"
                  >
                    <span>⏱ Timestamps</span>
                  </button>
                  <button
                    className="action-chip"
                    onClick={downloadTranscriptTxt}
                    title="Download script as .TXT"
                  >
                    <span>📄 .TXT</span>
                  </button>
                  <button
                    className="action-chip"
                    onClick={downloadTranscriptSrt}
                    title="Download subtitles as .SRT"
                  >
                    <span>💬 .SRT</span>
                  </button>
                  <button
                    className="action-chip danger-chip"
                    onClick={clearAll}
                    title="Clear transcript"
                  >
                    <span>✕ Clear</span>
                  </button>
                </>
              )}

              {activeTab === "summary" && (
                <>
                  <button
                    className="action-chip primary-chip"
                    onClick={copySummaryText}
                    disabled={!summary || aiLoading}
                    title="Copy Markdown summary"
                  >
                    <span>📋 Copy Summary</span>
                  </button>
                  <button
                    className="action-chip"
                    onClick={downloadSummaryMd}
                    disabled={!summary || aiLoading}
                    title="Download summary as .MD"
                  >
                    <span>📑 .MD</span>
                  </button>
                  <button
                    className="action-chip"
                    onClick={retryAI}
                    disabled={aiLoading}
                    title="Regenerate summary with AI"
                  >
                    <span>🔄 {aiLoading ? "Generating..." : "Regenerate"}</span>
                  </button>
                  <button
                    className="action-chip danger-chip"
                    onClick={clearAll}
                    title="Clear summary"
                  >
                    <span>✕ Clear</span>
                  </button>
                </>
              )}

              {activeTab === "chapters" && (
                <>
                  <button
                    className="action-chip primary-chip"
                    onClick={copyChaptersYouTube}
                    disabled={chapters.length === 0 || aiLoading}
                    title="Copy timestamps for YouTube descriptions"
                  >
                    <span>📋 Timestamps</span>
                  </button>
                  <button
                    className="action-chip"
                    onClick={copyChaptersDetailed}
                    disabled={chapters.length === 0 || aiLoading}
                    title="Copy chapters with summaries"
                  >
                    <span>📄 Details</span>
                  </button>
                  <button
                    className="action-chip"
                    onClick={downloadChaptersTxt}
                    disabled={chapters.length === 0 || aiLoading}
                    title="Download chapters as .TXT"
                  >
                    <span>📑 .TXT</span>
                  </button>
                  <button
                    className="action-chip"
                    onClick={retryAI}
                    disabled={aiLoading}
                    title="Regenerate chapters with AI"
                  >
                    <span>🔄 {aiLoading ? "Generating..." : "Regenerate"}</span>
                  </button>
                  <button
                    className="action-chip danger-chip"
                    onClick={clearAll}
                    title="Clear chapters"
                  >
                    <span>✕ Clear</span>
                  </button>
                </>
              )}
            </div>

            {activeTab === "transcript" && (
              <div className="tab-content-pane">
                <div className="search-pill-box">
                  <span className="search-pill-icon">🔍</span>
                  <input
                    ref={searchInputRef}
                    type="text"
                    className="search-pill-input"
                    placeholder="Search dialogue in transcript..."
                    value={searchQuery}
                    onChange={(e) => {
                      setSearchQuery(e.target.value);
                      setActiveMatchIdx(0);
                    }}
                  />
                  {searchQuery && (
                    <div className="search-pill-controls">
                      <span className="search-match-count">
                        {matchingIndices.length > 0
                          ? `${activeMatchIdx + 1}/${matchingIndices.length}`
                          : "0 matches"}
                      </span>
                      <button
                        className="search-arrow-btn"
                        onClick={prevMatch}
                        disabled={matchingIndices.length === 0}
                        title="Previous match"
                      >
                        ▲
                      </button>
                      <button
                        className="search-arrow-btn"
                        onClick={nextMatch}
                        disabled={matchingIndices.length === 0}
                        title="Next match"
                      >
                        ▼
                      </button>
                      <button
                        className="search-clear-btn"
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

                <div className="transcript-scroll-list">
                  {transcript.segments.map((segment, index) => {
                    const isMatch =
                      Boolean(searchQuery.trim()) &&
                      matchingIndices.includes(index);
                    const isCurrentMatch =
                      isMatch &&
                      matchingIndices[activeMatchIdx] === index;

                    return (
                      <div
                        className={`dialogue-card ${isMatch ? "dialogue-matched" : ""} ${isCurrentMatch ? "dialogue-active-match" : ""}`}
                        id={`seg-${index}`}
                        key={`${segment.start}-${index}`}
                      >
                        <button
                          className="dialogue-time-badge"
                          onClick={() => seekTo(segment.start)}
                          title="Jump to video timestamp"
                        >
                          ▶ {formatTimestamp(segment.start)}
                        </button>
                        <p className="dialogue-body-text">
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
              <div className="tab-content-pane">
                {aiLoading && (
                  <div className="skeleton-flow">
                    <div className="skeleton-banner">
                      <div className="banner-spinner" />
                      <span>Gemini is generating in-depth structured summary...</span>
                    </div>
                    <div className="modern-glass-card">
                      <div className="skeleton-bar title-bar" />
                      <div className="skeleton-bar" />
                      <div className="skeleton-bar" />
                      <div className="skeleton-bar short-bar" />
                    </div>
                    <div className="modern-glass-card">
                      <div className="skeleton-bar title-bar" />
                      <div className="skeleton-bar" />
                      <div className="skeleton-bar short-bar" />
                    </div>
                  </div>
                )}

                {aiError && !aiLoading && (
                  <div className="status-banner error-banner">
                    <div className="banner-error-header">
                      <span>⚠️ AI Generation Notice</span>
                    </div>
                    <p>{aiError}</p>
                    <button className="banner-retry-btn" onClick={retryAI}>
                      🔄 Retry AI Analysis
                    </button>
                  </div>
                )}

                {!aiLoading && !aiError && summary && (
                  <div className="summary-cards-stack">
                    <div className="modern-glass-card overview-accent">
                      <div className="glass-card-header">
                        <span className="glass-card-icon">💡</span>
                        <h3>Overview</h3>
                      </div>
                      <p className="glass-card-body">{summary.overview}</p>
                    </div>

                    {summary.mainPoints?.length > 0 && (
                      <div className="modern-glass-card">
                        <div className="glass-card-header">
                          <span className="glass-card-icon">🎯</span>
                          <h3>Key Insights & Main Points</h3>
                        </div>
                        <ul className="modern-styled-list">
                          {summary.mainPoints.map((point, i) => (
                            <li key={i}>
                              <span className="list-dot-bullet">•</span>
                              <span>{point}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {summary.importantExplanations?.length > 0 && (
                      <div className="modern-glass-card">
                        <div className="glass-card-header">
                          <span className="glass-card-icon">🔍</span>
                          <h3>Important Explanations & Deep Dive</h3>
                        </div>
                        <ul className="modern-styled-list">
                          {summary.importantExplanations.map((exp, i) => (
                            <li key={i}>
                              <span className="list-dot-bullet">›</span>
                              <span>{exp}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {summary.keyConclusions?.length > 0 && (
                      <div className="modern-glass-card takeaways-accent">
                        <div className="glass-card-header">
                          <span className="glass-card-icon">🚀</span>
                          <h3>Key Conclusions & Takeaways</h3>
                        </div>
                        <ul className="modern-styled-list">
                          {summary.keyConclusions.map((conc, i) => (
                            <li key={i}>
                              <span className="list-dot-bullet">✓</span>
                              <span>{conc}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}

                {!aiLoading && !aiError && !summary && (
                  <div className="empty-content-card">
                    <span className="empty-content-icon">✨</span>
                    <h3>No summary generated yet</h3>
                    <p>Click below to generate intelligent summary with Gemini.</p>
                    <button className="hero-pill-btn" onClick={retryAI}>
                      ⚡ Generate AI Summary
                    </button>
                  </div>
                )}
              </div>
            )}

            {activeTab === "chapters" && (
              <div className="tab-content-pane">
                {aiLoading && (
                  <div className="skeleton-flow">
                    <div className="skeleton-banner">
                      <div className="banner-spinner" />
                      <span>Gemini is breaking down topic chapters...</span>
                    </div>
                    <div className="modern-glass-card">
                      <div className="skeleton-bar title-bar" />
                      <div className="skeleton-bar" />
                    </div>
                    <div className="modern-glass-card">
                      <div className="skeleton-bar title-bar" />
                      <div className="skeleton-bar" />
                    </div>
                  </div>
                )}

                {aiError && !aiLoading && (
                  <div className="status-banner error-banner">
                    <div className="banner-error-header">
                      <span>⚠️ Chapters Notice</span>
                    </div>
                    <p>{aiError}</p>
                    <button className="banner-retry-btn" onClick={retryAI}>
                      🔄 Retry AI Chapters
                    </button>
                  </div>
                )}

                {!aiLoading && !aiError && chapters.length > 0 && (
                  <div className="chapters-scroll-stack">
                    {chapters.map((chap) => (
                      <div key={chap.id} className="chapter-timeline-card">
                        <button
                          className="chapter-jump-pill"
                          onClick={() => seekTo(chap.startSeconds)}
                          title="Click to jump video to this timestamp"
                        >
                          ▶ {chap.timestamp}
                        </button>
                        <div className="chapter-content-box">
                          <input
                            type="text"
                            className="chapter-inline-input"
                            value={chap.title}
                            onChange={(e) =>
                              updateChapterTitle(chap.id, e.target.value)
                            }
                            title="Click to edit chapter title"
                          />
                          {chap.summary && (
                            <p className="chapter-snippet-text">{chap.summary}</p>
                          )}
                        </div>
                        <button
                          className="chapter-trash-btn"
                          onClick={() => deleteChapter(chap.id)}
                          title="Delete this chapter"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {!aiLoading && !aiError && chapters.length === 0 && (
                  <div className="empty-content-card">
                    <span className="empty-content-icon">📑</span>
                    <h3>No chapters generated yet</h3>
                    <p>Click below to generate intelligent chapters with timestamps.</p>
                    <button className="hero-pill-btn" onClick={retryAI}>
                      ⚡ Generate AI Chapters
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}

export default App;