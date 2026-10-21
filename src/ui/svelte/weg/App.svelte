<script lang="ts">
  import { Widget } from "@seelen-ui/lib";
  import { onMount } from "svelte";
  import { debounce } from "lodash";
  import Dock from "./components/Dock.svelte";
  import { windowsState, focused, widgetStatuses } from "./state/windows.svelte.ts";
  import { overlayState } from "./state/overlays.svelte.ts";
  import { settingsState } from "./state/settings.svelte.ts";

  const startMenuExes = ["SearchHost.exe", "StartMenuExperienceHost.exe"];

  const topWindowIsFullscreen = $derived(windowsState.topInteractableWindow?.isFullscreen);

  const focusedIsAppsMenu = $derived(
    startMenuExes.some((program) => (focused.value?.exe || "").endsWith(program)) ||
      widgetStatuses.value.some(
        (w) => w.widgetId === "@seelen/apps-menu" && w.webviewWindowId === focused.value?.hwnd,
      ),
  );

  const dockIsCovered = $derived(topWindowIsFullscreen && !focusedIsAppsMenu);
  // Hide the whole webview, not just the dock strip, while a foreign capture or
  // transcription overlay intersects it. Otherwise hovering the transparent webview
  // area could reveal the dock over the overlay's controls.
  const obscuredByOverlay = $derived(
    overlayState.overlapsDock || overlayState.coversScreen,
  );

  const showWidget = $derived(!dockIsCovered && !obscuredByOverlay);
  const setWidgetVisibility = debounce((value: boolean) => {
    if (value) {
      Widget.self.show();
    } else {
      Widget.self.hide();
    }
  }, 100);

  $effect(() => {
    if (settingsState.isReady) {
      if (obscuredByOverlay) {
        setWidgetVisibility.cancel();
        Widget.self.hide({ animate: false }).catch(console.error);
      } else {
        setWidgetVisibility(showWidget);
      }
    }
    return () => setWidgetVisibility.cancel();
  });

  onMount(() => {
    Widget.self.ready({ show: false }).then(() => {
      settingsState.isReady = true;
    });
  });
</script>

<Dock />
