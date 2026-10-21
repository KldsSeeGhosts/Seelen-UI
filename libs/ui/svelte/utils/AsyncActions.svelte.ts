/**
 * Tracks in-flight user actions and their failures for a set of controls.
 *
 * A control disables itself while its own action is pending, so a second activation can never
 * race the first one, and reports the failure afterwards. The caller passes a `recover`
 * function that reads the affected data again, so a control that failed can never keep
 * displaying a value the backend did not accept.
 */
export class AsyncActions {
  private pending = $state<string[]>([]);
  private failed = $state<string[]>([]);

  /** Returns if the action for `key` is still running. */
  isPending(key: string): boolean {
    return this.pending.includes(key);
  }

  /** Returns if the action for `key` failed; without a key, if any action failed. */
  hasFailed(key?: string): boolean {
    return key === undefined ? this.failed.length > 0 : this.failed.includes(key);
  }

  /**
   * Runs `action` once for `key`. Repeated activations while it is pending are ignored. A
   * rejected action marks the key as failed and awaits `recover` so the control resyncs with
   * the backend before it becomes usable again.
   */
  async run(
    key: string,
    action: () => Promise<unknown>,
    recover?: () => Promise<unknown> | unknown,
  ): Promise<boolean> {
    if (this.isPending(key)) {
      return false;
    }
    this.pending = [...this.pending, key];
    this.failed = this.failed.filter((failed) => failed !== key);

    try {
      await action();
      return true;
    } catch (error) {
      this.failed = [...this.failed, key];
      console.error(`Action "${key}" failed:`, error);
      try {
        await recover?.();
      } catch (recoveryError) {
        console.error(`Action "${key}" failed to resync:`, recoveryError);
      }
      return false;
    } finally {
      this.pending = this.pending.filter((pending) => pending !== key);
    }
  }

  /** Clears the recorded failure of `key`, or every failure when no key is given. */
  clearFailures(key?: string): void {
    this.failed = key === undefined ? [] : this.failed.filter((failed) => failed !== key);
  }
}
