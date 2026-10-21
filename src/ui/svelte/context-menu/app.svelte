<script lang="ts">
  import { Widget } from "@seelen-ui/lib";
  import { closeContextMenuChain, state } from "./state.svelte";
  import MenuItem from "./MenuItem.svelte";
  import Submenu from "./Submenu.svelte";

  let root: HTMLDivElement;

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeContextMenuChain();
      return;
    }
    const items = Array.from(root.querySelectorAll<HTMLButtonElement>("button.menu-item:not(:disabled)"));
    if (!items.length) return;
    const current = items.findIndex((item) => item === document.activeElement);
    let next: number;
    switch (event.key) {
      case "ArrowDown":
        next = (current + 1) % items.length;
        break;
      case "ArrowUp":
        next = (current - 1 + items.length) % items.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = items.length - 1;
        break;
      case "ArrowRight":
        if (items[current]?.hasAttribute("data-submenu")) {
          event.preventDefault();
          items[current]?.click();
        }
        return;
      default:
        return;
    }
    event.preventDefault();
    items[next]?.focus({ preventScroll: true });
  }

  $effect(() => {
    Widget.getCurrent().ready();
  });
</script>

<svelte:window onkeydown={handleKeyDown} />

<div bind:this={root} class="slu-std-popover context-menu" role="menu">
  {#each state.data?.items || [] as item}
    {#if item.type === "Separator"}
      <hr />
    {:else if item.type === "Item"}
      <MenuItem {item} />
    {:else if item.type === "Submenu"}
      <Submenu {item} />
    {/if}
  {/each}
</div>
