<script lang="ts">
  import { invoke, SeelenCommand } from "@seelen-ui/lib";
  import { Icon } from "libs/ui/svelte/components/Icon";
  import { brightnessIcon } from "libs/ui/utils";
  import type { PhysicalMonitor } from "@seelen-ui/lib/types";
  import { SliderInput } from "libs/ui/svelte/components/SliderInput";

  interface Props {
    monitor: PhysicalMonitor;
    orientation: "horizontal" | "vertical";
  }

  let { monitor, orientation }: Props = $props();

  function setBrightness(id: string, brightness: number) {
    return invoke(SeelenCommand.SetMonitorBrightness, { id, brightness });
  }
</script>

<div class="brightness">
  <Icon iconName={brightnessIcon(monitor.brightness ?? 0)} />
  <SliderInput
    value={monitor.brightness ?? 0}
    commit={(brightness) => setBrightness(monitor.id, brightness)}
    {orientation}
  >
    {#snippet readout(percent)}
      <span class="flyout-value-label">{Math.round(percent)}%</span>
    {/snippet}
  </SliderInput>
</div>
