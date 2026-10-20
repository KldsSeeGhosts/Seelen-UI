<script lang="ts">
  import { invoke, SeelenCommand } from "@seelen-ui/lib";
  import FileIcon from "libs/ui/svelte/components/Icon/FileIcon.svelte";
  import { t } from "../i18n";

  interface Props {
    path: string;
    displayName: string;
  }

  let { path, displayName }: Props = $props();

  function selectFileOnExplorer() {
    invoke(SeelenCommand.SelectFileOnExplorer, { path });
  }
</script>

<button
  class="user-file"
  onclick={selectFileOnExplorer}
  title={`${$t("folders.open_in_explorer")}: ${path}`}
  aria-label={`${displayName}: ${$t("folders.open_in_explorer")}`}
>
  <FileIcon class="user-file-icon" {path} lazy />
  <div class="user-file-label">{displayName}</div>
  <!-- <div class="user-file-date">{lastAccessTime}</div> -->
</button>
