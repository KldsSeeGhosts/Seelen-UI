<script lang="ts">
  import type { AsyncSectionStatus } from "../state.svelte";
  import { t } from "../i18n";

  interface Props {
    /** Section label, matching the label used for the loaded content. */
    title: string;
    status: Exclude<AsyncSectionStatus, "ready">;
    onRetry: () => void;
  }

  let { title, status, onRetry }: Props = $props();
</script>

<span class="media-control-label">{title}</span>
<span class="media-control-status" role="status" aria-busy={status === "loading"}>
  {$t(status === "loading" ? "loading" : "load_failed")}
</span>
{#if status === "error"}
  <button data-skin="default" onclick={onRetry}>{$t("retry")}</button>
{/if}
