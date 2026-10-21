<script lang="ts">
  import { convertFileSrc } from "@tauri-apps/api/core";
  import { invoke, SeelenCommand, Widget } from "@seelen-ui/lib";
  import { t } from "./i18n";
  import { editorState, resetState } from "./state.svelte";
  import CanvasRenderer from "./CanvasRenderer.svelte";
  import { onDestroy } from "svelte";

  const CANVAS_SIZE = 512;

  let bgCanvas = $state<HTMLCanvasElement>();
  let imageCanvas = $state<HTMLCanvasElement>();
  let drawCanvas = $state<HTMLCanvasElement>();
  let fileInput: HTMLInputElement;

  $effect(() => {
    Widget.self.ready();
  });

  let imageRequest = 0;
  let imageController: AbortController | null = null;
  let pendingImage: { image: HTMLImageElement; url: string } | null = null;

  function cancelImageLoad() {
    imageRequest++;
    imageController?.abort();
    imageController = null;
    if (pendingImage) {
      pendingImage.image.onload = null;
      pendingImage.image.onerror = null;
      pendingImage.image.src = "";
      URL.revokeObjectURL(pendingImage.url);
      pendingImage = null;
    }
  }

  function loadImageBlob(blob: Blob, request: number) {
    if (request !== imageRequest) return;
    const url = URL.createObjectURL(blob);
    const img = new Image();
    pendingImage = { image: img, url };
    const release = () => {
      img.onload = null;
      img.onerror = null;
      URL.revokeObjectURL(url);
      if (pendingImage?.image === img) pendingImage = null;
    };
    img.onload = () => {
      release();
      if (request === imageRequest) editorState.overlayImage = img;
    };
    img.onerror = () => {
      release();
      if (request === imageRequest) console.error("Failed to decode icon image");
    };
    img.src = url;
  }
  onDestroy(cancelImageLoad);

  async function loadOriginalImage(path: string) {
    cancelImageLoad();
    const request = imageRequest;
    const controller = new AbortController();
    imageController = controller;
    try {
      const response = await fetch(convertFileSrc(path), { signal: controller.signal });
      if (!response.ok) throw new Error(`Failed to load icon image: ${response.status}`);
      loadImageBlob(await response.blob(), request);
    } catch (error) {
      if (!controller.signal.aborted && request === imageRequest) console.error(error);
    } finally {
      if (imageController === controller) imageController = null;
    }
  }

  function clearDraw() {
    if (!drawCanvas) return;
    drawCanvas.getContext("2d")!.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  }

  $effect(() => {
    editorState.entry;
    clearDraw();
  });

  function handleReset() {
    cancelImageLoad();
    resetState();
    clearDraw();
    const entry = editorState.entry;
    if (!entry?.icon) return;
    const path = entry.icon.base ?? entry.icon.light ?? entry.icon.dark;
    if (!path) return;
    loadOriginalImage(path);
  }

  $effect(() => {
    const entry = editorState.entry;
    cancelImageLoad();
    if (!entry) return;
    const icon = entry.icon;
    if (!icon) return;
    const path = icon.base ?? icon.light ?? icon.dark;
    if (!path) return;
    // Fetch as blob to avoid tainting the canvas with the asset:// cross-origin URL
    loadOriginalImage(path);
    return cancelImageLoad;
  });

  function onFileChange(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    cancelImageLoad();
    resetState();
    loadImageBlob(file, imageRequest);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (!file || !file.type.startsWith("image/")) return;
    cancelImageLoad();
    resetState();
    loadImageBlob(file, imageRequest);
  }

  async function deleteCustomIcon() {
    const entry = editorState.entry;
    if (!entry || editorState.saving) return;
    editorState.saving = true;
    try {
      await invoke(SeelenCommand.DeleteUserCustomAppIcon, { entry });
      if (editorState.entry === entry) Widget.getCurrent().hide();
    } finally {
      if (editorState.entry === entry) editorState.saving = false;
    }
  }

  async function save() {
    const entry = editorState.entry;
    if (!bgCanvas || !imageCanvas || !drawCanvas || !entry || editorState.saving)
      return;
    editorState.saving = true;
    try {
      const temp = document.createElement("canvas");
      temp.width = CANVAS_SIZE;
      temp.height = CANVAS_SIZE;
      const ctx = temp.getContext("2d")!;
      ctx.drawImage(bgCanvas, 0, 0);
      ctx.drawImage(imageCanvas, 0, 0);
      ctx.drawImage(drawCanvas, 0, 0);

      const dataUrl = temp.toDataURL("image/png");
      const iconBase64 = dataUrl.split(",")[1]!;

      await invoke(SeelenCommand.RegisterUserCustomAppIcon, {
        iconBase64,
        entry,
      });

      if (editorState.entry === entry) Widget.getCurrent().hide();
    } finally {
      if (editorState.entry === entry) editorState.saving = false;
    }
  }
</script>

<div class="icon-editor">
  <div class="editor-main">
    <div class="canvas-column">
      <CanvasRenderer bind:bgCanvas bind:imageCanvas bind:drawCanvas ondrop={onDrop} />

      <div class="draw-toolbar">
        <button
          data-skin="default"
          class:draw-active={editorState.drawMode}
          onclick={() => (editorState.drawMode = !editorState.drawMode)}
        >
          {editorState.drawMode ? $t("draw_mode_on") : $t("draw_mode_off")}
        </button>

        {#if editorState.drawMode}
          <input
            data-skin="default"
            type="color"
            bind:value={editorState.drawColor}
            title={$t("draw_color")}
          />

          <label class="brush-label">
            <span class="section-label">{$t("brush_size")}: {editorState.brushSize}px</span>
            <input
              data-skin="flat"
              type="range"
              min="1"
              max="50"
              bind:value={editorState.brushSize}
            />
          </label>

          <button data-skin="default" onclick={clearDraw}>
            {$t("clear_draw")}
          </button>
        {/if}
      </div>
    </div>

    <div class="controls">
      <section class="control-section">
        <button data-skin="default" onclick={() => fileInput.click()}>
          {$t("pick_image")}
        </button>
        <input
          bind:this={fileInput}
          type="file"
          accept="image/*"
          style="display:none"
          onchange={onFileChange}
        />
      </section>

      {#if editorState.overlayImage}
        <section class="control-section">
          <label for="range-x" class="section-label"
            >{$t("position_x")}: {Math.round(editorState.overlayX)}</label
          >
          <input
            id="range-x"
            data-skin="flat"
            type="range"
            min={-CANVAS_SIZE}
            max={CANVAS_SIZE}
            bind:value={editorState.overlayX}
          />

          <label for="range-y" class="section-label"
            >{$t("position_y")}: {Math.round(editorState.overlayY)}</label
          >
          <input
            id="range-y"
            data-skin="flat"
            type="range"
            min={-CANVAS_SIZE}
            max={CANVAS_SIZE}
            bind:value={editorState.overlayY}
          />

          <label for="range-scale" class="section-label"
            >{$t("scale")}: {editorState.overlayScale.toFixed(2)}</label
          >
          <input
            id="range-scale"
            data-skin="flat"
            type="range"
            min="0.1"
            max="4"
            step="0.01"
            bind:value={editorState.overlayScale}
          />
        </section>
      {/if}

      <section class="control-section">
        <span class="section-label">{$t("background")}</span>
        <div class="radio-group">
          <label>
            <input data-skin="default" type="radio" bind:group={editorState.bgType} value="none" />
            {$t("none")}
          </label>
          <label>
            <input data-skin="default" type="radio" bind:group={editorState.bgType} value="solid" />
            {$t("solid")}
          </label>
          <label>
            <input
              data-skin="default"
              type="radio"
              bind:group={editorState.bgType}
              value="gradient"
            />
            {$t("gradient")}
          </label>
        </div>
        {#if editorState.bgType === "solid"}
          <input data-skin="default" type="color" bind:value={editorState.bgColor} />
        {:else if editorState.bgType === "gradient"}
          <div class="gradient-controls">
            <input data-skin="default" type="color" bind:value={editorState.bgGradientStart} />
            <input data-skin="default" type="color" bind:value={editorState.bgGradientEnd} />

            <label>
              <span class="section-label">{$t("angle")}: {editorState.bgGradientAngle}°</span>
              <input
                data-skin="flat"
                type="range"
                min="0"
                max="360"
                bind:value={editorState.bgGradientAngle}
              />
            </label>
          </div>
        {/if}
      </section>

      <section class="control-section">
        <label class="checkbox-label">
          <input
            data-skin="default"
            type="checkbox"
            bind:checked={editorState.isApproximatelySquare}
          />
          {$t("approximately_square")}
        </label>
      </section>
    </div>
  </div>

  <div class="action-buttons">
    <button
      data-skin="default"
      onclick={deleteCustomIcon}
      disabled={!editorState.entry || editorState.saving}
    >
      {$t("delete")}
    </button>
    <button data-skin="default" onclick={handleReset}>{$t("reset")}</button>
    <button data-skin="solid" onclick={save} disabled={!editorState.entry || editorState.saving}>
      {editorState.saving ? $t("saving") : $t("save")}
    </button>
  </div>
</div>

<style>
  :global(body) {
    overflow: hidden;
    background: var(--slu-std-bg-color);
  }

  .icon-editor {
    width: 100vw;
    height: 100vh;

    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: var(--spacing-m);
    padding: var(--spacing-m);

    overflow: hidden;
  }

  .editor-main {
    display: flex;
    flex-wrap: wrap;
    gap: var(--spacing-m);
    flex: 1;
    min-height: 0;
    align-items: flex-start;
    overflow: auto;
  }

  .canvas-column {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-s);
    flex-shrink: 0;
  }

  .draw-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--spacing-s);
    width: 256px;
  }

  .brush-label {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-2xs);
    flex: 1;
    min-width: 100px;
  }

  .draw-active {
    outline: 2px solid var(--system-accent-color);
  }

  .controls {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-s);
    flex: 1;
    min-width: 200px;
    min-height: 0;
    align-self: stretch;
    overflow: auto;
  }

  .control-section {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-xs);
  }

  .section-label {
    font-size: 0.75rem;
    opacity: 0.7;
  }

  .radio-group {
    display: flex;
    flex-wrap: wrap;
    gap: var(--spacing-m);
    font-size: 0.85rem;
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: var(--spacing-xs);
    font-size: 0.85rem;
    cursor: pointer;
  }

  .gradient-controls {
    display: flex;
    align-items: center;
    gap: var(--spacing-s);
    flex-wrap: wrap;
  }

  .action-buttons {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: flex-end;
    gap: var(--spacing-s);
  }
</style>
