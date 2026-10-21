/**
 * Extracts the first frame of a video as a thumbnail image
 * @param videoElement - The video element to extract the frame from
 * @param quality - JPEG quality (0-1), default 0.9
 * @returns Promise with the thumbnail as Uint8Array bytes
 */
export async function extractVideoThumbnail(
  videoElement: HTMLVideoElement,
  quality: number = 0.9,
): Promise<Uint8Array | null> {
  try {
    // Wait for video to load metadata if not already loaded
    if (videoElement.readyState < HTMLMediaElement.HAVE_METADATA) {
      await waitForVideo(videoElement, "loadedmetadata");
    }

    const seekTime = Number.isFinite(videoElement.duration) ? Math.min(1, videoElement.duration / 2) : 1;
    if (Math.abs(videoElement.currentTime - seekTime) > 0.001) {
      await waitForVideo(videoElement, "seeked", () => {
        videoElement.currentTime = seekTime;
      });
    } else if (videoElement.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await waitForVideo(videoElement, "loadeddata");
    }

    // Bound thumbnail memory and IPC payloads even for 4K/8K wallpapers.
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 512 / Math.max(videoElement.videoWidth, videoElement.videoHeight));
    canvas.width = Math.max(1, Math.round(videoElement.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(videoElement.videoHeight * scale));

    // Draw video frame to canvas
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Failed to get canvas 2D context");
    }

    ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);

    // Convert canvas to blob
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality);
    });

    if (!blob) {
      throw new Error("Failed to create thumbnail blob");
    }

    // Convert blob to Uint8Array for efficient transfer to Rust
    const arrayBuffer = await blob.arrayBuffer();
    return new Uint8Array(arrayBuffer);
  } catch (error) {
    console.error("Failed to extract video thumbnail:", error);
    return null;
  }
}

/**
 * Creates a hidden video element to extract thumbnail from a video source
 * @param videoSrc - The video source URL
 * @param quality - JPEG quality (0-1), default 0.9
 * @returns Promise with the thumbnail as Uint8Array bytes
 */
export async function extractThumbnailFromSource(
  videoSrc: string,
  quality: number = 0.9,
): Promise<Uint8Array | null> {
  const video = document.createElement("video");
  video.style.display = "none";
  video.crossOrigin = "anonymous";
  video.preload = "metadata";
  video.src = videoSrc;

  document.body.appendChild(video);

  try {
    const thumbnail = await extractVideoThumbnail(video, quality);
    return thumbnail;
  } finally {
    // Cleanup
    video.pause();
    video.removeAttribute("src");
    video.load();
    document.body.removeChild(video);
  }
}
/** Corrupt or unsupported media must not leave the generation dialog waiting forever. */
function waitForVideo(
  video: HTMLVideoElement,
  event: "loadedmetadata" | "loadeddata" | "seeked",
  start?: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      video.removeEventListener(event, loaded);
      video.removeEventListener("error", failed);
    };
    const loaded = () => {
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(new Error(`Failed to load video frame (${event})`));
    };
    const timeout = setTimeout(failed, 15_000);
    video.addEventListener(event, loaded);
    video.addEventListener("error", failed);
    try {
      start?.();
    } catch {
      failed();
    }
  });
}
