use std::path::PathBuf;
use std::sync::{LazyLock, atomic::Ordering};
use std::time::{Duration, Instant};

use base64::Engine;
use seelen_core::{
    resource::WidgetId,
    state::{Widget, WidgetLoader, WidgetPreset},
    system_state::MonitorId,
};

use tauri::Manager;
use windows::Win32::Foundation::HWND;

use crate::{
    app::get_app_handle,
    error::{Result, ResultLogExt},
    state::application::FULL_STATE,
    utils::{constants::SEELEN_COMMON, lock_free::TracedMutex},
    widgets::manager::GAME_MODE_ACTIVE,
    windows_api::{WindowsApi, event_window::IS_INTERACTIVE_SESSION},
};

/// Minimum spacing between two memory-pressure simulations across all widget renderers.
///
/// Every widget simulates pressure on its own timer, but the CDP call is a renderer-wide
/// operation that stalls that renderer while V8/Blink collect and hand pages back to the OS.
/// Pods are created in the same startup pass, so without pacing they would all hit their
/// renderer within the same few milliseconds; this serializes the calls and spreads them.
const MEMORY_PRESSURE_MIN_SPACING: Duration = Duration::from_secs(5);
const MEMORY_PRESSURE_LEASE_TIMEOUT: Duration = Duration::from_secs(30);

static MEMORY_PRESSURE_PACER: LazyLock<TracedMutex<MemoryPressurePacer>> =
    LazyLock::new(|| TracedMutex::new(MemoryPressurePacer::new(MEMORY_PRESSURE_MIN_SPACING)));

pub struct WidgetWebview(pub tauri::WebviewWindow);

impl WidgetWebview {
    pub fn create(
        widget: &Widget,
        label: &WidgetWebviewLabel,
        owner_hwnd: Option<isize>,
    ) -> Result<Self> {
        let state = FULL_STATE.load();
        let title = widget.metadata.display_name.get(state.locale());

        let args = WebviewArgs::create(
            state.settings.hardware_acceleration || widget.force_hardware_acceleration,
            state.settings.unstable_optimizations,
        );

        let url = match widget.loader {
            WidgetLoader::Legacy => {
                return Err("Legacy widgets are not supported by the new widget loader".into());
            }
            WidgetLoader::InternalReact => {
                let resource_name = widget
                    .id
                    .resource_name()
                    .ok_or("Can't get internal resource path")?;
                tauri::WebviewUrl::App(format!("react/{resource_name}/index.html").into())
            }
            WidgetLoader::Internal => {
                let resource_name = widget
                    .id
                    .resource_name()
                    .ok_or("Can't get internal resource path")?;
                tauri::WebviewUrl::App(format!("svelte/{resource_name}/index.html").into())
            }
            WidgetLoader::ThirdParty => {
                tauri::WebviewUrl::App("vanilla/third_party/index.html".into())
            }
        };

        let mut builder = tauri::WebviewWindowBuilder::new(get_app_handle(), &label.raw, url)
            .title(title)
            .transparent(true)
            .visible(false);

        if matches!(
            widget.preset,
            WidgetPreset::Desktop | WidgetPreset::Overlay | WidgetPreset::Popup
        ) {
            builder = builder
                .decorations(false)
                .shadow(false)
                .skip_taskbar(true)
                .minimizable(false)
                .maximizable(false)
                .closable(false);
        }

        if matches!(widget.preset, WidgetPreset::Desktop | WidgetPreset::Overlay) {
            builder = builder.focusable(false).focused(false);
        }

        match widget.preset {
            WidgetPreset::Desktop => {
                builder = builder.always_on_bottom(true);
            }
            WidgetPreset::Overlay | WidgetPreset::Popup => {
                // the window manager overlay is not topmost, its z-order is handled by the wm hook
                let always_on_top = widget.id != WidgetId::known_wm();
                builder = builder.always_on_top(always_on_top).resizable(false);
            }
            _ => {}
        }

        if let Some(owner) = owner_hwnd {
            // SAFETY: HWND in windows 0.61 (tauri) and 0.62 (ours) share the same memory layout
            #[allow(clippy::missing_transmute_annotations)]
            {
                builder = builder.owner_raw(unsafe { std::mem::transmute(owner) });
            }
        }

        let window = builder
            // wry silently denies new windows if no handler is set, so `target="_blank"` links
            // and `window.open` did nothing (tauri-plugin-shell used to intercept these clicks).
            // External links are opened on the default handler instead.
            .on_new_window(|url, _features| {
                if matches!(url.scheme(), "http" | "https" | "mailto" | "tel") {
                    WindowsApi::execute(url.to_string(), None, None, false).log_error();
                }
                tauri::webview::NewWindowResponse::Deny
            })
            .data_directory(args.data_directory())
            .additional_browser_args(&args.to_string())
            .build()?;

        // Widgets handle their own show/hide animations, avoid the ones from the system.
        // SAFETY: HWND in windows 0.61 (tauri) and 0.62 (ours) share the same memory layout
        WindowsApi::set_system_transitions_disabled(HWND(window.hwnd()?.0), true).log_error();
        Ok(Self(window))
    }

    pub fn reload(&self) {
        self.0.reload().log_error();
    }

    /// Handle to the underlying webview, cheap to clone, safe to hold outside
    /// this struct's lifetime (unlike `WidgetWebview` itself, which destroys the
    /// native window on drop).
    pub fn handle(&self) -> tauri::WebviewWindow {
        self.0.clone()
    }
}

impl Drop for WidgetWebview {
    fn drop(&mut self) {
        // Only destroy if Tauri's manager still holds the window. When
        // WindowEvent::Destroyed fires, Tauri has already removed it from the
        // manager (get_webview_window returns None), so calling destroy() again
        // would cause re-entrant ZwUserDestroyWindow → FATAL_USER_CALLBACK_EXCEPTION.
        let label = self.0.label().to_owned();
        if get_app_handle().get_webview_window(&label).is_some() {
            if let Ok(hwnd) = self.0.hwnd() {
                crate::windows_api::AppBarHost::remove(hwnd.0 as isize);
            }
            let _ = self.0.destroy();
        }
    }
}

// =============================================================================

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct WidgetWebviewLabel {
    /// this should be used as the real webview label
    pub raw: String,
    /// this is the decoded label, useful for debugging and logging
    pub decoded: String,
    /// widget id from this label was created
    pub widget_id: WidgetId,
    pub monitor_id: Option<MonitorId>,
    pub instance_id: Option<uuid::Uuid>,
}

impl WidgetWebviewLabel {
    pub fn new(
        widget_id: &WidgetId,
        monitor_id: Option<&str>,
        instance_id: Option<&uuid::Uuid>,
    ) -> Self {
        let mut label = widget_id.to_string();
        let with_monitor_id = monitor_id.is_some();
        let with_instance_id = instance_id.is_some();
        if with_monitor_id || with_instance_id {
            label.push('?');
        }

        if let Some(monitor_id) = monitor_id {
            label.push_str(&format!("monitorId={}", urlencoding::encode(monitor_id)));
        }

        if let Some(instance_id) = instance_id {
            if with_monitor_id {
                label.push('&');
            }
            label.push_str(&format!(
                "instanceId={}",
                urlencoding::encode(&instance_id.to_string())
            ));
        }

        Self {
            raw: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&label),
            decoded: label,
            widget_id: widget_id.clone(),
            monitor_id: monitor_id.map(MonitorId::from),
            instance_id: instance_id.cloned(),
        }
    }

    pub fn try_from_raw(raw: &str) -> Result<Self> {
        let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(raw)?;
        let decoded = String::from_utf8(decoded)?;

        let mut parts = decoded.splitn(2, '?');
        let widget_id = WidgetId::from(parts.next().expect("Invalid label"));

        let mut monitor_id = None;
        let mut instance_id = None;
        if let Some(query) = parts.next() {
            for param in query.split('&') {
                if let Some(value) = param.strip_prefix("monitorId=") {
                    let decoded_value = urlencoding::decode(value).unwrap_or_default();
                    monitor_id = Some(MonitorId::from(decoded_value.as_ref()));
                } else if let Some(value) = param.strip_prefix("instanceId=") {
                    let decoded_value = urlencoding::decode(value).unwrap_or_default();
                    instance_id = decoded_value.parse::<uuid::Uuid>().ok();
                }
            }
        }

        Ok(Self {
            raw: raw.to_string(),
            decoded,
            widget_id,
            monitor_id,
            instance_id,
        })
    }
}

impl std::fmt::Display for WidgetWebviewLabel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.decoded)
    }
}

// =============================================================================

pub struct WebviewArgs {
    args: Vec<String>,
    with_gpu: bool,
    unstable: bool,
}

impl WebviewArgs {
    const BASE_ARGS: &[&str] = &[
        "--disable-features=translate,msWebOOUI,msPdfOOUI,msSmartScreenProtection,RendererAppContainer,BackForwardCache,InterestCohort,SharedArrayBuffer,CalculateNativeWinOcclusion,OptimizationHints,AutofillServerCommunication,PaintHolding",
        "--no-first-run",
        "--disable-site-isolation-trials",
        "--disk-cache-size=0",
        "--disable-application-cache",
        "--media-cache-size=0",
        "--disable-extensions",
        "--disable-component-extensions-with-background-pages",
        "--disable-ipc-flooding-protection",
        "--disable-breakpad",
        "--disable-crash-reporter",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        // prevents the browser from lowering the CPU priority of invisible windows, oposite of what we want
        // "--disable-renderer-backgrounding"
        "--disable-sync",
        "--no-pings",
        // maybe causes more resources than it reduces
        // "--aggressive-cache-discard",
    ];

    const GPU_ARGS: &[&str] = &[
        "--enable-gpu",
        "--enable-accelerated-video-decode",
        "--enable-gpu-rasterization",
        "--enable-zero-copy",
        "--enable-native-gpu-memory-buffers",
        "--enable-oop-rasterization",
        "--use-angle=d3d11", // Media Foundation + DXVA + D3D11 in windows is the most optimized
    ];

    const PERFORMANCE_ARGS: &[&str] = &[
        // unstable flag that causes more issues than it solves
        // "--enable-low-end-device-mode",
        // this completely removes the gpu process
        "--in-process-gpu",
        "--disable-gpu",
        "--disable-gpu-compositing",
        "--disable-gpu-shader-disk-cache",
        "--disable-accelerated-video-encode",
        "--disable-gpu-rasterization",
        "--disable-software-rasterizer",
    ];

    const UNSTABLE_OPTIMIZATIONS: &[&str] = &[
        // this reduces ram usage but if a widget crashes it will crash
        // all widgets with the same loader, so it's not worth it.
        // All Seelen pages share one origin (site), so this puts every widget in a single
        // renderer: the memory-pressure workaround can no longer target an idle widget only
        // and is skipped while this is enabled (see `simulate_memory_pressure`).
        "--process-per-site",
    ];

    pub fn create(with_gpu: bool, unstable_optimizations: bool) -> Self {
        let mut args: Vec<String> = Self::BASE_ARGS.iter().map(|s| s.to_string()).collect();

        if with_gpu {
            args.extend(Self::GPU_ARGS.iter().map(|s| s.to_string()));
        } else {
            args.extend(Self::PERFORMANCE_ARGS.iter().map(|s| s.to_string()));
        };

        if unstable_optimizations {
            args.extend(Self::UNSTABLE_OPTIMIZATIONS.iter().map(|s| s.to_string()));
        }

        Self {
            args,
            with_gpu,
            unstable: unstable_optimizations,
        }
    }

    pub fn data_directory(&self) -> PathBuf {
        let foldername = match (self.with_gpu, self.unstable) {
            (true, true) => "gpu-unstable",
            (true, false) => "gpu",
            (false, true) => "no-gpu-unstable",
            (false, false) => "no-gpu",
        };

        SEELEN_COMMON.app_cache_dir().join(foldername)
    }
}

impl std::fmt::Display for WebviewArgs {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.args.join(" "))
    }
}

/// Paces the global memory-pressure simulation, see [`MEMORY_PRESSURE_MIN_SPACING`].
struct MemoryPressurePacer {
    spacing: Duration,
    last_run: Option<Instant>,
    in_flight: bool,
    lease_id: u64,
}

impl MemoryPressurePacer {
    const fn new(spacing: Duration) -> Self {
        Self {
            spacing,
            last_run: None,
            in_flight: false,
            lease_id: 0,
        }
    }

    /// Claims the global slot at `now`, or reports that the previous run is too recent.
    fn try_claim(&mut self, now: Instant) -> bool {
        if self.in_flight {
            if self.last_run.is_some_and(|last_run| {
                now.saturating_duration_since(last_run) < MEMORY_PRESSURE_LEASE_TIMEOUT
            }) {
                return false;
            }
            log::warn!("Reclaiming expired WebView memory-pressure lease");
        }
        if let Some(last_run) = self.last_run
            && now.saturating_duration_since(last_run) < self.spacing
        {
            return false;
        }
        self.last_run = Some(now);
        self.in_flight = true;
        self.lease_id = self.lease_id.wrapping_add(1);
        true
    }

    fn release(&mut self, lease_id: u64) {
        if self.lease_id == lease_id {
            self.in_flight = false;
        }
    }
}

struct MemoryPressureLease(u64);

impl Drop for MemoryPressureLease {
    fn drop(&mut self) {
        MEMORY_PRESSURE_PACER.lock().release(self.0);
    }
}

/// Makes the webview render 1 CSS px = 1 physical px (`devicePixelRatio` = 1) on every monitor.
///
/// By default WebView2 tracks the monitor DPI itself (`ShouldDetectMonitorScaleChanges`) and
/// updates its `RasterizationScale` asynchronously after the window crosses monitors, so any
/// zoom-based compensation done from the webview races against it (and against `WM_DPICHANGED`
/// not being delivered to hidden windows). Taking ownership of the scale and pinning it to 1.0
/// removes the race entirely: the scale never changes again, whatever monitor the window is on.
pub fn lock_rasterization_scale_to_one(webview: &tauri::WebviewWindow) -> Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller3;
    use windows_core::Interface;

    webview.with_webview(|platform_webview| {
        let controller = platform_webview.controller();
        let result = (|| unsafe {
            // reset any zoom compensation applied before (zoom persists across reloads)
            controller.SetZoomFactor(1.0)?;
            let controller = controller.cast::<ICoreWebView2Controller3>()?;
            controller.SetShouldDetectMonitorScaleChanges(false)?;
            controller.SetRasterizationScale(1.0)
        })();

        if let Err(err) = result {
            log::error!("Failed to lock webview rasterization scale: {err:?}");
        }
    })?;
    Ok(())
}

/// Decides whether the artificial memory pressure can help this widget right now.
///
/// Kept as a pure function so the policy is testable without a webview: a locked/unattended
/// session has nothing to reclaim for, a suspended widget (game mode) has no renderer to
/// reclaim from, and a widget the user can see (or interact with) must not be stalled by a
/// forced critical-pressure GC. With `unstable_optimizations` (`--process-per-site`) every
/// Seelen page shares one renderer (same origin), so pressure can no longer be scoped to an
/// idle page and would stall the visible ones too; the shared renderer already shares one heap
/// between widgets, which is why the experiment can skip this workaround entirely.
fn can_simulate_memory_pressure(
    interactive_session: bool,
    game_mode_active: bool,
    unstable_optimizations: bool,
    visible: bool,
    focused: bool,
) -> bool {
    interactive_session && !game_mode_active && !unstable_optimizations && !visible && !focused
}

/// Forces the WebView2 renderer to react as if the OS was under memory pressure,
/// via the same CDP call DevTools issues internally. Unlike `window.gc()`, this
/// actually makes V8/Blink release freed pages back to the OS, because real pressure
/// almost never reaches an individual background widget when the system overall has
/// plenty of RAM free.
///
/// `Memory.simulatePressureNotification` is per renderer, not per page: in the default
/// browser configuration each widget owns its renderer, so this only reclaims that widget's
/// heap. Calls are paced globally ([`MEMORY_PRESSURE_PACER`]) and only run for widgets that
/// are hidden, unfocused and in an interactive session (see
/// [`can_simulate_memory_pressure`]).
pub fn simulate_memory_pressure(webview: &tauri::WebviewWindow) {
    let unstable_optimizations = FULL_STATE.load().settings.unstable_optimizations;
    let should_run = can_simulate_memory_pressure(
        IS_INTERACTIVE_SESSION.load(Ordering::Acquire),
        GAME_MODE_ACTIVE.load(Ordering::Acquire),
        unstable_optimizations,
        webview.is_visible().unwrap_or(true),
        webview.is_focused().unwrap_or(false),
    );
    if !should_run {
        return;
    }

    let current = webview.clone();
    webview
        .with_webview(move |platform_webview| {
            // Visibility can change while this callback waits for the UI thread.
            if !can_simulate_memory_pressure(
                IS_INTERACTIVE_SESSION.load(Ordering::Acquire),
                GAME_MODE_ACTIVE.load(Ordering::Acquire),
                FULL_STATE.load().settings.unstable_optimizations,
                current.is_visible().unwrap_or(true),
                current.is_focused().unwrap_or(false),
            ) {
                return;
            }
            let lease = {
                let mut pacer = MEMORY_PRESSURE_PACER.lock();
                if !pacer.try_claim(Instant::now()) {
                    return;
                }
                MemoryPressureLease(pacer.lease_id)
            };
            let controller = platform_webview.controller();
            let core_webview = match unsafe { controller.CoreWebView2() } {
                Ok(core_webview) => core_webview,
                Err(err) => {
                    log::warn!("Failed to get ICoreWebView2 for memory pressure simulation: {err}");
                    return;
                }
            };

            // Complete through the handler instead of `wait_for_async_operation`: that helper
            // pumps the Windows message loop until the CDP call finishes, which would run a
            // nested message loop on the main thread just to wait for a GC whose result we
            // don't need.
            let completed = webview2_com::CallDevToolsProtocolMethodCompletedHandler::create(
                Box::new(move |result, _json| {
                    drop(lease);
                    if let Err(err) = result {
                        log::warn!("Memory.simulatePressureNotification failed: {err:?}");
                    }
                    Ok(())
                }),
            );

            // Can't use our own `WindowsString` here: webview2-com pins its own `windows`
            // crate version (0.61) which is semver-incompatible with the one this project
            // depends on directly (0.62.2), so their `PCWSTR` types don't unify. Must go
            // through webview2-com's own string helper, built against its own `windows`.
            let method = webview2_com::CoTaskMemPWSTR::from("Memory.simulatePressureNotification");
            let params = webview2_com::CoTaskMemPWSTR::from(r#"{"level":"critical"}"#);

            let result = unsafe {
                core_webview.CallDevToolsProtocolMethod(
                    *method.as_ref().as_pcwstr(),
                    *params.as_ref().as_pcwstr(),
                    &completed,
                )
            };
            if let Err(err) = result {
                log::warn!(
                    "Memory.simulatePressureNotification failed: {:?}",
                    webview2_com::Error::from(err)
                );
            }
        })
        .log_error();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pressure_only_runs_for_hidden_widgets_in_an_attended_session() {
        assert!(can_simulate_memory_pressure(
            true, false, false, false, false
        ));
        assert!(
            !can_simulate_memory_pressure(false, false, false, false, false),
            "locked session"
        );
        assert!(
            !can_simulate_memory_pressure(true, true, false, false, false),
            "game mode"
        );
        assert!(
            !can_simulate_memory_pressure(true, false, true, false, false),
            "shared renderer"
        );
        assert!(
            !can_simulate_memory_pressure(true, false, false, true, false),
            "visible widget"
        );
        assert!(
            !can_simulate_memory_pressure(true, false, false, false, true),
            "focused widget"
        );
        assert!(
            !can_simulate_memory_pressure(true, false, false, true, true),
            "visible and focused widget"
        );
    }

    #[test]
    fn pressure_pacer_spaces_consecutive_runs() {
        let spacing = Duration::from_secs(5);
        let mut pacer = MemoryPressurePacer::new(spacing);
        let start = Instant::now();

        assert!(pacer.try_claim(start), "the first run is always allowed");
        assert!(
            !pacer.try_claim(start + spacing * 2),
            "in-flight work is serialized"
        );
        pacer.in_flight = false;
        assert!(
            !pacer.try_claim(start),
            "simultaneous pods must not all pressure their renderer"
        );
        assert!(!pacer.try_claim(start + spacing - Duration::from_millis(1)));
        assert!(pacer.try_claim(start + spacing));
        pacer.in_flight = false;
        assert!(pacer.try_claim(start + spacing * 2));
        pacer.in_flight = false;
        assert!(!pacer.try_claim(start + spacing * 2 + Duration::from_secs(1)));
    }

    #[test]
    fn expired_pressure_completion_does_not_release_a_newer_lease() {
        let start = Instant::now();
        let mut pacer = MemoryPressurePacer::new(MEMORY_PRESSURE_MIN_SPACING);
        assert!(pacer.try_claim(start));
        let old_lease = pacer.lease_id;
        assert!(!pacer.try_claim(start + MEMORY_PRESSURE_LEASE_TIMEOUT - Duration::from_millis(1)));
        assert!(pacer.try_claim(start + MEMORY_PRESSURE_LEASE_TIMEOUT));
        let current_lease = pacer.lease_id;
        pacer.release(old_lease);
        assert!(pacer.in_flight);
        pacer.release(current_lease);
        assert!(!pacer.in_flight);
    }
}
