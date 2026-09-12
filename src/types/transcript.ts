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
  source?: "youtube_captions" | "whisper_audio";
  duration?: number | null;
  segments: TranscriptSegment[];
}

export type TranscriptionStatus =
  | "idle"
  | "detecting_video"
  | "preparing"
  | "capturing"
  | "transcribing"
  | "finalizing"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

// ---------------------------------------------------------------------------
// Typed events for the transcription hook system
// ---------------------------------------------------------------------------

interface EventBase {
  videoId?: string;
  timestamp: number;
}

export interface TranscriptionStartedEvent extends EventBase {
  type: "TRANSCRIPTION_STARTED";
}

export interface AudioCaptureStartedEvent extends EventBase {
  type: "AUDIO_CAPTURE_STARTED";
}

export interface AudioCaptureProgressEvent extends EventBase {
  type: "AUDIO_CAPTURE_PROGRESS";
  chunks: number;
  bytes: number;
  durationMs: number;
}

export interface TranscriptionProgressEvent extends EventBase {
  type: "TRANSCRIPTION_PROGRESS";
  stage: "recording" | "sending" | "parsing";
}

export interface TranscriptSegmentReceivedEvent extends EventBase {
  type: "TRANSCRIPT_SEGMENT_RECEIVED";
  segment: TranscriptSegment;
  index: number;
  total: number;
}

export interface TranscriptionPausedEvent extends EventBase {
  type: "TRANSCRIPTION_PAUSED";
}

export interface TranscriptionResumedEvent extends EventBase {
  type: "TRANSCRIPTION_RESUMED";
}

export interface TranscriptionCompletedEvent extends EventBase {
  type: "TRANSCRIPTION_COMPLETED";
  transcript: Transcript;
}

export interface TranscriptionFailedEvent extends EventBase {
  type: "TRANSCRIPTION_FAILED";
  error: string;
}

export interface TranscriptionCancelledEvent extends EventBase {
  type: "TRANSCRIPTION_CANCELLED";
}

export type TranscriptionEvent =
  | TranscriptionStartedEvent
  | AudioCaptureStartedEvent
  | AudioCaptureProgressEvent
  | TranscriptionProgressEvent
  | TranscriptSegmentReceivedEvent
  | TranscriptionPausedEvent
  | TranscriptionResumedEvent
  | TranscriptionCompletedEvent
  | TranscriptionFailedEvent
  | TranscriptionCancelledEvent;