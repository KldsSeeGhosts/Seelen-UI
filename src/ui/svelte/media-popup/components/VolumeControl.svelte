<script lang="ts">
  import { invoke, SeelenCommand } from "@seelen-ui/lib";
  import Icon from "libs/ui/svelte/components/Icon/Icon.svelte";
  import { throttle } from "lodash";

  interface Props {
    value: number;
    icon: string;
    deviceId: string;
    sessionName?: string;
    sessionId?: string;
    onRightAction?: () => void;
    withPercentage?: boolean;
    mutedIcon?: string;
    muted?: boolean;
  }

  let {
    value,
    icon,
    deviceId,
    sessionName,
    sessionId,
    onRightAction,
    withPercentage = false,
    mutedIcon,
    muted = false,
  }: Props = $props();

  /** Minimum delay between backend writes while the user is interacting. */
  const WRITE_INTERVAL_MS = 100;
  /** How long the local value keeps winning over snapshots that do not match it. */
  const SETTLE_MS = 1200;

  /** Value displayed while the user interacts or while a write is still settling. */
  let internalValue = $state<number | null>(null);
  // plain bookkeeping: reading it from effects would make them retrigger needlessly
  let overriding = false;
  let interacting = false;
  let requested = 0;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;

  function clearSettleTimer() {
    if (settleTimer !== null) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
  }

  /** Drops the local value and shows the backend snapshot again. */
  function resync() {
    clearSettleTimer();
    overriding = false;
    internalValue = null;
  }

  /** Resyncs only when the user is not moving the slider, so a failure never fights a drag. */
  function resyncIfIdle() {
    if (interacting) {
      return;
    }
    resync();
  }

  const sendThrottled = throttle((level: number) => {
    invoke(SeelenCommand.SetVolumeLevel, {
      deviceId,
      sessionId: sessionId || null,
      level: level / 100,
    }).catch((error) => {
      console.error("Failed to set the volume level:", error);
      // an older write failing must not discard a newer value the user picked
      if (requested === level) {
        resyncIfIdle();
      }
    });
  }, WRITE_INTERVAL_MS);

  function onInput(event: Event) {
    const level = Number((event.currentTarget as HTMLInputElement).value);
    // a new interaction owns the value, an old settle timer must not clear it mid-drag
    clearSettleTimer();
    interacting = true;
    overriding = true;
    requested = level;
    internalValue = level;
    sendThrottled(level);
  }

  /**
   * Ends the current interaction. A pointer release writes the final value immediately, while key
   * repeats keep coalescing through the throttle (its trailing write always delivers the last one).
   */
  function endInteraction(flush: boolean) {
    if (flush) {
      sendThrottled.flush();
    }
    if (!interacting) {
      return;
    }
    interacting = false;
    clearSettleTimer();
    settleTimer = setTimeout(resyncIfIdle, SETTLE_MS);
  }

  // Backend snapshots (older echoes included) must not fight the user's movement.
  $effect(() => {
    const external = Math.round(value * 100);
    if (interacting || !overriding) {
      return;
    }
    if (external === requested) {
      // the write landed, the backend snapshot is authoritative again
      resync();
    }
  });

  $effect(() => {
    return () => {
      sendThrottled.cancel();
      clearSettleTimer();
    };
  });

  const displayed = $derived(internalValue ?? Math.round(value * 100));

  async function toggleMute() {
    await invoke(SeelenCommand.MediaToggleMute, {
      deviceId,
      sessionId: sessionId || null,
    }).catch((error) => console.error("Failed to toggle the mute state:", error));
  }
</script>

<div class="media-control-volume">
  <button data-skin="transparent" onclick={toggleMute} title={sessionName}>
    <Icon iconName={(muted && mutedIcon ? mutedIcon : icon) as any} />
  </button>

  <input
    type="range"
    data-skin="flat"
    value={displayed}
    min={0}
    max={100}
    step={1}
    oninput={onInput}
    onchange={() => endInteraction(false)}
    onpointerup={() => endInteraction(true)}
    onpointercancel={() => endInteraction(true)}
    onblur={() => endInteraction(true)}
  />

  {#if onRightAction}
    <button data-skin="transparent" onclick={onRightAction}>
      <Icon iconName="RiEqualizerLine" />
    </button>
  {/if}
</div>
