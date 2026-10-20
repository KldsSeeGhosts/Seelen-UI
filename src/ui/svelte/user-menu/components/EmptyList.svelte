<script lang="ts">
  import { t } from "../i18n";

  interface Props {
    /** i18n key of the message to display, defaults to the empty list message. */
    messageKey?: string;
  }

  let { messageKey = "empty_list" }: Props = $props();
</script>

<div class="user-empty-list">{$t(messageKey)}</div>
