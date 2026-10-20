# Seelen performance and UX review

Baseline reviewed October 19, 2026, at `b877bb9f` on `ksg/dev`.

The best first investment is making frequently used menus stay ready and appear before optional data finishes loading.
There are concrete opportunities here without rewriting the UI, introducing a new framework, or building a large test
suite.

## Implementation status

Implemented on `ksg/performance-ux-review` using three Pi DeepSeek V4.1 Flash implementation workers with maximum
reasoning, followed by root integration and a focused review. The findings later in this document describe the original
baseline.

- **W1:** user, quick-settings, media, notification, tooltip, and dock-preview windows retain their initialized WebViews
  after hiding. They still start lazily. Context menus, settings, dialogs, and editors retain their expiry.
- **W2:** the user menu and quick settings mount before optional data resolves. Profile, folder, and quick-settings
  sections have guarded loading/error states and retry actions. Event subscriptions precede initial reads, and newer
  events win over older responses. Optional profile/device reads start after the shell becomes visible. Retained menus
  refresh profile and night-light information on reopening. Translation messages arriving after mount now refresh the
  displayed strings.
- **W3:** folders fetch their snapshot on first expansion and initially mount 24 rows, with another 24 per "Show more."
  File-preview initialization is deferred until there are files to display. Folder actions are separate
  keyboard-accessible buttons, and file rows describe their Explorer action.
- **W4:** settings snapshots and concurrent requests are shared within a WebView, with separate copies for consumers
  that edit settings. Cached reads expire after one second so a missed event cannot leave future reads stale
  indefinitely. Theme/color/performance/window preparation runs concurrently where independent. SVG fetches share
  completed and pending results; SVG-only controls avoid importing the file-icon manager.
- **W5:** pending captures are deduplicated per tracked window; changes during a capture request one follow-up. Capture
  generations prevent results from an old registration being applied after a handle is reused. Unchanged colors do not
  emit, and full preview/color broadcasts are coalesced over 80 ms.
- **O1:** initial folders scan independently and publish as they complete. Watchers start before the initial scan;
  changes seen during that scan request a follow-up. Unchanged bounded listings and irrelevant deep events do not
  generate redundant refreshes. `GetUserFolderContentState` adds explicit readiness while the older command and
  folder-change event remain compatible.
- **O3/O4/O5:** Wi-Fi intervals and app-list idle callbacks clean up correctly. Sliders retain local feedback, use
  separate throttles, flush final values, and reset when their device changes. Hidden media progress stops ticking; seek
  work cleans up with its component and unacknowledged seeks return to the last reported timeline. Saved favorites avoid
  the native pinned-layout import, including when the saved list is intentionally empty.
- **Popup UX:** simple popups support Escape, toolbar buttons support Enter/Space, and context menus support arrow,
  Home/End, and Escape navigation. Repeated toolbar clicks toggle simple popups. A newer toolbar popup replaces a queued
  older popup, and a queued popup is discarded if the foreground window changed before it became ready. Discarded cold
  opens still arm the normal lazy-window expiry. Popup-level handlers can consume Escape before the common dismissal
  behavior runs.

Source validation includes `cargo check --locked -p seelen-ui`, binding generation, the shared npm-library build,
`npm run type-check`, the production frontend build, scoped Deno lint, Rust formatting, and whitespace checks. The
binding-generation task runs the repository's existing export/tests; no handwritten test cases or test suite were added.
At source-review sign-off, installation, desktop restart, and hands-on validation had not yet been performed. The local
build manifest and installed-build tag record the source used for a subsequent installation.

**Still measurement-dependent:** forced memory-pressure cleanup (O2), debug-profile tuning, icon lookup indexes,
viewport-only icon extraction beyond the 24-row limit, preview delta events/prioritization, and moving brightness
hardware writes onto a coalescing worker. Initial prewarming and further resize coalescing are also deferred. These are
follow-ups if normal use still shows a specific delay; no latency improvement is claimed as measured.

## Scope and confidence

This is a source review of the user/name menu, shared widget lifecycle, toolbar actions, quick settings, network and
Bluetooth popups, app search, folder indexing, icons, window previews, and event delivery. I also inspected the existing
local runtime log and installed build manifest without changing the running app.

The installed manifest identifies clean source commit `06e9d61d`, with an embedded frontend and the Rust `dev` profile.
Its source tree matches the reviewed merge commit. The current log contained 13 pending-trigger messages for the user
menu and no liveness-watchdog failures. Those messages indicate triggers waiting for widget readiness; they are not
errors or timing measurements, and the log spans several application starts.

The mechanisms below are visible in the code. Their relative impact is an estimate until compared on this machine. No
click-to-display timings, CPU profile, or frame trace were collected. In particular, forced memory cleanup and
debug-build overhead are investigation candidates, not established causes of the reported menu lag.

## Why clicking the name can feel slow

The reviewed baseline path was:

1. The toolbar plugin calls `trigger("@seelen/user-menu")`.
2. If the widget is not ready, Rust stores the trigger and creates its WebView.
3. Before the entry point can mount the app, imported modules await settings, account information, seven folder
   snapshots, and the shared file-icon manager. Independent module branches can overlap, but every required branch must
   finish.
4. `widget.init()` then prepares window geometry, monitor information, themes, colors, and performance settings.
5. After mounting, `ready()` sizes the window and tells Rust it can deliver the pending trigger.
6. The popup trigger handler positions, shows, focuses, and checks the size again.
7. After hiding, the lazy widget closes its window after 30 seconds. A later click repeats this startup path.

Relevant code: [toolbar plugin](../src/static/widgets/user/toolbar-plugin.yml),
[trigger dispatch](../src/background/widgets/mod.rs), [user entry point](../src/ui/svelte/user-menu/index.ts),
[account state](../src/ui/svelte/user-menu/state/mod.svelte.ts),
[folder state](../src/ui/svelte/user-menu/state/knownFolders.svelte.ts),
[icon initialization](../libs/ui/svelte/components/Icon/common.svelte.ts),
[widget lifecycle](../libs/core/src/state/widget/mod.ts), and
[window lifetime](../libs/core/src/state/widget/abstractions/4_visibility.ts).

Importantly, the folder requests already return empty snapshots while initial indexing runs in the background. They do
not synchronously walk all the folders on every click. The remaining issue is unnecessary startup gates, repeated
WebView creation, and how much work happens when data arrives.

## Biggest wins

### W1. Keep the most frequently used popups warm

**Priority: first. Expected benefit: high for repeat openings. Effort: small.**

The user menu is `lazy: true`. `Widget.init()` defaults `closeOnHide` to that flag, and the visibility layer closes a
hidden window after `30_000` ms. The same pattern applies to quick settings, media, notifications, tooltips, and dock
previews. A menu can feel quick when reopened immediately and slow again after a short pause.

Start by passing the existing `closeOnHide: false` option for the user menu and a small set of frequently used widgets.
This preserves lazy first creation while retaining the initialized window after its first use. The first opening still
needs W2 and W4. If that first opening remains noticeable, selectively create the user menu in the background after
desktop startup, without sending a show trigger.

Keep the current expiry for settings, editors, dialogs, and dynamically instantiated context menus. Keeping every
context-menu instance alive would accumulate windows. Warm menus also retain subscriptions and timers, so fix O3 and
pause unnecessary hidden work before extending this to more widgets.

The tradeoff is retained WebView memory. Compare the whole Seelen/WebView process group after normal use, rather than
judging this by the main executable's memory alone.

Evidence: [user metadata](../src/static/widgets/user/metadata.yml), `Widget.init()` in
[mod.ts](../libs/core/src/state/widget/mod.ts), and `debouncedClose` in
[4_visibility.ts](../libs/core/src/state/widget/abstractions/4_visibility.ts).

### W2. Show the menu shell before optional content is ready

**Priority: first. Expected benefit: high for cold openings and slow devices. Effort: medium.**

The user menu awaits all seven folder snapshots before mounting, although every folder starts collapsed. Even the
file-icon manager initializes through static imports before a file row is needed. Quick settings similarly waits for
audio devices, radios, hotspot information, monitors, dark mode, and night light as one startup gate. A slow or rejected
request can delay or prevent the whole imported app from mounting.

Render the themed shell and available controls first. Load folder content when a category is first expanded, and load
quick-settings sections independently. Keep each section's state simple: loading, ready, or failed. Show a small retry
action only for the affected section. Do not represent "still indexing" as "this folder is empty."

Do not merely remove the awaits: `LazyRune.value` deliberately throws before initialization. Use guarded reads or an
explicit initial state, retaining the helper's protection against stale initial fetches overwriting newer events. Await
the relevant event-subscription acknowledgement before fetching its initial snapshot. Current callers often start
`subscribe(...)` without awaiting it, although the event API explicitly uses that promise to signal readiness. A fast
initial background update can otherwise arrive before the server subscription is active.

Evidence: [user folder state](../src/ui/svelte/user-menu/state/knownFolders.svelte.ts),
[quick-settings state](../src/ui/svelte/quick-settings/state.svelte.ts),
[LazyRune](../libs/ui/svelte/utils/LazyRune.svelte.ts), [subscribe contract](../libs/core/src/handlers/mod.ts), and
[folder snapshot handler](../src/background/modules/user/indexing/infrastructure.rs).

### W3. Bound the work done when expanding a folder

**Priority: first, alongside W2. Expected benefit: high for populated folders. Effort: small to medium.**

The backend already caps each folder at 300 files, but `UserFolder` mounts every returned row at once. `FileIcon`
requests icon extraction when each row mounts. Its `lazy` prop only becomes the image's `loading="lazy"` attribute; it
does not defer the IPC request or shell-icon work.

Initially show a modest number of recent files, such as 20 to 30, with a "Show more" action. Request missing icons only
for rows that are about to become visible. Keep a stable placeholder size so icons appearing do not move the labels or
change the popup's dimensions. This is simpler than introducing a general virtualization framework.

The icon lookup path also repeatedly scans icon-pack entry arrays with `.find()`. If large icon packs remain costly
after bounding the rows, build lookup maps once per pack revision, preserving pack precedence, redirects, filename
fallbacks, and extension matching.

Evidence: [UserFolder](../src/ui/svelte/user-menu/components/UserFolder.svelte),
[FilePreview](../src/ui/svelte/user-menu/components/FilePreview.svelte),
[FileIcon](../libs/ui/svelte/components/Icon/FileIcon.svelte),
[image renderer](../libs/ui/svelte/components/Icon/SluIconRenderer.svelte), and
[`IconPackManager.getIconEntry()`](../libs/core/src/state/icon_pack.ts).

### W4. Remove duplicate and serial startup requests

**Priority: second. Expected benefit: broad improvement to cold widget starts. Effort: small to medium.**

`startThemingTool()` fetches settings, then themes, then colors, with awaited listener registration in between. The
widget's own state and `IconPackManager.create()` also fetch settings. `Settings.getAsync()` currently invokes Rust each
time; it does not share an in-flight snapshot. Quick settings additionally obtains monitor data in both its state and
the common widget initialization path.

Fetch independent startup snapshots concurrently. Within each WebView, share the current settings snapshot and in-flight
request between consumers, updating it from the existing settings event. Apply the same approach to monitor data where
it removes actual duplication. This needs a small shared helper, not another state framework.

Preserve subscription ordering and prevent an older initial response from replacing a newer event. Apply the active
theme before showing the window to avoid a flash of the wrong surface or accent.

The common popup path also performs a corrective autosize after showing. That correction exists for a documented
geometry race. Coalesce redundant resize requests if profiling shows churn, but preserve the correction and mixed-DPI
monitor behavior.

Evidence: [theming](../libs/core/src/state/theme/theming.ts), [settings access](../libs/core/src/state/settings/mod.ts),
[icon-manager creation](../libs/core/src/state/icon_pack.ts),
[widget initialization and popup preset](../libs/core/src/state/widget/mod.ts), and
[autosizer](../libs/core/src/state/widget/abstractions/3_autosize.ts).

### W5. Reduce window-preview work and full thumbnail broadcasts

**Priority: second, particularly for dock/workspace use. Expected benefit: medium to high during window activity.
Effort: medium.**

Every changed captured window causes the infrastructure layer to clone and broadcast the complete preview map, including
all cached base64 thumbnails. Color updates similarly broadcast the entire color map, and colors are emitted after every
successful capture even when they did not change.

Captures already run on a dedicated thread, use per-window debouncing, skip unchanged image encoding, and downscale
stored previews to 640 pixels. Preserve those improvements. The remaining capture queue is unbounded and does not
deduplicate HWNDs already waiting; slower captures can leave stale work ahead of the window currently being hovered.

Start by keeping at most one pending capture per window, comparing colors before emitting, and coalescing snapshot
broadcasts over a short interval. If payload copying is still material, add a changed-window event while retaining the
full snapshot command for initial loading. Update the shared command/event declarations and generated bindings only if
changing that contract.

Prefer recently requested previews when there is a backlog. Keep enough background capture for task switching and
workspace views; capturing only while the dock is visible would break other consumers' expectations.

Evidence: [capture manager](../src/background/modules/apps/application/previews.rs),
[preview event bridge](../src/background/modules/apps/infrastructure.rs), and
[dock preview state](../src/ui/svelte/weg-preview/state.svelte.ts).

## Additional optimization wins

### O1. Avoid folder rescans and refreshes that cannot change the visible result

**Expected benefit: medium on active developer/download folders. Effort: medium.**

The indexing fixes already bound traversal to 20,000 entries, cap output at 300, prune noisy directories, and scan
outside the manager lock. However, recursive watchers can report changes deeper than the three-level listing, and each
accepted batch rescans and emits a replacement list even when the final list is unchanged.

Compare the new bounded result with the cached one before sending `FolderChanged`. Filter watcher events that cannot
affect the supported listing depth, handling directory and rename events conservatively. Publish initial results per
folder as they become ready instead of withholding every folder until the entire manager is constructed. The latter is
useful when one known folder is slow or unavailable.

Keep the existing background worker and caps. Incremental filesystem indexing, a database, and an elaborate cache are
unnecessary unless this simpler approach still shows a problem.

Evidence:
[`get_folder_content`, `reload_folder_content`, and initialization](../src/background/modules/user/indexing/application.rs).

### O2. Check whether forced memory cleanup causes periodic hitches

**Status: profiling candidate. Potential benefit: medium. Effort: small for a comparison.**

Every created widget schedules a critical `Memory.simulatePressureNotification` every 30 seconds. It skips focused
windows, but visible toolbar, dock, tooltip, and preview windows can be unfocused. This does not distinguish a hidden
idle popup from a surface the user is actively interacting with.

Compare the current policy with cleanup restricted to genuinely hidden, idle widgets at a longer interval. Check both
responsiveness and memory over an ordinary session. The cleanup was introduced to address memory growth, so removing it
globally without that comparison would be premature. Do not change security or browser-isolation flags as a performance
shortcut.

Evidence: [`MEMORY_PRESSURE_INTERVAL`](../src/background/widgets/loader.rs) and
[`simulate_memory_pressure()`](../src/background/widgets/webview.rs).

### O3. Fix two small scheduling problems

**Expected benefit: more predictable background work and search rendering. Effort: small.**

In the network popup, the scanning effect creates a new interval whenever it reruns while scanning remains enabled. It
does not return an effect cleanup function. If the radio list changes while the popup is focused, the old timer can be
orphaned when its handle is overwritten. Return cleanup for each interval and allow only one scan cycle at a time. This
matters more if the popup is kept warm.

In `AllAppsView`, progressive rendering schedules `requestIdleCallback(process)` without canceling it when results
change or the component unmounts. Pending callbacks read the latest search results using their older chunk counter.
Rapid query changes can therefore leave several rendering loops competing. Cancel the pending callback during effect
cleanup, or reject an obsolete render generation. The existing search index is already reused between ordinary
keystrokes; rebuilding search architecture is not the first fix.

Evidence: [network scan effect](../src/ui/svelte/network-popup/state.svelte.ts) and
[progressive app rendering](../src/ui/svelte/apps-menu/components/AllAppsView.svelte).

### O4. Make slider feedback local and send only useful hardware writes

**Expected benefit: medium for volume and brightness interaction. Effort: small to medium.**

Quick-settings volume percentages and brightness values come from backend snapshots while writes are throttled. The
media volume control has a local value, but its synchronization effect can replace that value while a drag is still in
progress. Media seeking already has an explicit `isSeeking` pattern worth reusing.

Track the value locally during a drag. Ignore older external echoes until the interaction finishes, flush the final
value on release, and resynchronize or show a small error if the command fails. Use separate throttles per device or
monitor; current quick-settings components share one throttle across multiple controls.

Brightness writes synchronously perform WMI/DDC operations and share the DDC lock with background polling. If hardware
calls visibly trail the pointer, put writes on the existing worker and retain only the newest requested value per
monitor. Preserve serialized DDC transactions and final-value correctness.

Evidence: [quick-settings volume](../src/ui/svelte/quick-settings/components/MediaDevices.svelte),
[brightness control](../src/ui/svelte/quick-settings/components/BrightnessControl.svelte),
[media volume](../src/ui/svelte/media-popup/components/VolumeControl.svelte),
[seek interaction](../src/ui/svelte/media-popup/components/MediaProgress.svelte), and
[brightness manager](../src/background/modules/monitors/brightness/application.rs).

### O5. Take the inexpensive repeated-work reductions

**Expected benefit: small individually. Effort: small.**

- Cache both completed and in-flight SVG fetches. `InlineSVG` fetches on each component instance even when the shared
  SVG dictionary already contains that source. Keep failed requests retryable.
- Read saved app-menu favorites before obtaining the native Windows pinned layout. The current startup obtains and
  converts that layout before loading `favorites.json`, even when saved favorites will replace the result. Import native
  pins only when no valid saved favorites exist, preserving an intentionally empty favorites list.
- Pause media progress timers while their popup is hidden. The current timer runs while the session is playing,
  including while a retained popup is hidden. Recompute from the saved timestamp when shown again.

Evidence: [SVG component](../libs/ui/svelte/components/Icon/InlineSVG.svelte),
[SVG fetch helper](../libs/ui/svelte/components/Icon/InlineSVGState.svelte.ts),
[favorites initialization](../src/ui/svelte/apps-menu/state/mod.svelte.ts),
[persistent state helper](../libs/ui/svelte/utils/PersistentRune.svelte.ts), and
[media progress](../src/ui/svelte/media-popup/components/MediaProgress.svelte).

## UX improvements that make the application feel more reliable

These can use existing theme tokens and `data-skin` controls. They do not require a visual redesign.

- **Make opening and dismissal consistent.** Add Escape dismissal to simple popups and context menus. Make a second
  click on the same toolbar trigger close its open popup. Preserve focus behavior for submenu chains and the
  deliberately unfocused dock preview. The shared popup preset currently shows/focuses on every trigger, without toggle
  semantics.
- **Make keyboard interaction work where it already appears available.** Toolbar items expose `role="button"` and
  `tabindex="0"` but have an empty `onkeypress` handler. Support Enter/Space activation, focus the first appropriate
  menu control, and add arrow navigation for context menus. Keep the existing focus outlines.
- **Clarify folder actions.** The folder row opens Explorer, while only its small chevron expands the file list. Give
  the expansion button an accessible label and `aria-expanded`, and use separate sibling controls instead of a button
  nested in a `role="button"` row. Prevent keyboard activation from bubbling into the parent action. Label file-row
  behavior clearly: it currently selects the file in Explorer rather than opening the file itself.
- **Acknowledge delayed actions and honor the latest intent.** If opening remains slow, provide a restrained pending
  state on the clicked toolbar item. Discard a cold popup's pending open if the user has since chosen another action, so
  it does not appear later and take focus. Show localized, section-level failures instead of leaving only a console
  error. Preserve stable section dimensions while loading.

Evidence: [toolbar item handlers](../src/ui/svelte/fancy-toolbar/components/Item.svelte),
[popup preset](../libs/core/src/state/widget/mod.ts), [pending trigger storage](../src/background/widgets/mod.rs),
[context-menu components](../src/ui/svelte/context-menu/app.svelte),
[folder actions](../src/ui/svelte/user-menu/components/UserFolder.svelte), and
[file action](../src/ui/svelte/user-menu/components/FilePreview.svelte).

## Practical order of work

1. **Name-menu responsiveness:** W1 for the user menu, W2 for its initial shell, and W3 for folder expansion. Include
   clear loading/empty states and correct subscription ordering.
2. **Small behavior fixes:** O3, consistent Escape/keyboard activation, and local slider feedback from O4. These are
   focused changes with visible everyday value.
3. **Shared costs:** W4, W5, and unchanged-result suppression from O1. Expand warm retention selectively after checking
   hidden work and memory.
4. **Only where a comparison justifies it:** the memory-cleanup policy, indexed icon lookup, broader watcher filtering,
   and build-profile tuning.

For build-profile tuning, the installed Rust binary is unoptimized (`[profile.dev] opt-level = 0`), while the local
build script already requests production frontend bundles. After the behavioral fixes, compare a modestly optimized
local debug-derived profile for CPU-heavy capture, image, and indexing work. Treat that as a separate build-workflow
change, retain fast `cargo check` iteration, and avoid release builds for routine validation. It will not eliminate
WebView recreation or startup dependencies.

Evidence: [Cargo profiles](../Cargo.toml) and [local build script](../scripts/windows/build-local.ps1).

## Lightweight verification

Use a short hands-on comparison on this workstation. Observe the user menu on first open, an immediate reopen, and a
reopen after more than 30 seconds; expand a populated folder; type and clear an app query quickly; and drag a
volume/brightness slider. Check mixed-DPI placement and the memory trend after several minutes if changing widget
lifetime or cleanup. Temporary timing marks around trigger, mount, ready, and show can distinguish where any remaining
delay lives. Timing targets should be chosen after that baseline, not invented from source inspection.

No new automated test suite or benchmark infrastructure is needed for this plan. For implementation, use the existing
type-check/lint commands on touched code and `cargo check` when Rust changes. Build only when a hands-on comparison
needs a binary; installation and desktop restart remain separate, explicitly requested actions.

Preserve the useful optimizations already present: background bounded folder indexing, scanning outside locks, cached
search indexes, debounced/downscaled preview capture, websocket subscription routing and snapshot coalescing, and the
popup visibility/monitor-positioning race fixes. Avoid a framework migration, a global state rewrite, or a blanket
removal of animations and glass effects.
