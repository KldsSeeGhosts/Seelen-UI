<script lang="ts">
  import { invoke, SeelenCommand, Widget } from "@seelen-ui/lib";
  import Icon from "libs/ui/svelte/components/Icon/Icon.svelte";
  import { globalState } from "./state.svelte";
  import { t } from "./i18n";

  $effect(() => {
    Widget.getCurrent().ready();
  });

  function openKeyboardSettings() {
    invoke(SeelenCommand.OpenFile, { path: "ms-settings:keyboard" }).catch((error) => {
      console.error("keyboard-selector: failed to open the keyboard settings", error);
    });
  }
</script>

<div class={["slu-std-popover", "keyboard-selector"]}>
  <div class="keyboard-selector-header">{$t("title")}</div>
  {#if globalState.actionFailed}
    <div role="status">{$t("change_failed")}</div>
  {/if}
  <div class="keyboard-selector-body" aria-busy={globalState.languagesStatus === "loading"}>
    {#if globalState.languagesStatus === "loading"}
      <div>{$t("loading")}</div>
    {:else if globalState.languagesStatus === "error"}
      <div>{$t("load_failed")}</div>
      <button data-skin="default" onclick={() => globalState.retryLanguages()}>
        {$t("retry")}
      </button>
    {:else}
      {#each globalState.langs as lang, li}
        {#each lang.keyboardLayouts as keyboard, ki (`${li}-${keyboard.handle}-${ki}`)}
          <button
            class="layout"
            class:layout-active={keyboard.active}
            disabled={globalState.isPending(keyboard.handle)}
            aria-busy={globalState.isPending(keyboard.handle)}
            onclick={() => globalState.selectLayout(keyboard.id, keyboard.handle)}
          >
            <div class="layout-icon">
              <Icon iconName="FaRegKeyboard" />
            </div>
            <div class="layout-info">
              <span class="layout-lang">
                {lang.name}
              </span>
              <span class="layout-keyboard">
                {keyboard.displayName}
              </span>
            </div>
          </button>
        {/each}
      {/each}
    {/if}
  </div>
  <div class="keyboard-selector-footer">
    <button data-skin="transparent" onclick={openKeyboardSettings}>
      {$t("more")}
    </button>
  </div>
</div>
