<script lang="ts">
  import type { User } from "@seelen-ui/lib/types";
  import { invoke, SeelenCommand } from "@seelen-ui/lib";
  import { convertFileSrc } from "@tauri-apps/api/core";
  import { path } from "@tauri-apps/api";
  import Icon from "libs/ui/svelte/components/Icon/Icon.svelte";
  import { t } from "../i18n";
  import type { UserStatus } from "../state/mod.svelte";

  interface Props {
    user: User | null;
    status?: UserStatus;
    onRetry?: () => void;
  }

  let { user, status = "loading", onRetry }: Props = $props();

  /** First grapheme of the name, drawn as the avatar monogram when there is no picture. */
  const monogram = $derived(user ? firstGrapheme(user.name).toUpperCase() : "");

  async function openUserFolder() {
    invoke(SeelenCommand.OpenFile, { path: await path.homeDir() });
  }

  function openOneDrive() {
    if (user?.oneDrivePath) {
      invoke(SeelenCommand.OpenFile, { path: user.oneDrivePath });
    }
  }

  function openAccountSettings() {
    invoke(SeelenCommand.OpenFile, { path: "ms-settings:accounts" });
  }

  function firstGrapheme(text: string): string {
    let trimmed = text.trim();
    if (!trimmed) {
      return "";
    }
    let [first] = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(trimmed);
    return first?.segment ?? "";
  }
</script>

<div class="user-profile" aria-busy={status === "loading"}>
  {#if user}
    <div class="user-profile-container">
      <div class="user-profile-picture-container">
        {#if user.profilePicturePath}
          <img
            class="user-profile-picture"
            src={convertFileSrc(user.profilePicturePath)}
            alt={user.name}
          />
        {:else}
          <div class="user-profile-picture-fallback" aria-hidden="true">
            {#if monogram}
              {monogram}
            {:else}
              <Icon iconName="FaRegCircleUser" />
            {/if}
          </div>
        {/if}
      </div>

      <div class="user-profile-information">
        <div class="user-profile-name" title={user.name}>{user.name}</div>

        {#if user.email}
          <div class="user-profile-email" title={user.email}>{user.email}</div>
        {/if}
      </div>
    </div>

    <div class="user-profile-actions">
      <button
        data-skin="transparent"
        onclick={openAccountSettings}
        title={$t("profile.accounts")}
        aria-label={$t("profile.accounts")}
      >
        <Icon iconName="RiSettings3Fill" />
      </button>

      <button
        data-skin="transparent"
        onclick={openUserFolder}
        title={$t("profile.open_user_folder")}
        aria-label={$t("profile.open_user_folder")}
      >
        <Icon iconName="PiFolderUser" />
      </button>

      {#if user.oneDrivePath}
        <button data-skin="transparent" onclick={openOneDrive} title={$t("profile.open_onedrive")}>
          <Icon iconName="ImOnedrive" />
          <span>OneDrive</span>
        </button>
      {/if}
    </div>
  {:else}
    <div class="user-profile-container">
      <div class="user-profile-picture-container">
        <div class="user-profile-picture-fallback" aria-hidden="true">
          <Icon iconName="FaRegCircleUser" />
        </div>
      </div>

      <div class="user-profile-information">
        <div class="user-profile-name">
          {status === "error" ? $t("profile.load_failed") : $t("loading")}
        </div>
      </div>
    </div>

    {#if status === "error"}
      <div class="user-profile-actions">
        <button data-skin="default" onclick={() => onRetry?.()}>
          <Icon iconName="TbRefresh" />
          <span>{$t("retry")}</span>
        </button>
      </div>
    {/if}
  {/if}
</div>
