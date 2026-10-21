import type { UnSubscriber } from "@seelen-ui/lib";

export type AsyncSectionStatus = "loading" | "ready" | "error";

/**
 * Optional data of a popup section.
 *
 * Loading is started explicitly, so the popup shell can render before any read is requested
 * and a rejected read can never prevent the mount. A push event received while the initial
 * fetch is in flight is newer than its response, so every applied snapshot bumps a revision
 * that stale responses are discarded against. The subscription is awaited before the fetch,
 * so no update can be missed in between.
 */
export class AsyncSection<T> {
  private data = $state.raw<T | undefined>(undefined);
  private status = $state<AsyncSectionStatus>("loading");
  /** Incremented by every applied snapshot, so out-of-order responses can be discarded. */
  private revision = 0;
  private subscription: Promise<void> | null = null;

  constructor(
    /** Used only to identify the section on error logs. */
    private readonly label: string,
    private readonly fetch: () => Promise<T>,
    private readonly listen?: (apply: (value: T) => void) => Promise<UnSubscriber>,
  ) {}

  get value(): T | undefined {
    return this.data;
  }

  get state(): AsyncSectionStatus {
    return this.status;
  }

  private ensureSubscription(): Promise<void> {
    if (!this.listen) {
      return Promise.resolve();
    }
    this.subscription ??= this.listen((value) => this.apply(value))
      .then(() => undefined)
      .catch((error) => {
        this.subscription = null;
        throw error;
      });
    return this.subscription;
  }

  private apply(value: T): void {
    this.revision += 1;
    this.data = value;
    this.status = "ready";
  }

  /** Applies a locally known snapshot, bypassing the fetch. */
  set(value: T): void {
    this.apply(value);
  }

  /**
   * Reads the section. `refresh` keeps the retained snapshot and its ready state while the
   * read is in flight, which is what a resync after a failed action needs.
   */
  async load(refresh = false): Promise<void> {
    const revision = ++this.revision;
    if (!refresh || this.data === undefined) {
      this.status = "loading";
    }

    try {
      // Awaiting the acknowledgement guarantees no background update is missed before the fetch.
      await this.ensureSubscription();
    } catch (error) {
      console.error(`popup section "${this.label}": failed to subscribe`, error);
      if (revision === this.revision) {
        this.status = "error";
      }
      return;
    }

    try {
      const snapshot = await this.fetch();
      if (revision !== this.revision) {
        return; // an event or a newer request already provided the data
      }
      this.data = snapshot;
      this.status = "ready";
    } catch (error) {
      if (revision !== this.revision) {
        return;
      }
      console.error(`popup section "${this.label}": failed to load`, error);
      this.status = "error";
    }
  }
}
