<script lang="ts">
  import { globalState } from "../state.svelte";
  import { t } from "../i18n";
  import VolumeControl from "./VolumeControl.svelte";
  import MediaDevice from "./MediaDevice.svelte";
  import MediaPlayer from "./MediaPlayer.svelte";
  import MediaSectionStatus from "./MediaSectionStatus.svelte";

  function setViewDeviceId(id: string) {
    globalState.selectedDeviceId = id;
    globalState.view = "mixer";
  }
</script>

<div class="media-main-view">
  {#if globalState.devicesStatus === "ready"}
    {#if globalState.defaultOutput || globalState.defaultInput}
      <span class="media-control-label">
        {$t("default_multimedia_volume")}
      </span>

      {#if globalState.defaultOutput}
        {#key globalState.defaultOutput.id}
        <VolumeControl
          value={globalState.defaultOutput.volume}
          deviceId={globalState.defaultOutput.id}
          icon="IoVolumeHighOutline"
          mutedIcon="IoVolumeMuteOutline"
          muted={globalState.defaultOutput.muted}
          onRightAction={() => setViewDeviceId(globalState.defaultOutput!.id)}
        />
        {/key}
      {/if}

      {#if globalState.defaultInput}
        {#key globalState.defaultInput.id}
        <VolumeControl
          value={globalState.defaultInput.volume}
          deviceId={globalState.defaultInput.id}
          icon="IoMicOutline"
          mutedIcon="IoMicOffOutline"
          muted={globalState.defaultInput.muted}
          onRightAction={() => setViewDeviceId(globalState.defaultInput!.id)}
        />
        {/key}
      {/if}
    {/if}

    {#if globalState.outputs.length > 0}
      <span class="media-control-label">
        {$t("output_devices")}
      </span>
      <div class="media-device-group">
        {#each globalState.outputs as device (device.id)}
          <MediaDevice {device} {setViewDeviceId} />
        {/each}
      </div>
    {/if}

    {#if globalState.inputs.length > 0}
      <span class="media-control-label">
        {$t("input_devices")}
      </span>
      <div class="media-device-group">
        {#each globalState.inputs as device (device.id)}
          <MediaDevice {device} {setViewDeviceId} />
        {/each}
      </div>
    {/if}
  {:else}
    <MediaSectionStatus
      title={$t("device.multimedia")}
      status={globalState.devicesStatus}
      onRetry={() => globalState.retryDevices()}
    />
  {/if}

  {#if globalState.sessionsStatus === "ready"}
    {#if globalState.sessions.length > 0}
      <span class="media-control-label">{$t("players")}</span>
      <div class="media-control-session-list">
        {#each globalState.sessions as session (session.umid)}
          <MediaPlayer {session} />
        {/each}
      </div>
    {/if}
  {:else}
    <MediaSectionStatus
      title={$t("players")}
      status={globalState.sessionsStatus}
      onRetry={() => globalState.retrySessions()}
    />
  {/if}
</div>
