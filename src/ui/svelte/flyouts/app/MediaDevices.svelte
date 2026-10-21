<script lang="ts">
  import { invoke, SeelenCommand } from "@seelen-ui/lib";
  import { Icon } from "libs/ui/svelte/components/Icon";
  import { outputVolumeIcon } from "libs/ui/utils";
  import type { MediaDevice } from "@seelen-ui/lib/types";
  import { SliderInput } from "libs/ui/svelte/components/SliderInput";

  interface Props {
    output: MediaDevice;
    orientation: "horizontal" | "vertical";
  }

  let { output, orientation }: Props = $props();

  function setVolume(deviceId: string, level: number) {
    return invoke(SeelenCommand.SetVolumeLevel, { deviceId, sessionId: null, level: level / 100 });
  }

  function toggleMute(deviceId: string) {
    invoke(SeelenCommand.MediaToggleMute, { deviceId, sessionId: null }).catch((error) => {
      console.error("flyouts: failed to toggle the mute state", error);
    });
  }
</script>

<div class="volume">
  <Icon
    iconName={outputVolumeIcon(output.muted, output.volume)}
    onclick={() => toggleMute(output.id)}
  />
  <SliderInput value={output.volume * 100} commit={(level) => setVolume(output.id, level)} {orientation}>
    {#snippet readout(percent)}
      <span class="flyout-value-label">{Math.round(percent)}%</span>
    {/snippet}
  </SliderInput>
</div>
