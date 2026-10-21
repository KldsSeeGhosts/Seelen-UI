<script lang="ts">
  import { invoke, SeelenCommand } from "@seelen-ui/lib";
  import Icon from "libs/ui/svelte/components/Icon/Icon.svelte";
  import { state } from "../state.svelte";
  import { brightnessIcon } from "libs/ui/utils";
  import { t } from "../i18n";
  import { SliderInput } from "libs/ui/svelte/components/SliderInput";

  const hasBrightness = $derived(state.monitors.some((monitor) => monitor.brightness != null));

  function setBrightness(monitorId: string, brightness: number) {
    return invoke(SeelenCommand.SetMonitorBrightness, { id: monitorId, brightness });
  }
</script>

{#if hasBrightness}
  <section class="quick-settings-module">
    <span class="quick-settings-module-title">{$t("display")}</span>

    {#each state.monitors as monitor (monitor.id)}
      {#if monitor.brightness != null}
        <span class="quick-settings-label">{monitor.name}</span>
        <div class="quick-settings-item">
          <span class="quick-settings-item-icon">
            <Icon iconName={brightnessIcon(monitor.brightness)} />
          </span>
          <SliderInput
            value={monitor.brightness}
            commit={(brightness) => setBrightness(monitor.id, brightness)}
          />
        </div>
      {/if}
    {/each}
  </section>
{/if}
