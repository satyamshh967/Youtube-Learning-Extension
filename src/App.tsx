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
  generateVideoSummary,
  extractKeyMoments,
  extractHooks,
  generateSuggestedChapters,
  formatChaptersForExport,
  exportToSrt,
  type SummaryResult,
  type KeyMoment,
  type VideoHook,
  type Chapter,
} from "./utils/transcriptAnalysis";

interface ActiveContext {
  tabId: number | null;
  video: VideoInfo | null;
}

interface BackgroundResponse {
  success: boolean;
  context: ActiveContext;
}

type TabType = "transcript" | "summary" | "moments" | "hooks" | "chapters";

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
  const [isSlowLoading, setIsSlowLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedMessage, setCopiedMessage] = useState<string | null>(null);
  const [transcriptionState, setTranscriptionState] =
    useState<TranscriptionStatus>("idle");
  const [activeTab, setActiveTab] = useState<TabType>("transcript");

  // Search state
  const [searchQuery, setSearchQuery] = useState("");
  const [activeMatchIdx, setActiveMatchIdx] = useState(0);

  // Analysis state
  const [summary, setSummary] = useState<SummaryResult | null>(null);
  const [moments, setMoments] = useState<KeyMoment[]>([]);
  const [hooks, setHooks] = useState<VideoHook[]>([]);
  const [chapters, setChapters] = useState<Chapter[]>([]);

  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const showCopied = (msg = "Copied to clipboard") => {
    setCopiedMessage(msg);
    setTimeout(() => setCopiedMessage(null), 2000);
  };

  const populateAnalysis = useCallback((currTranscript: Transcript) => {
    setSummary(generateVideoSummary(currTranscript));
    setMoments(extractKeyMoments(currTranscript));
    setHooks(extractHooks(currTranscript));
    setChapters(generateSuggestedChapters(currTranscript));
  }, []);

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
        setMoments([]);
        setHooks([]);
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
        // Video changed: reset all previous video states immediately
        setError(null);
        setTranscript(null);
        setSummary(null);
        setMoments([]);
        setHooks([]);
        setChapters([]);
        setSearchQuery("");
        setActiveMatchIdx(0);
        setLoading(false);
        setTranscriptionState("idle");
        setActiveTab("transcript");
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
        throw new Error(
          response?.error ??
            "YouTube captions are unavailable for this video. A full fallback transcription source is not currently available.",
        );
      }
    } catch (err) {
      setLoading(false);
      setTranscriptionState("failed");
      setError(
        err instanceof Error
          ? err.message
          : "Could not retrieve transcript. Please verify the YouTube video is open.",
      );
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

  // Search matching indices
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

  // Export handlers
  const copyFullTranscript = () => {
    if (!transcript) return;
    const text = transcript.segments
      .map((s) => `${formatTimestampRange(s.start, s.end)} ${s.text}`)
      .join("\n");
    navigator.clipboard.writeText(text).then(() => {
      showCopied("Transcript copied");
    });
  };

  const copySelectedText = () => {
    const sel = window.getSelection()?.toString();
    if (sel && sel.trim()) {
      navigator.clipboard.writeText(sel).then(() => {
        showCopied("Selection copied");
      });
    } else {
      copyFullTranscript();
    }
  };

  const downloadTxt = () => {
    if (!transcript) return;
    const title = video?.title || "youtube-transcript";
    const text = [
      `Title: ${title}`,
      `Video ID: ${transcript.videoId}`,
      `Source: ${transcript.source || "youtube_captions"}`,
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

  const downloadSrt = () => {
    if (!transcript) return;
    const title = video?.title || "youtube-transcript";
    const srtContent = exportToSrt(transcript.segments);
    const blob = new Blob([srtContent], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.replace(/[^a-z0-9]/gi, "_").toLowerCase()}_subtitles.srt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copySummaryText = () => {
    if (!summary) return;
    const text = [
      `OVERVIEW:`,
      summary.overview,
      "",
      `MAIN POINTS:`,
      ...summary.mainPoints.map((p) => `• ${p}`),
      "",
      `IMPORTANT EXPLANATIONS:`,
      ...summary.importantExplanations.map((e) => `• ${e}`),
      "",
      `KEY CONCLUSIONS:`,
      ...summary.keyConclusions.map((c) => `• ${c}`),
    ].join("\n");

    navigator.clipboard.writeText(text).then(() => {
      showCopied("Summary copied");
    });
  };

  const copyChaptersText = () => {
    const text = formatChaptersForExport(chapters);
    navigator.clipboard.writeText(text).then(() => {
      showCopied("Chapters copied");
    });
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

        // Prevent stale responses for a different video
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

        setError(
          message.error ??
            "YouTube captions are unavailable for this video. A full fallback transcription source is not currently available.",
        );
        setLoading(false);
        setTranscriptionState("failed");
        return;
      }
    };

    chrome.runtime.onMessage.addListener(listener);

    return () => {
      chrome.runtime.onMessage.removeListener(listener);
    };
  }, [applyContext, loadActiveContext, populateAnalysis, video]);

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

  // Highlight matching text in transcript
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
    <div className="app">
      <header className="header">
        <div>
          <div className="eyebrow">LEARNING COMPANION</div>
          <h1>YouTube Companion</h1>
        </div>
        <div className="header-right">
          {copiedMessage && <span className="copied-pill">✓ {copiedMessage}</span>}
          <span
            className={`status-dot ${
              loading
                ? "status-dot-processing"
                : transcriptionState === "completed"
                  ? "status-dot-completed"
                  : ""
            }`}
            title={`Status: ${transcriptionState}`}
          />
        </div>
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
              Open any YouTube video to instantly retrieve complete transcripts,
              search through dialogue, generate summaries, and study key moments.
            </p>

            <div className="feature-list">
              <div className="feature">
                <span>01</span>
                <div>
                  <strong>Instant Complete Transcripts</strong>
                  <small>
                    Retrieves full video transcript even when paused.
                  </small>
                </div>
              </div>
              <div className="feature">
                <span>02</span>
                <div>
                  <strong>Clickable Timestamps & Search</strong>
                  <small>
                    Highlight keywords and jump anywhere in the video.
                  </small>
                </div>
              </div>
              <div className="feature">
                <span>03</span>
                <div>
                  <strong>Structured Summaries & Chapters</strong>
                  <small>
                    Study notes, key moments, and chapter exports.
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
                {video.hasCaptions !== undefined && (
                  <span
                    className={`caption-pill ${
                      video.hasCaptions ? "has-caps" : "no-caps"
                    }`}
                  >
                    {video.hasCaptions ? "CC Available" : "No CC Detected"}
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
                    <button
                      className="primary-button"
                      onClick={showTranscription}
                      disabled={loading}
                      title="Show complete transcript for this video"
                    >
                      {loading ? "Getting transcript..." : "Show Transcription"}
                    </button>
                  </div>
                )}

                {transcript && (
                  <div className="button-group">
                    <button
                      className="secondary-button"
                      onClick={copyFullTranscript}
                      title="Copy full transcript to clipboard"
                    >
                      Copy All
                    </button>
                    <button
                      className="secondary-button"
                      onClick={copySelectedText}
                      title="Copy selected text or full transcript"
                    >
                      Copy Text
                    </button>
                    <button
                      className="secondary-button"
                      onClick={downloadTxt}
                      title="Download transcript as text (.txt)"
                    >
                      .TXT
                    </button>
                    <button
                      className="secondary-button"
                      onClick={downloadSrt}
                      title="Download subtitles with timestamps (.srt)"
                    >
                      .SRT
                    </button>
                    <button
                      className="secondary-button"
                      onClick={() => {
                        setTranscript(null);
                        setSummary(null);
                        setMoments([]);
                        setHooks([]);
                        setChapters([]);
                        setTranscriptionState("idle");
                      }}
                      title="Clear transcript view"
                    >
                      Clear
                    </button>
                  </div>
                )}
              </div>

              {/* Loading State: Honest, immediate, no fake progress */}
              {loading && (
                <div className="info-box processing-box">
                  <div className="spinner" />
                  <div>
                    <strong>
                      {isSlowLoading
                        ? "Still retrieving the transcript..."
                        : "Getting transcript..."}
                    </strong>
                    <p>Please wait.</p>
                  </div>
                </div>
              )}

              {/* Persistent readable error */}
              {error && !loading && (
                <div className="error">
                  <div className="error-title">Transcription Notice:</div>
                  <div className="error-message">{error}</div>
                </div>
              )}

              {/* Feature Tabs once transcript is available */}
              {transcript && (
                <>
                  <div className="tab-nav">
                    <button
                      className={`tab-btn ${activeTab === "transcript" ? "active" : ""}`}
                      onClick={() => setActiveTab("transcript")}
                    >
                      Transcript
                    </button>
                    <button
                      className={`tab-btn ${activeTab === "summary" ? "active" : ""}`}
                      onClick={() => setActiveTab("summary")}
                    >
                      Summary
                    </button>
                    <button
                      className={`tab-btn ${activeTab === "moments" ? "active" : ""}`}
                      onClick={() => setActiveTab("moments")}
                    >
                      Key Moments ({moments.length})
                    </button>
                    <button
                      className={`tab-btn ${activeTab === "hooks" ? "active" : ""}`}
                      onClick={() => setActiveTab("hooks")}
                    >
                      Hooks ({hooks.length})
                    </button>
                    <button
                      className={`tab-btn ${activeTab === "chapters" ? "active" : ""}`}
                      onClick={() => setActiveTab("chapters")}
                    >
                      Chapters ({chapters.length})
                    </button>
                  </div>

                  {/* TAB 1: TRANSCRIPT (With Search) */}
                  {activeTab === "transcript" && (
                    <div className="tab-pane">
                      {/* Search Bar */}
                      <div className="search-bar">
                        <span className="search-icon">🔍</span>
                        <input
                          ref={searchInputRef}
                          type="text"
                          className="search-input"
                          placeholder="Search transcript..."
                          value={searchQuery}
                          onChange={(e) => {
                            setSearchQuery(e.target.value);
                            setActiveMatchIdx(0);
                          }}
                        />
                        {searchQuery && (
                          <>
                            <span className="match-counter">
                              {matchingIndices.length > 0
                                ? `${activeMatchIdx + 1} of ${matchingIndices.length}`
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
                          </>
                        )}
                      </div>

                      {/* Transcript Segments */}
                      <div className="transcript">
                        {transcript.segments.map((segment, index) => {
                          const isMatch =
                            Boolean(searchQuery.trim()) &&
                            matchingIndices.includes(index);
                          const isCurrentMatch =
                            isMatch &&
                            matchingIndices[activeMatchIdx] === index;

                          return (
                            <button
                              className={`segment ${isMatch ? "segment-matched" : ""} ${isCurrentMatch ? "segment-active-match" : ""}`}
                              id={`seg-${index}`}
                              key={`${segment.start}-${index}`}
                              onClick={() => seekTo(segment.start)}
                              title="Click to seek video to this timestamp"
                            >
                              <span className="timestamp">
                                {formatTimestampRange(segment.start, segment.end)}
                              </span>
                              <span className="segment-text">
                                {renderHighlightedText(
                                  segment.text,
                                  isCurrentMatch,
                                )}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* TAB 2: VIDEO SUMMARY */}
                  {activeTab === "summary" && summary && (
                    <div className="tab-pane summary-pane">
                      <div className="pane-header">
                        <div>
                          <h3>Video Summary</h3>
                          <p>Synthesized directly from retrieved transcript text.</p>
                        </div>
                        <button
                          className="secondary-button"
                          onClick={copySummaryText}
                        >
                          Copy Summary
                        </button>
                      </div>

                      <div className="summary-section">
                        <h4>Overview</h4>
                        <p className="summary-text">{summary.overview}</p>
                      </div>

                      <div className="summary-section">
                        <h4>Main Points</h4>
                        <ul className="summary-list">
                          {summary.mainPoints.map((point, i) => (
                            <li key={i}>{point}</li>
                          ))}
                        </ul>
                      </div>

                      <div className="summary-section">
                        <h4>Important Explanations</h4>
                        <ul className="summary-list">
                          {summary.importantExplanations.map((exp, i) => (
                            <li key={i}>{exp}</li>
                          ))}
                        </ul>
                      </div>

                      <div className="summary-section">
                        <h4>Key Conclusions & Takeaways</h4>
                        <ul className="summary-list">
                          {summary.keyConclusions.map((conc, i) => (
                            <li key={i}>{conc}</li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  )}

                  {/* TAB 3: KEY MOMENTS */}
                  {activeTab === "moments" && (
                    <div className="tab-pane moments-pane">
                      <div className="pane-header">
                        <div>
                          <h3>Key Moments</h3>
                          <p>Important definitions, examples, tips, and concepts.</p>
                        </div>
                      </div>

                      <div className="cards-grid">
                        {moments.map((moment) => (
                          <div
                            key={moment.id}
                            className="moment-card"
                            onClick={() => seekTo(moment.seconds)}
                            title="Click to seek video"
                          >
                            <div className="card-top">
                              <span
                                className={`badge badge-${moment.category.toLowerCase().replace(/\s+/g, "-")}`}
                              >
                                {moment.category}
                              </span>
                              <span className="timestamp-badge">
                                ▶ {moment.timestamp}
                              </span>
                            </div>
                            <h4>{moment.title}</h4>
                            <p className="card-explanation">
                              {moment.explanation}
                            </p>
                            <blockquote className="card-quote">
                              {moment.quote}
                            </blockquote>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* TAB 4: FIND HOOKS */}
                  {activeTab === "hooks" && (
                    <div className="tab-pane hooks-pane">
                      <div className="pane-header">
                        <div>
                          <h3>Find Hooks & Study Notes</h3>
                          <p>
                            Memorable insights and guiding questions from the
                            transcript.
                          </p>
                        </div>
                      </div>

                      <div className="cards-grid">
                        {hooks.map((hook) => (
                          <div
                            key={hook.id}
                            className="hook-card"
                            onClick={() => seekTo(hook.seconds)}
                            title="Click to seek video"
                          >
                            <div className="card-top">
                              <span className="badge badge-quote">
                                {hook.type}
                              </span>
                              <span className="timestamp-badge">
                                ▶ {hook.timestamp}
                              </span>
                            </div>
                            <p className="hook-quote">{hook.text}</p>
                            <p className="hook-explanation">
                              {hook.explanation}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* TAB 5: SUGGESTED CHAPTERS */}
                  {activeTab === "chapters" && (
                    <div className="tab-pane chapters-pane">
                      <div className="pane-header">
                        <div>
                          <h3>Suggested Chapters</h3>
                          <p>
                            Generated timeline chapters. Click timestamp to seek,
                            edit title, or copy for YouTube.
                          </p>
                        </div>
                        <button
                          className="secondary-button"
                          onClick={copyChaptersText}
                        >
                          Copy Chapters
                        </button>
                      </div>

                      <div className="chapters-list">
                        {chapters.map((chap) => (
                          <div key={chap.id} className="chapter-row">
                            <button
                              className="chapter-time-btn"
                              onClick={() => seekTo(chap.startSeconds)}
                              title="Click to seek video"
                            >
                              ▶ {chap.timestamp}
                            </button>
                            <input
                              type="text"
                              className="chapter-title-input"
                              value={chap.title}
                              onChange={(e) =>
                                updateChapterTitle(chap.id, e.target.value)
                              }
                            />
                            <button
                              className="chapter-delete-btn"
                              onClick={() => deleteChapter(chap.id)}
                              title="Delete chapter"
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}

export default App;