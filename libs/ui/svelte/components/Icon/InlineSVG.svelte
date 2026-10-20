<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { inlineSVGState } from "./InlineSVGState.svelte";

  interface Props {
    src: string;
    class?: ClassValue;
    [key: string]: any;
  }

  let { src, class: className, ...rest }: Props = $props();

  let svgContent = $derived(inlineSVGState.get(src));

  $effect(() => {
    inlineSVGState.fetch(src);
  });
</script>

{#if svgContent}
  <i {...rest} class={["svg-icon", className]}>
    {@html svgContent}
  </i>
{/if}

<style>
  @layer svg-icon {
    .svg-icon :global(> svg) {
      width: 100%;
      height: 100%;
    }
  }
</style>
