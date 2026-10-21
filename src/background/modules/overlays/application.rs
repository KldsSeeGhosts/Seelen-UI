//! Tracks foreign windows that are not part of the normal task list but can still
//! cover the dock: capture/recording controls and non-activating transcription
//! overlays (tool windows and windows that never receive focus).
//!
//! The normal application list deliberately excludes those windows, so overlap
//! detection could not see them. This tracker is read-only, event driven and keeps a
//! coalesced snapshot; it never enumerates windows per frame and never changes another
//! application's window.

use std::{
    collections::HashMap,
    sync::{LazyLock, Once},
    time::{Duration, Instant},
};

use crossbeam_channel::{Receiver, Sender, unbounded};
use seelen_core::{rect::Rect, system_state::UserAppOverlayWindow};
use windows::Win32::UI::WindowsAndMessaging::{
    WINDOW_EX_STYLE, WS_EX_APPWINDOW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
};

use crate::{
    event_manager,
    hook::HookManager,
    modules::monitors::{MonitorManager, MonitorManagerEvent},
    utils::{lock_free::TracedMutex, spawn_named_thread},
    windows_api::{
        WindowEnumerator, WindowsApi,
        window::{Window, event::WinEvent},
    },
};

/// Overlay bursts (a window moves while it is being shown) are coalesced over this
/// interval before refreshing the snapshot.
const REFRESH_COALESCE: Duration = Duration::from_millis(80);

static SNAPSHOT: LazyLock<TracedMutex<Vec<UserAppOverlayWindow>>> =
    LazyLock::new(|| TracedMutex::new(Vec::new()));

static TRACKER: LazyLock<Sender<OverlayRequest>> = LazyLock::new(|| {
    let (tx, rx) = unbounded();
    spawn_named_thread("Overlay Tracker", move || run_tracker(rx));
    tx
});

/// Keep the desktop usable while a real top-level overlay is over the dock.
///
/// This intentionally excludes ordinary task windows (the normal application list
/// already handles those) and the UI chrome that regularly floats over the desktop but
/// does not want to take the desktop away from the dock.
static IGNORED_OVERLAY_CLASSES: &[&str] = &[
    "tooltips_class32",
    "#32768",
    "SysShadow",
    "DV2ControlHost",
    "DropDown",
    "ComboLBox",
    "IME",
    "MSCTFIME UI",
    "Shell_TrayWnd",
    "Shell_SecondaryTrayWnd",
    "Progman",
    "WorkerW",
    "NotifyIconOverflowWindow",
    "TopLevelWindowForOverflowXamlIsland",
    "Windows.Internal.Shell.TabProxyWindow",
    "TaskListThumbnailWnd",
];

/// Shell surfaces that are commonly tool/no-activate windows. They must never take the
/// dock away; the start menu is expected to show the dock above it.
static SHELL_UI_PROCESSES: &[&str] = &[
    "explorer.exe",
    "StartMenuExperienceHost.exe",
    "SearchHost.exe",
    "ShellExperienceHost.exe",
    "TextInputHost.exe",
    "Widgets.exe",
];

pub struct OverlayManager;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OverlayManagerEvent {
    /// The complete snapshot changed.
    Changed,
}

event_manager!(OverlayManager, OverlayManagerEvent);

impl OverlayManager {
    pub fn instance() -> &'static Self {
        static MANAGER: OverlayManager = OverlayManager;
        static INIT: Once = Once::new();
        INIT.call_once(|| {
            // Subscribe before the first scan so a window appearing during startup is
            // either caught by the scan or queued by the hook.
            install_hooks();
            LazyLock::force(&TRACKER);
        });
        &MANAGER
    }

    /// Current snapshot, already stripped of invisible/offscreen/own windows.
    pub fn snapshot(&self) -> Vec<UserAppOverlayWindow> {
        SNAPSHOT.lock().clone()
    }

    fn refresh(hwnd: isize) {
        let _ = TRACKER.send(OverlayRequest::Dirty(hwnd));
    }

    fn remove(hwnd: isize) {
        let _ = TRACKER.send(OverlayRequest::Remove(hwnd));
    }

    fn request_rescan() {
        let _ = TRACKER.send(OverlayRequest::Rescan);
    }

    fn publish(snapshot: Vec<UserAppOverlayWindow>) {
        let changed = {
            let mut current = SNAPSHOT.lock();
            if *current == snapshot {
                false
            } else {
                *current = snapshot;
                true
            }
        };
        if changed {
            Self::send(OverlayManagerEvent::Changed);
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum OverlayRequest {
    Dirty(isize),
    Remove(isize),
    Rescan,
}

fn install_hooks() {
    HookManager::subscribe(|(event, window)| match event {
        WinEvent::SystemForeground => OverlayManager::request_rescan(),
        WinEvent::ObjectDestroy => OverlayManager::remove(window.address()),
        WinEvent::ObjectCreate
        | WinEvent::ObjectShow
        | WinEvent::ObjectHide
        | WinEvent::ObjectCloaked
        | WinEvent::ObjectUncloaked
        | WinEvent::ObjectStateChange
        | WinEvent::ObjectParentChange
        | WinEvent::ObjectReorder
        | WinEvent::SystemMinimizeStart
        | WinEvent::SystemMinimizeEnd => OverlayManager::refresh(window.address()),
        WinEvent::ObjectNameChange
        | WinEvent::ObjectLocationChange
        | WinEvent::SynDebouncedRectChange
            if is_potential_overlay(&window) =>
        {
            OverlayManager::refresh(window.address());
        }
        _ => {}
    });

    MonitorManager::subscribe(|event| {
        if matches!(event, MonitorManagerEvent::ViewsChanged) {
            OverlayManager::request_rescan();
        }
    });
}

fn run_tracker(rx: Receiver<OverlayRequest>) {
    let mut tracked: HashMap<isize, UserAppOverlayWindow> = HashMap::new();
    let mut pending: HashMap<isize, bool> = HashMap::new(); // true = remove
    let mut rescan = true;

    // Initial scan, so the first snapshot does not depend on the dock asking first.
    flush(&mut tracked, &mut pending, &mut rescan);
    publish(&tracked);

    loop {
        let request = match rx.recv() {
            Ok(request) => request,
            Err(_) => return,
        };
        apply_request(request, &mut pending, &mut rescan);

        // A fixed deadline keeps continuously moving overlays from starving publication.
        let deadline = Instant::now() + REFRESH_COALESCE;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match rx.recv_timeout(remaining) {
                Ok(request) => apply_request(request, &mut pending, &mut rescan),
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => break,
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                    flush(&mut tracked, &mut pending, &mut rescan);
                    publish(&tracked);
                    return;
                }
            }
        }

        flush(&mut tracked, &mut pending, &mut rescan);
        publish(&tracked);
    }
}

fn apply_request(request: OverlayRequest, pending: &mut HashMap<isize, bool>, rescan: &mut bool) {
    match request {
        OverlayRequest::Dirty(hwnd) => {
            pending.insert(hwnd, false);
        }
        OverlayRequest::Remove(hwnd) => {
            pending.insert(hwnd, true);
        }
        OverlayRequest::Rescan => *rescan = true,
    }
}

fn flush(
    tracked: &mut HashMap<isize, UserAppOverlayWindow>,
    pending: &mut HashMap<isize, bool>,
    rescan: &mut bool,
) {
    let virtual_screen = match WindowsApi::virtual_screen_rect().map(to_core_rect) {
        Ok(rect) => rect,
        Err(err) => {
            // Without the virtual screen bounds an offscreen parked overlay (Jot while
            // idle) could be mistaken for a visible one. Keep the current snapshot and
            // retry on the next event instead.
            log::warn!("Failed to read virtual screen for overlay filtering: {err}");
            return;
        }
    };

    if *rescan {
        *rescan = false;
        pending.clear();
        let mut next = HashMap::new();
        let scan = WindowEnumerator::new().for_each(|window| {
            if let Some(overlay) = build_overlay(&window, &virtual_screen) {
                next.insert(overlay.hwnd, overlay);
            }
        });
        match scan {
            Ok(()) => *tracked = next,
            Err(err) => log::warn!("Failed to enumerate overlay windows: {err}"),
        }
        return;
    }

    for (hwnd, remove) in pending.drain() {
        if remove {
            tracked.remove(&hwnd);
            continue;
        }
        let window = Window::from(hwnd);
        match build_overlay(&window, &virtual_screen) {
            Some(overlay) => {
                tracked.insert(hwnd, overlay);
            }
            None => {
                tracked.remove(&hwnd);
            }
        }
    }
}

fn publish(tracked: &HashMap<isize, UserAppOverlayWindow>) {
    let mut snapshot: Vec<UserAppOverlayWindow> = tracked.values().cloned().collect();
    snapshot.sort_by_key(|overlay| overlay.hwnd);
    OverlayManager::publish(snapshot);
}

fn build_overlay(window: &Window, virtual_screen: &Rect) -> Option<UserAppOverlayWindow> {
    if !window.is_window()
        || !window.is_visible()
        || window.is_minimized()
        || window.is_cloaked()
        || !window.is_top_level()
    {
        return None;
    }

    // Our own widget menus/previews and the dock itself must never count as overlay.
    if window.process().id() == WindowsApi::current_process_id() {
        return None;
    }

    if !is_overlay_ex_style(WindowsApi::get_ex_styles(window.hwnd())) {
        return None;
    }

    // Background utility windows must not suppress a topmost dock. Non-topmost
    // capture forms still take precedence while their process owns the foreground.
    if !WindowsApi::get_ex_styles(window.hwnd()).contains(WS_EX_TOPMOST)
        && Window::from(WindowsApi::get_foreground_window())
            .process()
            .id()
            != window.process().id()
    {
        return None;
    }

    if is_shell_ui_window(window) {
        return None;
    }

    if is_ignored_overlay_class(&window.class()) {
        return None;
    }

    let rect = window.inner_rect().ok()?;
    if !rect_is_usable(&rect, virtual_screen) {
        return None;
    }

    Some(UserAppOverlayWindow {
        hwnd: window.address(),
        rect,
    })
}

/// Cheap enough to run on the WinEvent dispatcher: filters normal application windows
/// and offscreen parked overlays (e.g. Jot while idle) before waking the tracker.
fn is_potential_overlay(window: &Window) -> bool {
    if !window.is_window()
        || !window.is_visible()
        || window.is_minimized()
        || window.is_cloaked()
        || !window.is_top_level()
    {
        return false;
    }
    if window.process().id() == WindowsApi::current_process_id() {
        return false;
    }
    if !is_overlay_ex_style(WindowsApi::get_ex_styles(window.hwnd())) {
        return false;
    }
    true
}

fn is_shell_ui_window(window: &Window) -> bool {
    window
        .process()
        .program_exe_name()
        .is_ok_and(|name| is_shell_ui_process(&name))
}

fn is_shell_ui_process(exe_name: &str) -> bool {
    SHELL_UI_PROCESSES
        .iter()
        .any(|ignored| exe_name.eq_ignore_ascii_case(ignored))
}

fn is_overlay_ex_style(style: WINDOW_EX_STYLE) -> bool {
    if style.contains(WS_EX_APPWINDOW) {
        return false;
    }
    style.contains(WS_EX_TOOLWINDOW) || style.contains(WS_EX_NOACTIVATE)
}

fn is_ignored_overlay_class(class: &str) -> bool {
    IGNORED_OVERLAY_CLASSES
        .iter()
        .any(|ignored| class.eq_ignore_ascii_case(ignored))
}

fn rect_is_usable(rect: &Rect, virtual_screen: &Rect) -> bool {
    rect.right > rect.left && rect.bottom > rect.top && rectangles_intersect(rect, virtual_screen)
}

fn rectangles_intersect(a: &Rect, b: &Rect) -> bool {
    a.left < a.right
        && a.top < a.bottom
        && b.left < b.right
        && b.top < b.bottom
        && a.left < b.right
        && a.right > b.left
        && a.top < b.bottom
        && a.bottom > b.top
}

fn to_core_rect(rect: windows::Win32::Foundation::RECT) -> Rect {
    Rect {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(left: i32, top: i32, right: i32, bottom: i32) -> Rect {
        Rect {
            left,
            top,
            right,
            bottom,
        }
    }

    #[test]
    fn only_tool_or_non_activating_windows_are_overlays() {
        assert!(is_overlay_ex_style(WS_EX_TOOLWINDOW));
        assert!(is_overlay_ex_style(WS_EX_NOACTIVATE));
        assert!(is_overlay_ex_style(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE));
        assert!(!is_overlay_ex_style(WINDOW_EX_STYLE::default()));
        // A tool window that is also a taskbar app belongs to the normal list.
        assert!(!is_overlay_ex_style(WS_EX_TOOLWINDOW | WS_EX_APPWINDOW));
    }

    #[test]
    fn ui_chrome_classes_are_not_overlays() {
        assert!(is_ignored_overlay_class("tooltips_class32"));
        assert!(is_ignored_overlay_class("#32768"));
        assert!(is_ignored_overlay_class("Shell_TrayWnd"));
        assert!(!is_ignored_overlay_class("ShareX_RegionCaptureForm"));
        assert!(!is_ignored_overlay_class("JotOverlayWindow"));
    }

    #[test]
    fn shell_surfaces_are_not_overlays() {
        assert!(is_shell_ui_process("explorer.exe"));
        assert!(is_shell_ui_process("StartMenuExperienceHost.exe"));
        assert!(is_shell_ui_process("SearchHost.exe"));
        assert!(is_shell_ui_process("TextInputHost.exe"));
        assert!(!is_shell_ui_process("ShareX.exe"));
        assert!(!is_shell_ui_process("Jot.exe"));
    }

    #[test]
    fn offscreen_and_empty_rectangles_are_not_usable() {
        let virtual_screen = rect(0, 0, 3840, 1080);
        // Jot parks its idle window offscreen; it must not hide the dock.
        assert!(!rect_is_usable(
            &rect(-32000, -32000, -31600, -31900),
            &virtual_screen
        ));
        assert!(!rect_is_usable(&rect(100, 100, 100, 400), &virtual_screen));
        assert!(!rect_is_usable(&rect(100, 100, 400, 100), &virtual_screen));
        // A visible sliver on a secondary monitor is still usable.
        assert!(rect_is_usable(&rect(-120, 100, 120, 400), &virtual_screen));
    }

    #[test]
    fn rectangles_touching_only_at_an_edge_do_not_intersect() {
        let screen = rect(0, 0, 1920, 1080);
        assert!(rectangles_intersect(&rect(0, 1040, 1920, 1080), &screen));
        assert!(!rectangles_intersect(&rect(1920, 0, 2200, 100), &screen));
        assert!(!rectangles_intersect(&rect(0, 1080, 1920, 1120), &screen));
        assert!(!rectangles_intersect(&rect(500, 500, 500, 600), &screen));
    }

    #[test]
    fn the_last_tracking_request_for_a_handle_wins() {
        // A handle can be destroyed and immediately reused by another overlay. The
        // tracker must follow the latest event instead of dropping the new window.
        let mut pending = HashMap::new();
        let mut rescan = false;

        apply_request(OverlayRequest::Dirty(42), &mut pending, &mut rescan);
        assert_eq!(pending.get(&42), Some(&false));

        apply_request(OverlayRequest::Remove(42), &mut pending, &mut rescan);
        assert_eq!(pending.get(&42), Some(&true));

        apply_request(OverlayRequest::Dirty(42), &mut pending, &mut rescan);
        assert_eq!(pending.get(&42), Some(&false));
        assert!(!rescan);

        apply_request(OverlayRequest::Rescan, &mut pending, &mut rescan);
        assert!(rescan);
    }
}
