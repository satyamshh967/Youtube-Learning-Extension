export interface VideoInfo {
  id: string | null;
  title: string;
  url: string;
  duration?: number | null;
  currentTime?: number;
  isPaused?: boolean;
  hasCaptions?: boolean;
}

export interface TranscriptSegment {
  start: number;
  end?: number;
  timestamp: string;
  endTimestamp?: string;
  text: string;
}

export interface Transcript {
  videoId: string;
  title?: string;
  language?: string;
  languageProbability?: number;
  source?: "youtube_captions" | "fallback";
  duration?: number | null;
  segments: TranscriptSegment[];
}

export type TranscriptionStatus =
  | "idle"
  | "loading"
  | "completed"
  | "failed";

// ---------------------------------------------------------------------------
// Typed events for extension message passing
// ---------------------------------------------------------------------------

interface EventBase {
  videoId?: string;
  timestamp: number;
}

export interface TranscriptionStartedEvent extends EventBase {
  type: "TRANSCRIPTION_STARTED";
}

export interface TranscriptionCompletedEvent extends EventBase {
  type: "TRANSCRIPTION_COMPLETED";
  transcript: Transcript;
}

export interface TranscriptionFailedEvent extends EventBase {
  type: "TRANSCRIPTION_FAILED";
  error: string;
}

export type TranscriptionEvent =
  | TranscriptionStartedEvent
  | TranscriptionCompletedEvent
  | TranscriptionFailedEvent;