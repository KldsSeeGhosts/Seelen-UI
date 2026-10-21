import { invoke, SeelenCommand, SeelenEvent, subscribe } from "@seelen-ui/lib";
import type { AppBarEdge, Rect } from "@seelen-ui/lib/types";

function rectKey(rect: Rect): string {
  return `${rect.left},${rect.top},${rect.right},${rect.bottom}`;
}

let approved = $state<Rect | null>(null);

/** Keeps a widget's geometry aligned with the reservation approved by Windows. */
class AppBarState {
  private requestedKey: string | null = null;
  private requestedEdge: AppBarEdge | null = null;
  private generation = 0;
  private eventRevision = 0;
  private queue: Promise<void> = Promise.resolve();
  private readonly ready: Promise<void>;

  constructor() {
    this.ready = invoke(SeelenCommand.GetSelfWindowId).then(async (hwnd) => {
      await subscribe(SeelenEvent.AppBarPositionChanged, ({ payload }) => {
        if (payload.hwnd === hwnd && rectKey(payload.requested) === this.requestedKey) {
          this.eventRevision++;
          approved = payload.rect;
        }
      });
    });
  }

  get rect(): Rect | null {
    return approved;
  }

  sync(rect: Rect, edge: AppBarEdge, enabled: boolean): Promise<void> {
    const key = enabled ? rectKey(rect) : null;
    if (!enabled || edge !== this.requestedEdge) approved = null;
    this.requestedKey = key;
    this.requestedEdge = enabled ? edge : null;
    const generation = ++this.generation;

    const operation = this.queue.catch(() => {}).then(async () => {
      await this.ready;
      if (generation !== this.generation) return;
      if (enabled) {
        const revision = this.eventRevision;
        try {
          const approvedRect = await invoke(SeelenCommand.RegisterAppBar, { rect, edge });
          if (generation === this.generation && revision === this.eventRevision) approved = approvedRect;
        } catch (error) {
          if (generation === this.generation) approved = null;
          throw error;
        }
      } else {
        await invoke(SeelenCommand.UnregisterAppBar);
      }
    });
    this.queue = operation;
    return operation;
  }
}

export const appBarState = new AppBarState();
