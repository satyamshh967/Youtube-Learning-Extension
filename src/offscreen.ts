let mediaRecorder: MediaRecorder | null = null;
let stream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let chunks: Blob[] = [];

function sendMessage(
  message: Record<string, unknown>,
): void {
  chrome.runtime
    .sendMessage({
      target: "background",
      ...message,
    })
    .catch(() => {});
}

async function startRecording(
  streamId: string,
): Promise<void> {
  if (!streamId) {
    throw new Error(
      "No tab capture stream was provided.",
    );
  }

  if (
    mediaRecorder &&
    mediaRecorder.state !== "inactive"
  ) {
    throw new Error(
      "Audio capture is already running.",
    );
  }

  try {
    stream =
      await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: "tab",
            chromeMediaSourceId: streamId,
          },
        },
        video: false,
      } as MediaStreamConstraints);

    audioContext = new AudioContext();

    const source =
      audioContext.createMediaStreamSource(
        stream,
      );

    source.connect(
      audioContext.destination,
    );

    if (
      !MediaRecorder.isTypeSupported(
        "audio/webm;codecs=opus",
      )
    ) {
      throw new Error(
        "This browser does not support WebM/Opus audio recording.",
      );
    }

    mediaRecorder =
      new MediaRecorder(stream, {
        mimeType:
          "audio/webm;codecs=opus",
      });

    chunks = [];

    mediaRecorder.ondataavailable = (
      event,
    ) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };

    mediaRecorder.onerror = () => {
      sendMessage({
        type: "TRANSCRIPTION_ERROR",
        error: "Audio recording failed.",
      });
    };

    mediaRecorder.onstop = async () => {
      try {
        const blob = new Blob(chunks, {
          type: "audio/webm",
        });

        if (blob.size === 0) {
          throw new Error(
            "No audio was captured from the YouTube tab.",
          );
        }

        const formData = new FormData();

        formData.append(
          "file",
          blob,
          "youtube-audio.webm",
        );

        sendMessage({
          type: "TRANSCRIPTION_STARTED",
        });

        const response = await fetch(
          "http://127.0.0.1:8000/transcribe",
          {
            method: "POST",
            body: formData,
          },
        );

        if (!response.ok) {
          throw new Error(
            `Transcription server returned HTTP ${response.status}.`,
          );
        }

        const result = await response.json();

        sendMessage({
          type: "TRANSCRIPTION_COMPLETE",
          transcript: result,
        });
      } catch (error) {
        sendMessage({
          type: "TRANSCRIPTION_ERROR",
          error:
            error instanceof Error
              ? error.message
              : "Transcription failed.",
        });
      } finally {
        cleanup();
      }
    };

    mediaRecorder.start(1000);
  } catch (error) {
    cleanup();

    throw error;
  }
}

function stopRecording(): void {
  if (
    mediaRecorder &&
    mediaRecorder.state !== "inactive"
  ) {
    mediaRecorder.stop();
    return;
  }

  cleanup();
}

function cleanup(): void {
  mediaRecorder = null;

  stream?.getTracks().forEach(
    (track) => track.stop(),
  );

  stream = null;

  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }

  chunks = [];
}

chrome.runtime.onMessage.addListener(
  (
    message,
    _sender,
    sendResponse,
  ) => {
    if (message?.target !== "offscreen") {
      return false;
    }

    if (
      message.type ===
      "START_AUDIO_CAPTURE"
    ) {
      startRecording(
        message.streamId,
      )
        .then(() => {
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
                : "Could not start audio capture.",
          });
        });

      return true;
    }

    if (
      message.type ===
      "STOP_AUDIO_CAPTURE"
    ) {
      stopRecording();

      sendResponse({
        success: true,
      });

      return false;
    }

    return false;
  },
);