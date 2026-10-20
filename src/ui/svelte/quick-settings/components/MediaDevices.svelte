<script lang="ts">
  import { invoke, SeelenCommand } from "@seelen-ui/lib";
  import Icon from "libs/ui/svelte/components/Icon/Icon.svelte";
  import { state } from "../state.svelte";
  import { t } from "../i18n";
  import SliderInput from "./SliderInput.svelte";

  let defaultOutput = $derived(state.mediaOutputs.find((d) => d.isDefaultMultimedia));
  let defaultInput = $derived(state.mediaInputs.find((d) => d.isDefaultMultimedia));

  function toggleMute(deviceId: string) {
    invoke(SeelenCommand.MediaToggleMute, { deviceId, sessionId: null }).catch((error) => {
      console.error("Failed to toggle the mute state:", error);
    });
  }

  function setVolume(deviceId: string, percentage: number) {
    return invoke(SeelenCommand.SetVolumeLevel, {
      deviceId,
      sessionId: null,
      level: percentage / 100,
    });
  }
</script>

{#if defaultOutput || defaultInput}
  <section class="quick-settings-module">
    <span class="quick-settings-module-title">{$t("sound")}</span>

    {#if defaultOutput}
      {#key defaultOutput.id}
      <div class="quick-settings-item">
        <button data-skin="transparent" onclick={() => toggleMute(defaultOutput!.id)}>
          <Icon iconName={defaultOutput.muted ? "IoVolumeMuteOutline" : "IoVolumeHighOutline"} />
        </button>
        <SliderInput
          value={defaultOutput.volume * 100}
          commit={(percentage) => setVolume(defaultOutput!.id, percentage)}
          showPercentage
        />
      </div>
      {/key}
    {/if}

    {#if defaultInput}
      {#key defaultInput.id}
      <div class="quick-settings-item">
        <button data-skin="transparent" onclick={() => toggleMute(defaultInput!.id)}>
          <Icon iconName={defaultInput.muted ? "BiMicrophoneOff" : "BiMicrophone"} />
        </button>
        <SliderInput
          value={defaultInput.volume * 100}
          commit={(percentage) => setVolume(defaultInput!.id, percentage)}
          showPercentage
        />
      </div>
      {/key}
    {/if}
  </section>
{/if}
