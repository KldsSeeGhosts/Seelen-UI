<script lang="ts">
  import { Widget } from "@seelen-ui/lib";
  import { DragDropProvider } from "@dnd-kit/svelte";
  import { move } from "@dnd-kit/helpers";
  import { onDestroy } from "svelte";
  import { createDragDropManager } from "libs/ui/dnd.ts";
  import { state } from "./state.svelte";
  import TrayEntry from "./TrayEntry.svelte";
  import { t } from "./i18n";

  $effect(() => {
    Widget.getCurrent().ready();
  });

  // Workaround for https://github.com/clauderic/dnd-kit/issues/2112
  const manager = createDragDropManager();
  onDestroy(() => {
    state.endDrag(true);
    manager.destroy();
  });

  function handleDragOver(event: any) {
    const currentKeys = state.order.map((item) => item.registryKey);
    const newKeys = move(currentKeys, event);
    if (newKeys === currentKeys) {
      return;
    }
    const byKey = new Map(state.order.map((item) => [item.registryKey, item]));
    state.previewDrag(newKeys.map((key) => byKey.get(key)!));
  }

  function handleDragEnd(event: any) {
    state.endDrag(event.canceled);
  }
</script>

<div class={["slu-std-popover", "system-tray"]} aria-busy={state.status === "loading"}>
  {#if state.status === "error"}
    <div>{$t("load_failed")}</div>
    <button data-skin="default" onclick={() => state.retry()}>{$t("retry")}</button>
  {:else if state.status === "loading" && state.order.length === 0}
    <div>{$t("loading")}</div>
  {:else}
    <DragDropProvider
      {manager}
      onDragStart={() => state.beginDrag()}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      {#each state.order as item, index (item.registryKey)}
        <TrayEntry {item} {index} />
      {/each}
    </DragDropProvider>
  {/if}
</div>
