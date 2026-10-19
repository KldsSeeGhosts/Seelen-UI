<script lang="ts">
  import { invoke, SeelenCommand } from "@seelen-ui/lib";
  import { Icon } from "libs/ui/svelte/components/Icon";
  import { state } from "../state.svelte";
  import { brightnessIcon } from "libs/ui/utils";
  import { throttle } from "lodash";
  import { t } from "../i18n";

  const hasBrightness = $derived(state.monitors.some((monitor) => monitor.brightness != null));

  const setBrightnessThrottled = throttle((id: string, brightness: number) => {
    invoke(SeelenCommand.SetMonitorBrightness, { id, brightness });
  }, 100);
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
          <input
            type="range"
            data-skin="flat"
            value={monitor.brightness}
            oninput={(e) => {
              setBrightnessThrottled(monitor.id, Number(e.currentTarget.value));
            }}
            min={0}
            max={100}
          />
        </div>
      {/if}
    {/each}
  </section>
{/if}
