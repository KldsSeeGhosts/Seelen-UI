<script lang="ts">
  import type { User } from "@seelen-ui/lib/types";
  import { invoke, SeelenCommand } from "@seelen-ui/lib";
  import { convertFileSrc } from "@tauri-apps/api/core";
  import { path } from "@tauri-apps/api";
  import Icon from "libs/ui/svelte/components/Icon/Icon.svelte";
  import { t } from "../i18n";

  interface Props {
    user: User;
  }

  let { user }: Props = $props();

  /** First grapheme of the name, drawn as the avatar monogram when there is no picture. */
  const monogram = $derived(firstGrapheme(user.name).toUpperCase());

  async function openUserFolder() {
    invoke(SeelenCommand.OpenFile, { path: await path.homeDir() });
  }

  function openOneDrive() {
    if (user.oneDrivePath) {
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

<div class="user-profile">
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
</div>
