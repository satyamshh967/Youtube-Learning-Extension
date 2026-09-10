import { useEffect, useState } from "react";

interface VideoInfo {
  id: string | null;
  title: string;
  isYouTubeVideo: boolean;
}

function App() {
  const [video, setVideo] = useState<VideoInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    chrome.tabs.query(
      {
        active: true,
        currentWindow: true,
      },
      (tabs) => {
        const activeTab = tabs[0];

        if (!activeTab.id) {
          setError("Unable to find the active tab.");
          return;
        }

        chrome.tabs.sendMessage(
          activeTab.id,
          { type: "GET_VIDEO_INFO" },
          (response: VideoInfo | undefined) => {
            if (chrome.runtime.lastError) {
              setError("Open a YouTube video to get started.");
              return;
            }

            if (response) {
              setVideo(response);
            }
          },
        );
      },
    );
  }, []);

  return (
    <main
      style={{
        width: "360px",
        padding: "20px",
        fontFamily: "Arial, sans-serif",
      }}
    >
      <h1>YouTube Learning Companion</h1>

      {video?.isYouTubeVideo ? (
        <section>
          <p>✅ YouTube video detected</p>

          <p>
            <strong>Title:</strong>
          </p>

          <p>{video.title}</p>

          <p>
            <strong>Video ID:</strong>
          </p>

          <code>{video.id}</code>
        </section>
      ) : (
        <p>{error ?? "Open a YouTube video to get started."}</p>
      )}
    </main>
  );
}

export default App;