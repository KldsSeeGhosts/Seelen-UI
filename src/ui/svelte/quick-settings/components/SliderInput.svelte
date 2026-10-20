<script lang="ts">
  import { throttle } from "lodash";

  interface Props {
    /** Latest value reported by the backend, from 0 to 100. */
    value: number;
    /** Persists the value. Rejections are logged and the slider resyncs with `value`. */
    commit: (value: number) => Promise<unknown>;
    /** Renders the percentage readout next to the input, sharing the slider's local value. */
    showPercentage?: boolean;
  }

  let { value, commit, showPercentage = false }: Props = $props();

  /** Minimum delay between backend writes while the user is interacting. */
  const WRITE_INTERVAL_MS = 100;
  /** How long the local value keeps winning over snapshots that do not match it. */
  const SETTLE_MS = 1200;

  /** Value displayed while the user interacts or while a write is still settling. */
  let local = $state<number | null>(null);
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
    local = null;
  }

  /** Resyncs only when the user is not moving the slider, so a failure never fights a drag. */
  function resyncIfIdle() {
    if (interacting) {
      return;
    }
    resync();
  }

  const sendThrottled = throttle((next: number) => {
    commit(next).catch((error) => {
      console.error("Failed to set the slider value:", error);
      // an older write failing must not discard a newer value the user picked
      if (requested === next) {
        resyncIfIdle();
      }
    });
  }, WRITE_INTERVAL_MS);

  function onInput(event: Event) {
    const next = Number((event.currentTarget as HTMLInputElement).value);
    // a new interaction owns the value, an old settle timer must not clear it mid-drag
    clearSettleTimer();
    interacting = true;
    overriding = true;
    requested = next;
    local = next;
    sendThrottled(next);
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
    const external = Math.round(value);
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

  const displayed = $derived(local ?? Math.round(value));
</script>

<input
  type="range"
  data-skin="flat"
  min={0}
  max={100}
  step={1}
  value={displayed}
  oninput={onInput}
  onchange={() => endInteraction(false)}
  onpointerup={() => endInteraction(true)}
  onpointercancel={() => endInteraction(true)}
  onblur={() => endInteraction(true)}
/>

{#if showPercentage}
  <span class="quick-settings-percentage">{displayed}%</span>
{/if}
