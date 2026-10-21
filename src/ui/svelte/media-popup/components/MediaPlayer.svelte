<script lang="ts">
  import type { MediaPlayer } from "@seelen-ui/lib/types";
  import { invoke, SeelenCommand } from "@seelen-ui/lib";
  import { Icon, FileIcon, iconPackManager } from "libs/ui/svelte/components/Icon";
  import { convertFileSrc } from "@tauri-apps/api/core";
  import MediaProgress from "./MediaProgress.svelte";
  import { globalState } from "../state.svelte";

  interface Props {
    session: MediaPlayer;
  }

  let { session }: Props = $props();

  const MAX_LUMINANCE = 210;
  const MIN_LUMINANCE = 40;
  const BRIGHTNESS_MULTIPLIER = 1.5;
  /** The average color does not need the full artwork; 32px avoids decoding it into a huge canvas. */
  const LUMINANCE_SAMPLE_SIZE = 32;

  let luminance = $state(0);
  /** Incremented by every newer calculation, so a slow decode never overwrites a newer one. */
  let generation = 0;

  let thumbnailSrc = $derived.by(() => {
    if (session?.thumbnail) {
      return convertFileSrc(session.thumbnail);
    }
    const icon = iconPackManager.value.getCustomIcon("defaultPlayerThumbnail");
    const resolved = icon ? iconPackManager.resolve(icon).src : null;
    return resolved || "";
  });

  function calcLuminance(imageUrl: string, signal: AbortSignal): Promise<number> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "Anonymous";

      img.onload = () => {
        if (signal.aborted) {
          resolve(0);
          return;
        }
        try {
          const canvas = document.createElement("canvas");
          canvas.width = LUMINANCE_SAMPLE_SIZE;
          canvas.height = LUMINANCE_SAMPLE_SIZE;
          const ctx = canvas.getContext("2d");

          if (!ctx) {
            throw new Error("Unable to get canvas context");
          }

          ctx.drawImage(img, 0, 0, LUMINANCE_SAMPLE_SIZE, LUMINANCE_SAMPLE_SIZE);

          const imageData = ctx.getImageData(0, 0, LUMINANCE_SAMPLE_SIZE, LUMINANCE_SAMPLE_SIZE);
          const data = imageData.data;
          let totalLuminance = 0;

          for (let i = 0; i < data.length; i += 4) {
            const r = data[i] ?? 0;
            const g = data[i + 1] ?? 0;
            const b = data[i + 2] ?? 0;

            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
            totalLuminance += lum;
          }

          resolve(totalLuminance / (data.length / 4));
        } catch (error) {
          reject(error);
        }
      };

      img.onerror = () => reject(new Error("Unable to load the media thumbnail"));
      img.src = imageUrl;
    });
  }

  // Only the visible popup pays for the calculation, and the latest artwork always wins.
  $effect(() => {
    const src = thumbnailSrc;
    const visible = globalState.visible;
    if (!visible || !src) {
      return;
    }

    const run = ++generation;
    const controller = new AbortController();
    calcLuminance(src, controller.signal)
      .then((lum) => {
        if (run === generation) {
          luminance = lum;
        }
      })
      .catch((error) => {
        if (run === generation) {
          console.error("Failed to calculate the media thumbnail luminance:", error);
        }
      });

    return () => {
      controller.abort();
      if (run === generation) {
        generation += 1;
      }
    };
  });

  const filteredLuminance = $derived(
    Math.max(Math.min(luminance * BRIGHTNESS_MULTIPLIER, MAX_LUMINANCE), MIN_LUMINANCE),
  );

  const color = $derived(filteredLuminance < 125 ? "var(--color-fixed-gray-50)" : "var(--color-fixed-gray-800)");
</script>

<div
  class="media-session"
  style:background-color="rgb({filteredLuminance}, {filteredLuminance}, {filteredLuminance})"
  style:color
>
  <img class="media-session-blurred-thumbnail" src={thumbnailSrc} alt="" />

  <div class="media-session-thumbnail-container">
    <img class="media-session-thumbnail" src={thumbnailSrc} alt="" />
  </div>

  <div class="media-session-info">
    <h4 class="media-session-title">{session.title}</h4>
    <span class="media-session-author">{session.author}</span>
  </div>

  <FileIcon class="media-session-app-icon" umid={session.umid} title={session.owner.name} />

  <MediaProgress {session} />

  <div class="media-session-actions">
    <button
      data-skin="transparent"
      onclick={() => invoke(SeelenCommand.MediaPrev, { id: session.umid })}
    >
      <Icon iconName="IoPlaySkipBack" />
    </button>
    <button
      data-skin="transparent"
      onclick={() => invoke(SeelenCommand.MediaTogglePlayPause, { id: session.umid })}
    >
      <Icon iconName={session.playing ? "IoPause" : "IoPlay"} />
    </button>
    <button
      data-skin="transparent"
      onclick={() => invoke(SeelenCommand.MediaNext, { id: session.umid })}
    >
      <Icon iconName="IoPlaySkipForward" />
    </button>
  </div>
</div>
