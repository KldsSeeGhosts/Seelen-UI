<script lang="ts">
  import { globalState } from "./state/mod.svelte";
  import { invoke, SeelenCommand, Widget } from "@seelen-ui/lib";
  import Icon from "libs/ui/svelte/components/Icon/Icon.svelte";
  import { t } from "./i18n";
  import UserProfile from "./components/UserProfile.svelte";
  import UserFolder from "./components/UserFolder.svelte";
  import { path } from "@tauri-apps/api";
  import { folderDefinitions } from "./state/knownFolders.svelte";

  $effect(() => {
    Widget.getCurrent().ready();
  });

  async function openInstallationFolder() {
    invoke(SeelenCommand.OpenFile, { path: await path.appDataDir() });
  }

  async function openLogFolder() {
    invoke(SeelenCommand.OpenFile, { path: await path.appLogDir() });
  }

  function logOut() {
    invoke(SeelenCommand.LogOut);
  }
</script>

<div class="slu-std-popover user-popup">
  <UserProfile
    user={globalState.user}
    status={globalState.userStatus}
    onRetry={() => globalState.retryUser()}
  />

  <hr class="user-divider" />
  <span class="user-label">{$t("folders.title")}</span>
  {#each folderDefinitions as folder (folder.type)}
    <UserFolder type={folder.type} icon={folder.icon} />
  {/each}

  <hr class="user-divider" />
  <span class="user-label">{$t("seelen_options.title")}</span>
  <div class="user-seelen-options">
    <button class="user-seelen-option-item" onclick={openInstallationFolder}>
      <Icon iconName="TbFolderCog" />
      <span class="user-seelen-option-item-title">
        {$t("seelen_options.open_installation_folder")}
      </span>
    </button>
    <button class="user-seelen-option-item" onclick={openLogFolder}>
      <Icon iconName="TbLogs" />
      <span class="user-seelen-option-item-title">
        {$t("seelen_options.open_log_folder")}
      </span>
    </button>
  </div>

  <hr class="user-divider" />
  <div class="user-popup-footer">
    <button data-skin="default" onclick={logOut}>
      <Icon iconName="BiLogOut" />
      <span>{$t("profile.log_out")}</span>
    </button>
  </div>
</div>
