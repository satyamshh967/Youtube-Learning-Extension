function getYouTubeVideoId(): string | null {
  const url = new URL(window.location.href);

  return url.searchParams.get("v");
}

function getYouTubeVideoTitle(): string {
  return document.title.replace(" - YouTube", "").trim();
}

const videoId = getYouTubeVideoId();
const title = getYouTubeVideoTitle();

if (videoId) {
  console.log("YouTube Learning Companion");
  console.log("Video ID:", videoId);
  console.log("Video title:", title);
}