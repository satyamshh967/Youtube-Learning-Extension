interface VideoInfo {
  id: string | null;
  title: string;
  isYouTubeVideo: boolean;
}

function getVideoInfo(): VideoInfo {
  const url = new URL(window.location.href);
  const videoId =
    url.pathname === "/watch"
      ? url.searchParams.get("v")
      : null;

  return {
    id: videoId,
    title: document.title.replace(" - YouTube", "").trim(),
    isYouTubeVideo: Boolean(videoId),
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GET_VIDEO_INFO") {
    sendResponse(getVideoInfo());
  }
});