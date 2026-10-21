# Desktop interface optimization

Source audit started October 20, 2026, from `5be9a3e5` on `ksg/dev`. This includes the previously installed
toolbar/popup performance work and both tiling recovery/resize fixes. The earlier review is in
[performance-ux-review.md](performance-ux-review.md).

## Repository reconciliation

- Merged `ksg/fix-tiling-resize` into `ksg/dev`, preserving its two commits, and pushed the merge to GitHub.
- Removed the completed `ksg/fix-tiling-resize` and `ksg/performance-ux-review` branches locally and remotely.
- Preserved the unique commits from three older dependency branches in `ksg/archive/20261020/dependency-slu-lib`,
  `ksg/archive/20261020/dependabot-serde-with`, and `ksg/archive/20261020/dependabot-sha2` tags on GitHub before
  removing those remote branches.
- Preserved `upstream`, `ksg/passthrough`, and the inherited `master` baseline. GitHub's default branch remains
  `ksg/dev`, and repository Actions remain disabled.

## Scope and method

Three initial T3 child tasks use Pi's `cpa/opencode-go/deepseek-v4.1-flash` with `thinking=max` for independent source
audits. Subsequent implementation and review tasks use the same selection. No child delegates further.

The audit covers shared widget creation, initialization, positioning, visibility, themes, settings, icons and events;
toolbar actions and every drawer/system popup; dock and previews; app launcher, task switching, tiling and workspaces;
wallpaper and icon management; settings and dialog interfaces; and native jobs that feed those interfaces.

The interaction goals are prompt shell presentation, consistent activation/dismissal, keyboard access, stable local
feedback, and respecting the user's latest action. Existing Windows integration, themes, accent tokens and reduced
motion behavior remain the design contract.

The expanded dock scope includes screen-space reservation and coexistence with ShareX capture/recording controls and the
Jot transcription overlay. Ordinary application placement and temporary overlay priority are separate requirements; a
capture tool must still be able to select the entire screen.

Findings below distinguish source-confirmed behavior from runtime hypotheses. No click-to-visible latency or
before/after frame-time improvement has been measured. Building source and running checks does not update the installed
desktop.

## Itemized changes

### N1. Move display operations off the UI thread

**Implemented; automated validation passed. Desktop acceptance remains pending.**

The synchronous monitor handlers initialize native display/WMI state and perform HDR or brightness hardware calls on the
command path. A slow monitor can therefore delay unrelated UI commands.

Monitor reads and HDR writes now use blocking workers through async generated commands. Brightness writes join the
existing display worker, which serializes scans, polling and writes. Queued requests for the same monitor retain the
latest value, while every caller receives the hardware result. Hotplug requests no longer discard queued writes. The
worker owns DDC transactions, avoiding a mutex held across hardware I/O.

Evidence: [monitor handlers](../src/background/modules/monitors/infrastructure.rs),
[brightness worker](../src/background/modules/monitors/brightness/application.rs), and
[command declarations](../libs/core/src/handlers/commands.rs).

### N2. Recover from tray image write failures

**Implemented; automated validation passed. Desktop acceptance remains pending.**

Saving a system tray icon used `unwrap()`. A failed temporary-file write could panic while updating the tray. It now
logs the failure and preserves the existing icon instead.

Evidence: [tray icon persistence](../src/background/modules/system_tray/application/tray_icon.rs).

### D1. Reserve persistent dock space through the complete Windows appbar contract

**Implemented; automated validation passed. Desktop acceptance remains pending.**

The dock reserves space only for `HideMode.Never` or touch input. Its default overlap mode deliberately reserves no
space. The native registration path previously omitted `ABM_QUERYPOS` and appbar callbacks. Dedicated hidden host
windows now negotiate with the shell, handle position/fullscreen/display/Explorer restart notifications, and unregister
on owner destruction. Identical approved rectangles skip `ABM_SETPOS`, preventing callback feedback loops. A message
queue exists before the host thread publishes its ID, so early registrations cannot lose their wakeup.

Registration returns errors and the approved rectangle through an async command. Position-change events keep the visible
toolbar and dock aligned with that rectangle, preserving the dock's larger rendering surface for raised icons.
Registration waits are bounded at three seconds so a stalled shell cannot hold the frontend queue indefinitely. Native
shell IPC still requires Explorer to recover. Owner destruction also unregisters outside session-filtered WinEvent
hooks. Frontend registration/unregistration is serialized; owner filtering, request keys and event revisions reject
stale updates. Fullscreen callbacks lower the actual visible owner and restore its previous topmost state through the
existing Windows stacking workaround. Existing hide-mode preferences are preserved.

macOS exposes a visible screen rectangle excluding the Dock and menu bar. Windows' corresponding appbar services
negotiate reserved desktop space; fullscreen applications require the bar to yield its stacking position. Sources:
[Apple visibleFrame](https://developer.apple.com/documentation/appkit/nsscreen/visibleframe),
[Microsoft appbar contract](https://learn.microsoft.com/en-us/windows/win32/shell/application-desktop-toolbars),
[position negotiation](https://learn.microsoft.com/en-us/windows/win32/shell/abm-querypos), and
[fullscreen precedence](https://learn.microsoft.com/en-us/windows/win32/shell/abn-fullscreenapp).

Evidence: [native appbar registration](../src/background/windows_api/app_bar.rs) and
[dock geometry](../src/ui/svelte/weg/state/settings.svelte.ts).

### D2. Let capture and transcription overlays take precedence

**Implemented; automated validation passed. Desktop acceptance remains pending.**

Overlap detection returns false when the foreground window is absent from the normal application list. That list
excludes tool windows and windows that do not activate. Fullscreen suppression also considers only normal tracked
application windows. Temporary capture and transcription overlays can therefore be missed, and edge activation or
attention can bring the dock back over them.

A read-only native window inspection found Jot's idle window marked topmost, tool-window and non-activating, with an
offscreen rectangle. This supports the filtering concern; it is not a reproduction of an active recording collision. The
fix must distinguish visible intersecting overlays from offscreen idle windows and Seelen's own previews/menus, work
across monitors, and restore the dock when the conflicting overlay disappears. It must not add tool windows to the
dock's application list or resize capture overlays.

The tracker publishes within a bounded 80 ms collection window, including during continuous movement. It excludes
own-process windows, shell chrome, minimized/cloaked/empty/offscreen windows, and background non-topmost tools. A
foreign tool/non-activating window takes precedence when topmost or in the foreground process. This remains a heuristic,
including for permanent third-party topmost utilities. The dock hides its native window immediately on an intersection,
bypassing ordinary hover, attention and apps-menu reveal. Previews yield to the same snapshot. The persistent work-area
reservation remains while temporarily hidden, avoiding maximized-window movement. No foreign window is moved or resized;
capture canvases retain their own coordinate system. Live ShareX/Jot verification remains required.

Evidence: [application filtering](../src/background/modules/apps/application/windows.rs),
[dock overlap](../src/ui/svelte/weg/state/windows.svelte.ts), [fullscreen suppression](../src/ui/svelte/weg/App.svelte),
and [hide/reveal policy](../src/ui/svelte/weg/state/hidden.svelte.ts).

### D3. Apply per-monitor dock and toolbar settings consistently

**Implemented; automated validation passed. Desktop acceptance remains pending.**

The dock and toolbar read only their global configuration. The tiling overlay checked per-monitor enabled flags but used
global sizes, edges and hide modes to reserve space. These now merge the monitor patch into the global config before
rendering and reserving space. A hidden toolbar no longer leaves an unnecessary gap above the dock.

The per-monitor dock modal previously omitted the dock-specific controls. It now displays those controls and writes
their changes to that monitor's patch. Resetting a monitor's widget settings resets only that monitor, preserving its
enabled state and all global settings.

Evidence: [dock settings](../src/ui/svelte/weg/state/settings.svelte.ts),
[toolbar settings](../src/ui/svelte/fancy-toolbar/state/settings.svelte.ts),
[tiling work area](../src/ui/svelte/window-manager/state.svelte.ts), and
[settings controls](../src/ui/react/settings/modules/resources/Widget/View.tsx).

### S1. Preserve pending settings changes and reduce initial request serialization

**Implemented; automated validation passed. Desktop acceptance remains pending.**

Four independent initial settings requests now run together. Monitor-default reconciliation creates a new settings
snapshot only when a monitor is missing, and extends the saved baseline with only those defaults. It no longer marks
unrelated edits as saved or mutates a signal's existing object in place. Saving updates the saved baseline after the
write succeeds, so a failed write leaves the edits marked unsaved. Save-and-restart proceeds only after a successful
settings/permissions save.

The audit also identified whole-tree JSON comparisons on settings edits. Further dirty-state optimization is
measurement-dependent; delaying the Save/Close state has a UX cost and is not required for these correctness fixes.

Evidence: [settings state](../src/ui/react/settings/state/mod.ts).

### S2. Remove optional font enumeration and serialized resource startup

**Implemented; automated validation passed. Desktop acceptance remains pending.**

The settings router statically imports the font selector; its top-level font enumeration therefore delayed the entire
settings application. Font loading now starts when a selector mounts, shares one request/cache, displays the existing
loading affordance and retries on reopen after a failure. Subscription revisions protect newer font events from an older
snapshot. Native DirectWrite enumeration uses a blocking worker through the generated async command.

The five independent resource reads, and the colors/monitors/autostart reads, now initialize concurrently after each
listener acknowledgement. Wallpaper sorting no longer mutates the shared snapshot. Application-rule filtering uses
memoized data instead of an artificial initial 300 ms timer; debounced search captures the text immediately and cancels
on unmount, avoiding a delayed read of an expired input event.

### T1. Coalesce tiling geometry work without discarding force-retile requests

**Implemented; automated validation passed. Desktop acceptance remains pending.**

The overlay previously measured every tile and issued a positioning command on every reactive run. Requests now keep the
latest inputs and measure the current DOM once per animation frame, with cancellation when paused, removed or unmounted.
Force-retile requests still reach the backend even when the resulting rectangles match earlier values. The stable-layout
comparison serializes each new tree once instead of serializing both the old and new tree.

Evidence: [tiling geometry](../src/ui/svelte/window-manager/layout/application.ts) and
[layout state](../src/ui/svelte/window-manager/layout/infra/Layout.svelte).

### E1. Preserve workspace rename intent

**Implemented; automated validation passed. Desktop acceptance remains pending.**

External workspace snapshots no longer replace text while its input is being edited. Escape cancels the edit without
closing the viewer; Enter commits it without activating the containing workspace. Space typed in the input or Enter on
another child control no longer activates the workspace tile.

Evidence: [workspace controls](../src/ui/svelte/workspaces-viewer/app/Workspace.svelte).

### E2. Reject stale icon-editor work and release image resources

**Implemented; automated validation passed. Desktop acceptance remains pending.**

Image loads now have cancellation and generation guards, including image decoding after a fetch. Temporary object URLs
are revoked on completion, replacement and teardown. Loading an original image no longer resets controls the user
changed while it was loading. A save/delete started for an earlier entry cannot hide a newer editor session or clear its
saving state.

Evidence: [icon editor](../src/ui/svelte/icon-editor/app.svelte).

### A1. Remove optional startup gates and debug indexing

**Implemented; automated validation passed. Desktop acceptance remains pending.**

App-menu folder reads now start after listener acknowledgement without delaying the app shell. Each folder becomes
searchable independently. The debug folder-counting idle loop and its `index.log` write are removed.

Task-switcher thumbnails load independently of initial readiness, and task cards mount only while the switcher is shown.
Hardware Alt polling runs only for release-to-confirm triggers, checks cancellation after each async read, and handles
failures.

`LazyRune.isInitialized()` now tracks a reactive initialization flag, so guarded optional reads actually update when
initialization completes. Its event-over-snapshot protection and retry behavior remain intact.

Evidence: [launcher folders](../src/ui/svelte/apps-menu/state/knownFolders.svelte.ts),
[task-switcher state](../src/ui/svelte/task-switcher/state/index.svelte.ts), and
[LazyRune](../libs/ui/svelte/utils/LazyRune.svelte.ts).

### A2. Make launcher keyboard, drag/drop and placement behavior consistent

**Implemented; automated validation passed. Desktop acceptance remains pending.**

Enter activates the selected item or the first item. Selection lookup handles literal Windows paths, and arrow
navigation tolerates fractional grid positions. Delayed folder activation is canceled on teardown; folder extraction
publishes one complete pinned-state update instead of multiple intermediate updates.

The app menu waits for the requested monitor placement before showing. Rapid triggers track requested visibility and
cancel obsolete pending opens, including a reopen while a prior hide is finishing.

Evidence: [keyboard navigation](../src/ui/svelte/apps-menu/keyboard-navigation.ts),
[folder drag/drop](../src/ui/svelte/apps-menu/components/FolderModal.svelte),
[placement](../src/ui/svelte/apps-menu/state/positioning.svelte.ts), and
[trigger handling](../src/ui/svelte/apps-menu/index.ts).

### D4. Cancel obsolete previews and make them yield to overlays

**Implemented; automated validation passed. Desktop acceptance remains pending.**

A canceled hover replaces a queued cold preview request. Preview preparation uses a generation guard across async steps,
checks the current pointer after opening, and stops on focus changes. Moving from the icon into an already visible
preview retains the normal crossing behavior. Z-order is established before showing, while corrective sizing is
preserved.

Optional thumbnail reads no longer gate preview readiness. The overlay snapshot suppresses previews when a foreign
overlay intersects the dock or preview, including requests that began before the overlay appeared. Existing hover delay
constants are preserved pending runtime timing evidence.

Evidence: [preview requests](../src/ui/svelte/weg/previewWidget.ts) and
[preview state](../src/ui/svelte/weg-preview/state.svelte.ts).

### L1. Reduce shared startup and background work

**Implemented; automated validation passed. Desktop acceptance remains pending.**

- Bootstrap fetches only the calling widget definition, preserving resource-change reload behavior.
- Resize observation starts after mount/readiness; explicit initial and corrective sizing remain. Pure moves skip the
  forced synchronous repaint; mixed-DPI placement behavior remains.
- Extraction-driven icon-pack broadcasts use a shared 150 ms leading/trailing throttle. Explicit user edits remain
  immediate and emissions occur after releasing the icon-pack lock.
- Critical memory-pressure simulation skips visible/focused widgets, locked sessions, game mode and shared-renderer
  optimization mode. Startup timers are spread by widget label, with global spacing and an in-flight lease that expires
  after a missing completion. Late completions cannot release a newer lease. Visibility is checked again when the UI
  callback runs. CDP completion uses a callback instead of a nested Windows message pump.
- Opening has no default opacity transition. Hiding retains the theme transition and reduced-motion support. Logical
  dismissal is immediate; serialized native operations preserve reopen/hide intent. Popup windows ignore cursor events
  during dismissal, and pending popup positioning cannot reopen an obsolete request.
- Radio/Bluetooth first enumeration, discovery start/stop, radio writes and hotspot reads/writes run on blocking workers
  through generated async commands. Radio access denial now returns an error, including a denied individual device state
  change.
- Already-foreground activation returns without another synthetic focus broadcast.

The requested Pi/DeepSeek/Max selection was used for all delegated tasks. Two lifecycle implementation attempts failed
with HTTP 400 because a thinking-mode continuation omitted required `reasoning_content`. Partial changes were preserved,
reviewed and completed by the root agent. No provider configuration or authentication was changed.

### R1. Complete drawer responsiveness and control behavior

**Implemented; automated validation passed. Desktop acceptance remains pending.**

Network, Bluetooth, calendar, keyboard and system-tray drawers stay warm after first use. Their optional data no longer
blocks mounting; failures show localized loading/error/retry sections. Reads run concurrently after subscription
acknowledgement, and revisions protect newer events from old responses. Media and notifications follow the same model.
No blanket prewarming is added; the first use still creates lazy windows.

Network scanning awaits its result subscription, coalesces in-flight scans, distinguishes startup/failure/empty states,
and stops its interval/deadline when hidden or unfocused. Bluetooth serializes start/stop intent and stops discovery on
hide/focus loss; the no-results scanning indicator has a bounded discovery window. Selecting an expanded network or
device collapses it, while child controls keep their normal behavior.

The power menu accepts focus, handles toggle/rapid triggers and waits for essential monitor placement. Keyboard layout
selection closes only after Windows accepts the change. Radio/hotspot/layout controls disable during writes, show
localized failures, and resync after rejection. The native radio handler reports access denial. Quick-settings controls
and notification DnD use the same pending/error/recovery policy.

Tray events no longer cancel active reordering. Drop merges new/removed icons from the deferred live list, retains the
requested order until confirmed, and falls back after failure or a bounded confirmation wait. A hidden or destroyed tray
cancels its active drag.

Retained notification/user-menu scroll resets on show; notification relative timestamps refresh on show and through a
visible-only clock. Calendar refreshes today on show/midnight without a hidden timer. Media artwork samples a 32px
canvas only while visible, rejecting obsolete decodes. Flyouts use the shared slider with local settle,
keyboard/release/blur/ cancel handling, final write flushing and caught failures. Their hide timer is owned and canceled
on configuration change or teardown. Tooltips render/measure new text before positioning and reject obsolete triggers;
the existing 400 ms intent delay remains unchanged.

The drawer worker also failed with the same Pi `reasoning_content` HTTP 400. Its partial edits were reviewed and
completed by the root. The separate popup-controls worker and independent integration review completed successfully. New
translation keys were added manually in English; existing locale fallback applies until the translation workflow.

### B1. Bound wallpaper background work and guard obsolete accent extraction

**Implemented; automated validation passed. Desktop acceptance remains pending.**

The wallpaper widget now uses the existing native rasterization-scale lock instead of an endless 500 ms zoom polling
loop. Accent extraction depends on the resolved primary-monitor source and enabled flag, so unrelated settings snapshots
do not rerun it. Cleanup prevents an older image result from setting the accent after the source or preference changes.
The configured user accent behavior remains the same. Wallpaper thumbnail generation bounds its canvas to 512px,
registers seek listeners before seeking, handles sub-second videos, and times out stalled media stages so the settings
progress dialog can finish. The dock no longer generates a stack trace on every saved reorder. Empty context menus no
longer perform modulo-by-zero keyboard navigation.

### Coverage and remaining measurement work

The three audits traced shared widget/native lifecycle; toolbar and all system drawers; dock/preview; launcher, task
switcher, tiling and workspaces; wallpaper/icon management; settings and dialogs. The root integration review includes
native callbacks, stale-result ordering, monitor geometry and concurrent settings changes. Translation catalogs were not
reviewed line by line. This is a source audit, not a claim that every interaction was exercised on the installed Windows
desktop.

Further icon-lookup indexes, preview delta protocols, settings dirty-state debouncing, launcher virtualization,
build-profile tuning and numeric hover/reveal-delay changes remain measurement-dependent. Existing keyboard access to
non-focusable desktop bars needs a deliberate shell shortcut/focus policy; making bars steal focus on every click would
regress normal application use. No such activation redesign is introduced here. Shared essential monitor/theme startup
failures still abort widget initialization; individual drawer data failures are handled separately by R1. Additional
runtime profiling and an error boundary for catastrophic shared startup are follow-up work.

## Validation

Before repository reconciliation, `cargo check --locked -p seelen-ui` and the repository's pre-push Rust tests passed.
After N1, `cargo check --locked -p seelen-ui` passed. Core binding tests passed and bindings were regenerated. The three
brightness tests passed, including a multi-monitor slider burst with hotplug and hardware-error acknowledgements. The
first complete `npm run type-check` after D3 and T1 passed with zero Svelte errors or warnings. It passed again after
S1, E1 and E2. An isolated harness executing the actual settings-state module with mocked IPC verified concurrent
initialization, preservation of edits during monitor additions, cancellation with retained monitor defaults,
failed-write dirtiness and success/failure return values.

Isolated harnesses using the compiled production state modules also verified reactive optional-data readiness,
event-over-snapshot ordering, failed-initialization retry, literal Windows-path selection and fractional-grid
navigation. Preview checks covered cold-open cancellation, pointer crossing, idle pointer exit, overlay/focus
cancellation and z-order-before-show. These use mocked native boundaries, not live desktop reproduction.

Additional isolated checks execute the actual visibility, appbar, optional-section, action and tray modules. They cover
native hide/show ordering, logical dismissal during animation, event-over-reply appbar state, serialized unregister,
subscription-before-read, retry after rejected reads, duplicate action rejection/recovery, and tray drag reconciliation.
A thumbnail harness covers immediate seek completion, sub-second bounds and 8K-to-512px sampling. These are mocked
native boundaries, not installed desktop measurements.

Final integrated validation passed:

- `cargo check --locked -p seelen-ui` and `cargo clippy --locked --all-targets -- -D warnings`.
- `cargo test --locked`: 102 main-application tests, 13 core tests, one IPC test and six utility tests passed.
- Core generation tests: 84 passed; Rust/TypeScript bindings and the local npm library regenerated successfully.
- `npm run type-check`: TypeScript, core Deno checks and Svelte checks passed with zero errors/warnings.
- `deno fmt --check`, `cargo fmt -- --check`, `deno lint` and `git diff --check`.
- `npm run build:ui -- --production`: both React apps, all 22 Svelte apps and all three vanilla apps built successfully.
- Nine isolated actual-module/harness checks described above passed. Their native boundaries are mocked.

Source is prepared on `ksg/interface-optimization` for a draft PR against `ksg/dev`. The baseline reconciliation was
already pushed. No release was published, no application was installed, and no desktop/session was restarted. Repository
Actions remain disabled. The draft status reflects pending installed-desktop acceptance, not failed automated checks.

## Desktop verification

After a separately authorized installation, compare first open, immediate reopen and reopen after at least a minute for
the user drawer, quick settings, notification center, network, Bluetooth, calendar and media popup. Exercise rapid
switching between toolbar items, repeated clicks, Escape and keyboard navigation. Check both monitors and mixed DPI,
light/dark themes, a different Windows accent, and reduced motion.

For the dock, check crossing icons quickly, leaving before a preview is ready, moving between dock and preview, clicking
active/minimized/grouped windows, and keyboard activation. For brightness, drag both monitors' controls, verify the
final hardware values, disconnect a display during queued work, and confirm unrelated menus remain usable. Check
maximized windows with a persistent dock on each edge, auto-hide restoration, display reconnect, and Explorer restart.
Exercise ShareX region capture, recording controls and Jot's recording overlay, including when the pointer reaches the
dock edge. The capture canvas must retain full monitor/virtual-desktop coordinates and controls must remain clickable.
Cancelling or finishing the overlay must restore the dock without changing the user's hide-mode setting.

## Follow-up: transient terminals and dictation stacking

On October 21, runtime logs confirmed windows repeatedly entering and leaving tiling within the same second. New console
and Windows Terminal windows now wait 750 ms before automatic tiling. Focus, title, geometry and desktop events share
one deadline; closing/hiding a window cancels admission, and stale callbacks cannot admit a reused handle. Persistent
terminals still tile after that interval. Ordinary applications and explicit placement commands keep their existing
behavior. This prevents layout churn from brief command windows; suppressing their initial native flash requires the
launching application to create background processes without a console.

The positioning service's full-screen thumbnail canvases are now excluded from foreign-overlay detection. Their z-order
placement also stays in the source window's normal/topmost group, avoiding accidental promotion of ordinary window
animations into the group used by dictation and capture tools.

The saved dock setting on the inspected desktop was `OnOverlap`, which intentionally reserves no work area. Choose
**Dock > Auto Hide > Never** to enable persistent dock space. Temporary intersecting capture/dictation overlays still
hide the dock without releasing that reservation, and it returns after the overlay disappears. This means capture
controls can take priority without tiling ordinary windows over the persistent dock area.

The separate Jot Windows source was also updated to reconcile its presenter preference with the actual native topmost
style on startup/reveal and during its existing visibility check. A read-only inspection found the parked HUD lacked
that flag; active dictation reproduction and verification remain pending. The repair preserves the paste target's focus.

Validation: Rust checking and Clippy passed; 11 window-manager tests, two positioning tests and six overlay tests
passed. A native probe using hidden disposable windows reproduced promotion into the topmost group when inserting after
a topmost predecessor. Jot's Windows debug build passed with zero warnings/errors, using an isolated output directory.
No installation or desktop restart was performed. The GUI tool rejected live dock configuration with
`capability manifest idle timeout exceeded`, so the saved setting remains unchanged.
