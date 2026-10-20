<script lang="ts">
  import type { Component } from "svelte";
  import { FolderType } from "@seelen-ui/lib/types";
  import { invoke, SeelenCommand } from "@seelen-ui/lib";
  import { path } from "@tauri-apps/api";
  import Icon from "libs/ui/svelte/components/Icon/Icon.svelte";
  import { t } from "../i18n";
  import { globalState } from "../state/mod.svelte";
  import { knownFolders } from "../state/knownFolders.svelte";
  import EmptyList from "./EmptyList.svelte";

  interface Props {
    type: FolderType;
    icon: string;
  }

  const PAGE_SIZE = 24;

  let { type, icon }: Props = $props();

  const isOpen = $derived(globalState.openCategory === type);
  const folder = $derived(knownFolders.get(type));
  const listId = $derived(`user-folder-${type.toLowerCase()}`);
  const folderLabel = $derived($t(`folders.${type.toLowerCase()}`));

  let visibleCount = $state(PAGE_SIZE);
  let FilePreview = $state<Component<{ path: string; displayName: string }> | null>(null);
  let previewRequested = false;
  let previewError = $state(false);

  const visibleContent = $derived(folder.content.slice(0, visibleCount));
  const hasMore = $derived(folder.content.length > visibleCount);

  function loadPreviews() {
    if (previewRequested) return;
    previewRequested = true;
    previewError = false;
    // The file icon manager initializes at import time, so it must never gate the menu shell.
    void import("./FilePreview.svelte")
      .then((module) => {
        FilePreview = module.default;
      })
      .catch((error) => {
        previewRequested = false;
        previewError = true;
        console.error("user-menu: failed to load the file previews", error);
      });
  }

  $effect(() => {
    if (!isOpen || folder.content.length === 0 || previewRequested || previewError) return;
    loadPreviews();
  });

  async function getPathByFolderType(folderType: FolderType): Promise<string> {
    switch (folderType) {
      case FolderType.Recent:
        return (await path.dataDir()) + "\\Microsoft\\Windows\\Recent";
      case FolderType.Desktop:
        return await path.desktopDir();
      case FolderType.Documents:
        return await path.documentDir();
      case FolderType.Downloads:
        return await path.downloadDir();
      case FolderType.Music:
        return await path.audioDir();
      case FolderType.Pictures:
        return await path.pictureDir();
      case FolderType.Videos:
        return await path.videoDir();
    }
  }

  async function openOnExplorer() {
    invoke(SeelenCommand.OpenFile, {
      path: await getPathByFolderType(type),
    });
  }

  function toggle() {
    if (isOpen) {
      globalState.openCategory = null;
      return;
    }
    visibleCount = PAGE_SIZE;
    globalState.openCategory = type;
  }
</script>

<div class="user-directory">
  <div class="user-directory-summary">
    <button
      class="user-directory-open"
      title={$t("folders.open_in_explorer")}
      onclick={openOnExplorer}
    >
      <Icon iconName={icon as any} class="user-directory-icon" />
      <span class="user-directory-title">{folderLabel}</span>
    </button>

    <button
      class="user-directory-expand"
      data-skin="transparent"
      aria-expanded={isOpen}
      aria-controls={isOpen ? listId : undefined}
      aria-label={`${folderLabel}: ${isOpen ? $t("folders.collapse") : $t("folders.expand")}`}
      title={isOpen ? $t("folders.collapse") : $t("folders.expand")}
      onclick={toggle}
    >
      <Icon iconName="IoIosArrowDown" class={["chevron", { "chevron-active": isOpen }]} />
    </button>
  </div>

  {#if isOpen}
    <div class="file-list" id={listId} aria-busy={folder.status === "loading"}>
      {#if folder.status === "error" || previewError}
        <div class="user-empty-list">
          <span>{$t("folders.load_failed")}</span>
          <button data-skin="default" onclick={() => previewError ? loadPreviews() : knownFolders.retry(type)}>
            {$t("retry")}
          </button>
        </div>
      {:else if folder.status !== "ready" && folder.content.length === 0}
        <EmptyList messageKey="loading" />
      {:else if folder.content.length === 0}
        <EmptyList />
      {:else if !FilePreview}
        <EmptyList messageKey="loading" />
      {:else}
        {#each visibleContent as file (file.path)}
          <FilePreview path={file.path} displayName={file.displayName} />
        {/each}

        {#if hasMore}
          <button class="user-list-extender" onclick={() => (visibleCount += PAGE_SIZE)}>
            {$t("folders.more_items")}
          </button>
        {/if}
      {/if}
    </div>
  {/if}
</div>
