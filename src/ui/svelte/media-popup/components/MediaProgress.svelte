<script lang="ts">
  import type { MediaPlayer } from "@seelen-ui/lib/types";
  import { invoke, SeelenCommand, Widget } from "@seelen-ui/lib";
  import { nanosecondsToPlayingTime } from "libs/ui/utils";
  import { throttle } from "lodash";

  interface Props {
    session: MediaPlayer;
  }

  let { session }: Props = $props();

  const NS_PER_SECOND = 1_000_000_000;
  const NS_PER_MS = 1_000_000;
  const TICK_MS = 250;
  const SEEK_THROTTLE_MS = 200;
  /** Max distance between the requested and the reported position to consider a seek applied. */
  const SEEK_ECHO_TOLERANCE_NS = 1.5 * NS_PER_SECOND;
  /** How long the requested position keeps winning over snapshots that do not match it. */
  const SEEK_SETTLE_MS = 1500;

  const widget = Widget.self;

  let isSeeking = $state(false);
  let seekingPositionSeconds = $state(0);

  // The backend only pushes a new `timeline.position` when it changes on the OS side
  // (which happens infrequently), so while playing we interpolate locally using the
  // elapsed wall-clock time since the last snapshot instead of freezing the display.
  let basePosition = $state(0);
  let baseTimestamp = $state(Date.now());
  let now = $state(Date.now());

  /** Position asked for by the user, kept on screen until the backend reports it. */
  let pendingSeek: { umid: string; position: number } | null = null;
  let pendingSeekTimer: ReturnType<typeof setTimeout> | null = null;
  /** Last position reported by the backend, used to resync after a failed seek. */
  let lastReportedPosition = 0;
  let lastReportedTimestamp = Date.now();

  /** The interpolation timer is paused while the (retained) popup is hidden. */
  let windowVisible = $state(widget.isVisible);

  $effect(() => {
    const stopListening = widget.onVisibilityChanged((visible) => {
      windowVisible = visible;
    });
    // subscribe first, then read, so a change that happened in between is not lost
    windowVisible = widget.isVisible;
    return stopListening;
  });

  function clearPendingSeek() {
    pendingSeek = null;
    if (pendingSeekTimer !== null) {
      clearTimeout(pendingSeekTimer);
      pendingSeekTimer = null;
    }
  }

  function adoptSnapshot(position: number) {
    basePosition = position;
    const timestamp = Date.now();
    baseTimestamp = timestamp;
    now = timestamp;
  }

  function settleSeek() {
    if (!pendingSeek) return;
    clearPendingSeek();
    if (!isSeeking) {
      const elapsed = session.playing ? (Date.now() - lastReportedTimestamp) * NS_PER_MS : 0;
      adoptSnapshot(Math.min(session.timeline.end, lastReportedPosition + elapsed));
    }
  }

  // reset state on every backend position update
  $effect(() => {
    const position = session.timeline.position;
    const umid = session.umid;
    lastReportedPosition = position;
    lastReportedTimestamp = Date.now();

    if (pendingSeek !== null) {
      const isOurSeek = umid === pendingSeek.umid;
      const matches = Math.abs(position - pendingSeek.position) <= SEEK_ECHO_TOLERANCE_NS;
      if (isOurSeek && !matches) {
        // stale echo of an intermediate seek, keep showing the requested position
        return;
      }
      clearPendingSeek();
    }

    adoptSnapshot(position);
  });

  $effect(() => {
    if (!session.playing || !windowVisible) {
      return;
    }

    // resume the interpolation from the current wall clock instead of the paused one
    now = Date.now();
    const interval = setInterval(() => {
      now = Date.now();
    }, TICK_MS);
    return () => clearInterval(interval);
  });

  const livePosition = $derived(
    session.playing ? basePosition + (now - baseTimestamp) * NS_PER_MS : basePosition,
  );

  const position = $derived(
    isSeeking
      ? seekingPositionSeconds * NS_PER_SECOND
      : Math.min(livePosition, session.timeline.end),
  );

  const sendSeek = throttle((positionSeconds: number) => {
    const seekingPosition = Math.round(positionSeconds * NS_PER_SECOND);
    invoke(SeelenCommand.MediaSeek, {
      id: session.umid,
      position: seekingPosition,
    }).catch((error) => {
      console.error("Failed to seek the media session:", error);
      // the requested position will never be reported, fall back to the last known one
      if (!isSeeking && pendingSeek?.position === seekingPosition) {
        settleSeek();
      }
    });
  }, SEEK_THROTTLE_MS);

  function onSeekInput(e: Event & { currentTarget: HTMLInputElement }) {
    if (!isSeeking) clearPendingSeek();
    isSeeking = true;
    seekingPositionSeconds = Number(e.currentTarget.value);
    sendSeek(seekingPositionSeconds);
  }

  /**
   * Ends the current seek. A pointer release writes the exact position immediately, while key
   * repeats keep coalescing through the throttle (its trailing write always delivers the last one).
   */
  function endSeeking(flush: boolean) {
    if (flush) {
      sendSeek.flush();
    }
    if (!isSeeking) {
      return;
    }

    isSeeking = false;

    // continue from the requested position instead of snapping back to the previous snapshot
    // while the seek round-trips, and ignore echoes of the intermediate throttled seeks
    pendingSeek = { umid: session.umid, position: Math.round(seekingPositionSeconds * NS_PER_SECOND) };
    adoptSnapshot(pendingSeek.position);
    if (pendingSeekTimer !== null) {
      clearTimeout(pendingSeekTimer);
    }
    pendingSeekTimer = setTimeout(settleSeek, SEEK_SETTLE_MS);
  }

  $effect(() => {
    return () => {
      sendSeek.cancel();
      clearPendingSeek();
    };
  });
</script>

<div class="media-session-progress">
  <span class="media-session-time">{nanosecondsToPlayingTime(position)}</span>
  <input
    type="range"
    class="media-session-progress-bar"
    min={Math.floor(session.timeline.start / NS_PER_SECOND)}
    max={Math.ceil(session.timeline.end / NS_PER_SECOND)}
    step={1}
    value={Math.round(position / NS_PER_SECOND)}
    oninput={onSeekInput}
    onchange={() => endSeeking(false)}
    onpointerup={() => endSeeking(true)}
    onpointercancel={() => endSeeking(true)}
    onblur={() => endSeeking(true)}
  />
  <span class="media-session-time">{nanosecondsToPlayingTime(session.timeline.end)}</span>
</div>
