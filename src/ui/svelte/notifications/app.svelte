<script lang="ts">
  import { globalState } from "./state.svelte";
  import { Widget, invoke, SeelenCommand } from "@seelen-ui/lib";
  import { t } from "./i18n/index.ts";
  import Notification from "./components/Notification.svelte";
  import { Icon } from "libs/ui/svelte/components/Icon";

  let bodyElement = $state<HTMLElement | null>(null);

  $effect(() => {
    Widget.getCurrent().ready();
  });

  // A retained popup keeps the scroll offset of the previous open; newest notifications are at
  // the top, so every open starts there again.
  $effect(() => {
    if (globalState.showRevision > 0 && bodyElement) {
      bodyElement.scrollTop = 0;
    }
  });

  async function handleClearAll() {
    try {
      await invoke(SeelenCommand.NotificationsCloseAll);
    } catch (error) {
      console.error("Failed to clear notifications:", error);
    }
  }

  function toggleDnd() {
    void globalState.toggleFocusAssist();
  }

  async function handleOpenSettings() {
    try {
      await invoke(SeelenCommand.OpenFile, {
        path: "ms-settings:notifications",
      });
    } catch (error) {
      console.error("Failed to open notification settings:", error);
    }
  }
</script>

<div class="slu-std-popover notifications-popup">
  <div class="notifications-popup-header">
    <span>{$t("title")}</span>

    {#if globalState.focusAssistModeStatus === "error"}
      <button
        data-skin="default"
        onclick={() => globalState.retryFocusAssist()}
        title={$t("retry")}
        aria-label={$t("retry")}
      >
        <Icon iconName="TbRefresh" />
      </button>
    {:else}
      <button
        data-skin={globalState.isDndActive ? "solid" : "default"}
        disabled={globalState.focusAssistModeStatus !== "ready" || globalState.focusAssistPending}
        aria-busy={globalState.focusAssistModeStatus === "loading" || globalState.focusAssistPending}
        onclick={toggleDnd}
        aria-label={$t("dnd")}
      >
        <Icon iconName={globalState.isDndActive ? "IoMoon" : "IoMoonOutline"} />
      </button>
    {/if}

    <button data-skin="default" onclick={handleClearAll}>
      {$t("clear")}
    </button>
  </div>

  {#if globalState.focusAssistFailed}
    <p class="notifications-popup-status" role="status">{$t("dnd_failed")}</p>
  {/if}

  <div
    class="notifications-popup-body"
    aria-busy={globalState.notificationsStatus === "loading"}
    bind:this={bodyElement}
  >
    {#if globalState.notificationsStatus === "ready"}
      {#each globalState.notifications as notification (notification.id)}
        <Notification {notification} now={globalState.now} />
      {/each}

      {#if globalState.notifications.length === 0}
        <div class="notifications-popup-empty">
          <p>{$t("empty")}</p>
        </div>
      {/if}
    {:else if globalState.notificationsStatus === "loading"}
      <div class="notifications-popup-empty">
        <p>{$t("loading")}</p>
      </div>
    {:else}
      <div class="notifications-popup-empty">
        <p>{$t("load_failed")}</p>
      </div>
      <button data-skin="default" onclick={() => globalState.retryNotifications()}>
        {$t("retry")}
      </button>
    {/if}
  </div>

  <div class="notifications-popup-footer">
    <button data-skin="transparent" onclick={handleOpenSettings}>
      {$t("settings")}
    </button>
  </div>
</div>
