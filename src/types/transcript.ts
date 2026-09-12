export interface TranscriptSegment {
  start: number;
  timestamp: string;
  text: string;
}

export interface Transcript {
  videoId: string;
  languageCode?: string;
  languageName?: string;
  segments: TranscriptSegment[];
}