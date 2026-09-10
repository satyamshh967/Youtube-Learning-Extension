import { useEffect, useState } from "react";

interface VideoInfo {
  id: string;
  title: string;
}

function App() {
  const [video, setVideo] = useState<VideoInfo | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const videoId = params.get("v");

    if (videoId) {
      setVideo({
        id: videoId,
        title: "YouTube video detected"
      });
    }
  }, []);

  return (
    <main style={{ width: "360px", padding: "20px" }}>
      <h1>YouTube Learning Companion</h1>

      {video ? (
        <section>
          <p>✅ YouTube video detected</p>

          <p>
            <strong>Video ID:</strong>
          </p>

          <code>{video.id}</code>
        </section>
      ) : (
        <p>Open a YouTube video to get started.</p>
      )}
    </main>
  );
}

export default App;