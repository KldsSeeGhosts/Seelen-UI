<script lang="ts">
  import type { DesktopWorkspace } from "@seelen-ui/lib/types";
  import { invoke, SeelenCommand, Widget } from "@seelen-ui/lib";
  import { Icon } from "libs/ui/svelte/components/Icon";
  import { Wallpaper } from "libs/ui/svelte/components/Wallpaper";
  import { state as store } from "../state.svelte";
  import { createDroppable } from "@dnd-kit/svelte";
  import { untrack } from "svelte";

  interface Props {
    row: number;
    column: number;
    workspace: DesktopWorkspace;
    active: boolean;
    viewing: boolean;
    onHover: () => void;
  }

  let { workspace, row, column, active, viewing, onHover }: Props = $props();

  const wallpaper = $derived(store.findWallpaper(workspace.wallpaper));

  let workspaceName = $state("");
  let editingName = $state(false);
  let draftWorkspaceId: string | null = null;

  $effect(() => {
    const id = workspace.id;
    const name = workspace.name || "";
    untrack(() => {
      if (!editingName || draftWorkspaceId !== id) {
        draftWorkspaceId = id;
        workspaceName = name;
      }
    });
  });

  const droppable = createDroppable({
    get id() {
      return workspace.id;
    },
  });

  async function switchWorkspace() {
    if (active) return;
    await Widget.self.hide();
    await invoke(SeelenCommand.SwitchWorkspace, {
      workspaceId: workspace.id,
    });
  }

  async function destroyWorkspace(e: MouseEvent) {
    e.stopPropagation();
    await invoke(SeelenCommand.DestroyWorkspace, {
      workspaceId: workspace.id,
    });
  }

  async function handleNameChange() {
    const newName = workspaceName.trim();
    if (newName === (workspace.name || "")) return;
    try {
      await invoke(SeelenCommand.RenameWorkspace, {
        workspaceId: workspace.id,
        name: newName || null,
      });
    } catch (error) {
      console.error("Failed to rename workspace:", error);
      workspaceName = workspace.name || "";
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      handleNameChange();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      workspaceName = workspace.name || "";
    }
  }
</script>

<div
  {@attach droppable.attach}
  class="workspace"
  class:workspace-active={active}
  class:workspace-viewing={viewing}
  class:workspace-drop-target={droppable.isDropTarget}
  role="button"
  tabindex="0"
  onmouseenter={onHover}
  onclick={(e) => {
    e.stopPropagation();
    switchWorkspace();
  }}
  onkeydown={(e) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      switchWorkspace();
    }
  }}
>
  <div class="workspace-header">
    <input
      type="text"
      bind:value={workspaceName}
      data-skin="transparent"
      class="workspace-name-input"
      placeholder={`Workspace ${row}.${column}`}
      onfocus={() => (editingName = true)}
      onblur={() => {
        editingName = false;
        handleNameChange();
      }}
      onkeydown={handleKeyDown}
      onclick={(e) => e.stopPropagation()}
    />
    <button data-skin="transparent" onclick={destroyWorkspace}>
      <Icon iconName="TbX" />
    </button>
  </div>

  <div class="workspace-preview">
    <Wallpaper definition={wallpaper} static muted />
  </div>
</div>

<style>
  .workspace-preview {
    position: relative;
  }
</style>
