//! Shell application desktop toolbar (appbar) registration.
//!
//! The dock/toolbar webview owns the visible window, but the shell appbar protocol is
//! registered on a dedicated hidden window per bar. That keeps the shell callbacks
//! (`ABN_*`) and their lifecycle out of Tauri's window procedure, and lets several
//! bars (one per monitor) coexist.
//!
//! Registration follows the documented contract:
//! <https://learn.microsoft.com/en-us/windows/win32/shell/application-desktop-toolbars>
//! 1. `ABM_NEW` with a callback message.
//! 2. `ABM_QUERYPOS` with the full edge strip of the monitor.
//! 3. Restore the requested thickness on the anchored edge.
//! 4. `ABM_SETPOS` and use the rectangle returned by the shell.
//!
//! All shell calls happen on the dedicated host thread; no `TracedMutex` guard is ever
//! held across `SHAppBarMessage`.

use std::{
    collections::{HashMap, HashSet},
    sync::{
        LazyLock, Once, OnceLock,
        atomic::{AtomicU32, Ordering},
    },
};

use crossbeam_channel::{Receiver, Sender, unbounded};
use seelen_core::{
    rect::Rect,
    system_state::{AppBarEdge, AppBarReservation},
};
use windows::{
    Win32::{
        Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM},
        Graphics::Gdi::{MONITOR_DEFAULTTONEAREST, MonitorFromRect},
        System::Threading::GetCurrentThreadId,
        UI::{
            Shell::{
                ABE_BOTTOM, ABE_LEFT, ABE_RIGHT, ABE_TOP, ABM_NEW, ABM_QUERYPOS, ABM_REMOVE,
                ABM_SETPOS, ABM_WINDOWPOSCHANGED, ABN_FULLSCREENAPP, ABN_POSCHANGED, APPBARDATA,
                SHAppBarMessage,
            },
            WindowsAndMessaging::{
                CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW,
                HWND_BOTTOM, HWND_NOTOPMOST, HWND_TOPMOST, MSG, PM_NOREMOVE, PeekMessageW,
                PostThreadMessageW, RegisterClassW, RegisterWindowMessageW, SWP_NOACTIVATE,
                SWP_NOZORDER, SetWindowPos, TranslateMessage, WM_APP, WM_DISPLAYCHANGE,
                WM_WINDOWPOSCHANGED, WNDCLASSW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
                WS_POPUP,
            },
        },
    },
    core::{PCWSTR, w},
};

use crate::{
    hook::HookManager,
    utils::{lock_free::TracedMutex, spawn_named_thread},
    windows_api::{
        MonitorEnumerator, WindowsApi, string_utils::WindowsString, window::event::WinEvent,
    },
};

/// Callback message used by the shell to send `ABN_*` notifications to the host window.
const APP_BAR_CALLBACK: u32 = WM_APP + 0x41;
/// Thread message used to wake the host thread when a request is queued.
const WM_APP_BAR_WAKE: u32 = WM_APP + 0x42;

static APP_BAR_CLASS: LazyLock<WindowsString> =
    LazyLock::new(|| WindowsString::from("SeelenAppBarHost"));

/// Handles of the windows (webviews) that requested a reservation. Kept apart from the
/// host thread state so destroyed windows can be dropped without querying the shell.
static OWNERS: LazyLock<TracedMutex<HashSet<isize>>> =
    LazyLock::new(|| TracedMutex::new(HashSet::new()));

static REQUESTS: LazyLock<Sender<AppBarRequest>> = LazyLock::new(|| {
    let (tx, rx) = unbounded();
    spawn_named_thread("AppBar Host", move || host_thread(rx));
    tx
});

static HOST_THREAD_ID: OnceLock<u32> = OnceLock::new();
static TASKBAR_CREATED_MESSAGE: AtomicU32 = AtomicU32::new(0);

/// Registers or updates the reservation for a dock/toolbar webview.
pub struct AppBarHost;

crate::event_manager!(AppBarHost, AppBarReservation);

impl AppBarHost {
    /// Asks the shell to reserve `rect` on `edge` for the window `owner`.
    ///
    /// Repeated calls with the same geometry are ignored by the host thread.
    pub async fn upsert(owner: isize, rect: RECT, edge: AppBarEdge) -> crate::error::Result<Rect> {
        install_cleanup_hook();
        OWNERS.lock().insert(owner);
        let (tx, rx) = tokio::sync::oneshot::channel();
        send(AppBarRequest::Upsert {
            owner,
            rect,
            edge,
            reply: tx,
        });
        tokio::time::timeout(std::time::Duration::from_secs(3), rx)
            .await
            .map_err(|_| "Timed out negotiating appbar space with Windows")?
            .map_err(|_| "Appbar host stopped")?
            .map(to_core_rect)
            .map_err(Into::into)
    }

    /// Removes the reservation and destroys the host window for `owner`.
    pub fn remove(owner: isize) {
        let was_registered = { OWNERS.lock().remove(&owner) };
        if was_registered {
            send(AppBarRequest::Remove { owner });
        }
    }
}

#[derive(Debug)]
enum AppBarRequest {
    Upsert {
        owner: isize,
        rect: RECT,
        edge: AppBarEdge,
        reply: tokio::sync::oneshot::Sender<std::result::Result<RECT, String>>,
    },
    Remove {
        owner: isize,
    },
    /// Re-run `ABM_QUERYPOS`/`ABM_SETPOS` for every bar (another bar or the taskbar moved).
    ResyncAll,
    /// Display topology changed; drop reservations that no longer belong to a monitor.
    DisplayChanged,
    /// Explorer was restarted and lost every registration.
    ShellRestart,
    Fullscreen {
        host: isize,
        entering: bool,
    },
}

/// State owned exclusively by the host thread. No locks are needed and none are held
/// while talking to the shell.
struct HostState {
    bars: HashMap<isize, HostBar>,
}

impl HostState {
    fn new() -> Option<Self> {
        let class = &*APP_BAR_CLASS;
        let h_instance = WindowsApi::module_handle_w().ok()?;
        let wnd_class = WNDCLASSW {
            lpfnWndProc: Some(host_window_proc),
            hInstance: h_instance.into(),
            lpszClassName: class.as_pcwstr(),
            ..Default::default()
        };
        unsafe {
            RegisterClassW(&wnd_class);
        }

        let taskbar_created = unsafe { RegisterWindowMessageW(w!("TaskbarCreated")) };
        TASKBAR_CREATED_MESSAGE.store(taskbar_created, Ordering::Relaxed);

        Some(Self {
            bars: HashMap::new(),
        })
    }

    fn drain(&mut self, rx: &Receiver<AppBarRequest>) {
        let mut resync = false;
        let mut display_changed = false;
        let mut shell_restart = false;

        while let Ok(request) = rx.try_recv() {
            match request {
                AppBarRequest::Upsert {
                    owner,
                    rect,
                    edge,
                    reply,
                } => {
                    if reply.is_closed() {
                        continue;
                    }
                    self.upsert(owner, rect, edge);
                    let result = self
                        .bars
                        .get(&owner)
                        .and_then(|bar| bar.applied)
                        .ok_or_else(|| "Failed to reserve appbar space".to_string());
                    let _ = reply.send(result);
                }
                AppBarRequest::Remove { owner } => self.remove(owner),
                AppBarRequest::ResyncAll => resync = true,
                AppBarRequest::DisplayChanged => display_changed = true,
                AppBarRequest::ShellRestart => shell_restart = true,
                AppBarRequest::Fullscreen { host, entering } => {
                    if let Some((&owner, bar)) = self
                        .bars
                        .iter_mut()
                        .find(|(_, bar)| bar.hwnd.0 as isize == host)
                    {
                        let hwnd = HWND(owner as *mut _);
                        let order = if entering {
                            if bar.fullscreen_restore.is_none() {
                                bar.fullscreen_restore =
                                    Some(WindowsApi::get_ex_styles(hwnd).contains(WS_EX_TOPMOST));
                            }
                            Some(HWND_BOTTOM)
                        } else {
                            bar.fullscreen_restore.take().map(|topmost| {
                                if topmost {
                                    HWND_TOPMOST
                                } else {
                                    HWND_NOTOPMOST
                                }
                            })
                        };
                        if let Some(order) = order
                            && let Err(err) = WindowsApi::set_z_order(hwnd, order)
                        {
                            log::warn!("Failed to restore appbar stacking: {err}");
                        }
                    }
                }
            }
        }

        if shell_restart {
            self.reregister_all();
        } else if display_changed {
            self.drop_bars_outside_monitors();
            self.reapply_all();
        } else if resync {
            self.reapply_all();
        }
    }

    fn upsert(&mut self, owner: isize, desired: RECT, edge: AppBarEdge) {
        let monitor = monitor_rect_for(&desired);
        if !rectangles_intersect(&desired, &monitor) {
            log::warn!("Ignoring appbar reservation outside every monitor");
            self.remove(owner);
            return;
        }

        if let Some(bar) = self.bars.get(&owner) {
            let unchanged = bar.edge == edge && rect_equals(bar.desired, desired);
            let (hwnd, registered, applied, fullscreen_restore) = (
                bar.hwnd,
                bar.registered,
                bar.applied,
                bar.fullscreen_restore,
            );
            if unchanged && registered && applied.is_some() {
                return;
            }
            self.bars.insert(
                owner,
                HostBar {
                    hwnd,
                    desired,
                    edge,
                    registered,
                    applied: None,
                    fullscreen_restore,
                },
            );
        } else {
            let Some(hwnd) = create_host_window() else {
                return;
            };
            self.bars.insert(
                owner,
                HostBar {
                    hwnd,
                    desired,
                    edge,
                    registered: false,
                    applied: None,
                    fullscreen_restore: None,
                },
            );
        }

        self.apply(owner);
    }

    fn remove(&mut self, owner: isize) {
        let Some(bar) = self.bars.remove(&owner) else {
            return;
        };

        if bar.registered {
            let mut data = appbar_data(bar.hwnd);
            unsafe { SHAppBarMessage(ABM_REMOVE, &mut data) };
        }
        unsafe {
            let _ = DestroyWindow(bar.hwnd);
        }
    }

    fn apply(&mut self, owner: isize) {
        let Some((hwnd, desired, edge, registered, previous)) = self
            .bars
            .get(&owner)
            .map(|bar| (bar.hwnd, bar.desired, bar.edge, bar.registered, bar.applied))
        else {
            return;
        };

        if !registered {
            if !register_bar(hwnd) {
                log::error!("Failed to register appbar host window {hwnd:?}");
                return;
            }
            if let Some(bar) = self.bars.get_mut(&owner) {
                bar.registered = true;
            }
        }

        let applied = match query_and_set_position(hwnd, desired, edge, previous) {
            Some(rect) => {
                if previous.is_none_or(|old| !rect_equals(old, rect)) {
                    move_host_window(hwnd, rect);
                    AppBarHost::send(AppBarReservation {
                        hwnd: owner,
                        requested: to_core_rect(desired),
                        rect: to_core_rect(rect),
                    });
                }
                Some(rect)
            }
            None => None,
        };

        if let Some(bar) = self.bars.get_mut(&owner) {
            bar.applied = applied;
        }
    }

    fn reapply_all(&mut self) {
        let owners: Vec<isize> = self.bars.keys().copied().collect();
        for owner in owners {
            self.apply(owner);
        }
    }

    fn reregister_all(&mut self) {
        log::debug!("Explorer restarted, re-registering appbars");
        let owners: Vec<isize> = self.bars.keys().copied().collect();
        for owner in &owners {
            if let Some(bar) = self.bars.get_mut(owner) {
                bar.registered = false;
                bar.applied = None;
            }
        }
        for owner in owners {
            self.apply(owner);
        }
    }

    fn drop_bars_outside_monitors(&mut self) {
        let monitor_rects = monitor_rects();
        if monitor_rects.is_empty() {
            return;
        }

        let stale: Vec<isize> = self
            .bars
            .iter()
            .filter(|(_, bar)| !intersects_any_monitor(&bar.desired, &monitor_rects))
            .map(|(owner, _)| *owner)
            .collect();

        for owner in stale {
            log::debug!("Dropping appbar reservation outside every monitor");
            self.remove(owner);
        }
    }
}

struct HostBar {
    hwnd: HWND,
    desired: RECT,
    edge: AppBarEdge,
    registered: bool,
    applied: Option<RECT>,
    fullscreen_restore: Option<bool>,
}

fn host_thread(rx: Receiver<AppBarRequest>) {
    let Some(mut state) = HostState::new() else {
        log::error!("Failed to initialize appbar host thread");
        return;
    };

    // Create the thread message queue before publishing the thread id. Otherwise a
    // sender could post a wake before the queue exists (PostThreadMessage fails), leaving
    // its request unprocessed while this thread blocks in GetMessage.
    let mut msg = MSG::default();
    unsafe {
        let _ = PeekMessageW(&mut msg, None, 0, 0, PM_NOREMOVE);
    }

    // Publishing the thread id only after the state exists avoids waking a thread that
    // already exited; requests queued before this point are drained below.
    let _ = HOST_THREAD_ID.set(unsafe { GetCurrentThreadId() });
    state.drain(&rx);

    loop {
        let result = unsafe { GetMessageW(&mut msg, None, 0, 0) };
        if result.0 <= 0 {
            break;
        }
        if msg.message == WM_APP_BAR_WAKE {
            state.drain(&rx);
            continue;
        }
        unsafe {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

fn send(request: AppBarRequest) {
    if let Err(err) = REQUESTS.send(request) {
        log::error!("Failed to queue appbar request: {err}");
        return;
    }
    if let Some(thread_id) = HOST_THREAD_ID.get() {
        unsafe {
            let _ = PostThreadMessageW(*thread_id, WM_APP_BAR_WAKE, WPARAM(0), LPARAM(0));
        }
    }
}

fn install_cleanup_hook() {
    static HOOK: Once = Once::new();
    HOOK.call_once(|| {
        HookManager::subscribe(|(event, window)| {
            if event != WinEvent::ObjectDestroy {
                return;
            }
            AppBarHost::remove(window.address());
        });
    });
}

fn create_host_window() -> Option<HWND> {
    let class = &*APP_BAR_CLASS;
    let h_instance = WindowsApi::module_handle_w().ok()?;
    match unsafe {
        CreateWindowExW(
            WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            class.as_pcwstr(),
            PCWSTR::null(),
            WS_POPUP,
            -32000,
            -32000,
            0,
            0,
            None,
            None,
            Some(h_instance.into()),
            None,
        )
    } {
        Ok(hwnd) => Some(hwnd),
        Err(err) => {
            log::error!("Failed to create appbar host window: {err}");
            None
        }
    }
}

fn appbar_data(hwnd: HWND) -> APPBARDATA {
    APPBARDATA {
        cbSize: std::mem::size_of::<APPBARDATA>() as u32,
        hWnd: hwnd,
        ..Default::default()
    }
}

fn register_bar(hwnd: HWND) -> bool {
    let mut data = appbar_data(hwnd);
    data.uCallbackMessage = APP_BAR_CALLBACK;
    unsafe { SHAppBarMessage(ABM_NEW, &mut data) != 0 }
}

/// Queries the shell for an approved rectangle, restores the requested thickness and
/// applies it. Returns the rectangle the shell actually reserved.
fn query_and_set_position(
    hwnd: HWND,
    desired: RECT,
    edge: AppBarEdge,
    previous: Option<RECT>,
) -> Option<RECT> {
    let monitor = monitor_rect_for(&desired);
    let (proposed, thickness) = edge_request(desired, edge, monitor);
    let mut data = appbar_data(hwnd);
    data.uEdge = edge_to_shell(edge);
    data.rc = proposed;

    unsafe { SHAppBarMessage(ABM_QUERYPOS, &mut data) };
    data.rc = clamp_edge_thickness(data.rc, edge, thickness);

    // ABM_SETPOS notifies the other bars. Stop when a callback negotiated no change.
    if previous.is_some_and(|previous| rect_equals(previous, data.rc)) {
        return previous;
    }
    if unsafe { SHAppBarMessage(ABM_SETPOS, &mut data) } == 0 {
        log::error!("Failed to set appbar position");
        return None;
    }

    let rect = data.rc;
    if rect.right <= rect.left || rect.bottom <= rect.top {
        log::warn!("Shell returned an empty appbar rectangle");
        return None;
    }
    Some(rect)
}

fn move_host_window(hwnd: HWND, rect: RECT) {
    let width = rect.right - rect.left;
    let height = rect.bottom - rect.top;
    if let Err(err) = unsafe {
        SetWindowPos(
            hwnd,
            None,
            rect.left,
            rect.top,
            width,
            height,
            SWP_NOACTIVATE | SWP_NOZORDER,
        )
    } {
        log::warn!("Failed to move appbar host window: {err}");
    }
}

fn edge_to_shell(edge: AppBarEdge) -> u32 {
    match edge {
        AppBarEdge::Left => ABE_LEFT,
        AppBarEdge::Top => ABE_TOP,
        AppBarEdge::Right => ABE_RIGHT,
        AppBarEdge::Bottom => ABE_BOTTOM,
    }
}

/// The shell expects the proposal to span the whole edge of the monitor and then
/// subtracts occupied space. The perpendicular edges are taken from the monitor that
/// contains the requested rectangle, so negative/mixed-DPI monitor layouts work.
fn edge_request(desired: RECT, edge: AppBarEdge, monitor: RECT) -> (RECT, i32) {
    let thickness = edge_thickness(&desired, edge);

    let mut proposed = desired;
    match edge {
        AppBarEdge::Left | AppBarEdge::Right => {
            proposed.top = monitor.top;
            proposed.bottom = monitor.bottom;
        }
        AppBarEdge::Top | AppBarEdge::Bottom => {
            proposed.left = monitor.left;
            proposed.right = monitor.right;
        }
    }

    (proposed, thickness)
}

fn monitor_rect_for(rect: &RECT) -> RECT {
    let monitor = unsafe { MonitorFromRect(rect, MONITOR_DEFAULTTONEAREST) };
    WindowsApi::monitor_rect(monitor).unwrap_or(*rect)
}

fn to_win32_rect(rect: Rect) -> RECT {
    RECT {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
    }
}

fn to_core_rect(rect: RECT) -> Rect {
    Rect {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
    }
}

fn monitor_rects() -> Vec<RECT> {
    MonitorEnumerator::enumerate_win32()
        .map(|monitors| {
            monitors
                .into_iter()
                .filter_map(|monitor| monitor.rect().ok().map(to_win32_rect))
                .collect()
        })
        .unwrap_or_default()
}

fn edge_thickness(rect: &RECT, edge: AppBarEdge) -> i32 {
    match edge {
        AppBarEdge::Left | AppBarEdge::Right => rect.right - rect.left,
        AppBarEdge::Top | AppBarEdge::Bottom => rect.bottom - rect.top,
    }
}

/// The shell adjusts rectangles purely by subtraction and does not preserve their size,
/// so the requested thickness is restored on the anchored edge after `ABM_QUERYPOS`.
fn clamp_edge_thickness(mut rect: RECT, edge: AppBarEdge, thickness: i32) -> RECT {
    let thickness = thickness.max(0);
    match edge {
        AppBarEdge::Left => rect.right = rect.left + thickness,
        AppBarEdge::Right => rect.left = rect.right - thickness,
        AppBarEdge::Top => rect.bottom = rect.top + thickness,
        AppBarEdge::Bottom => rect.top = rect.bottom - thickness,
    }
    rect
}

fn rectangles_intersect(a: &RECT, b: &RECT) -> bool {
    a.left < a.right
        && a.top < a.bottom
        && b.left < b.right
        && b.top < b.bottom
        && a.left < b.right
        && a.right > b.left
        && a.top < b.bottom
        && a.bottom > b.top
}

fn intersects_any_monitor(rect: &RECT, monitors: &[RECT]) -> bool {
    monitors
        .iter()
        .any(|monitor| rectangles_intersect(rect, monitor))
}

fn rect_equals(a: RECT, b: RECT) -> bool {
    a.left == b.left && a.top == b.top && a.right == b.right && a.bottom == b.bottom
}

unsafe extern "system" fn host_window_proc(
    hwnd: HWND,
    msg: u32,
    w_param: WPARAM,
    l_param: LPARAM,
) -> LRESULT {
    unsafe {
        let taskbar_created = TASKBAR_CREATED_MESSAGE.load(Ordering::Relaxed);
        if taskbar_created != 0 && msg == taskbar_created {
            send(AppBarRequest::ShellRestart);
            return LRESULT(0);
        }

        match msg {
            APP_BAR_CALLBACK => {
                match w_param.0 as u32 {
                    ABN_POSCHANGED => send(AppBarRequest::ResyncAll),
                    ABN_FULLSCREENAPP => send(AppBarRequest::Fullscreen {
                        host: hwnd.0 as isize,
                        entering: l_param.0 != 0,
                    }),
                    _ => {}
                }
                LRESULT(0)
            }
            WM_WINDOWPOSCHANGED => {
                let mut data = appbar_data(hwnd);
                let _ = SHAppBarMessage(ABM_WINDOWPOSCHANGED, &mut data);
                DefWindowProcW(hwnd, msg, w_param, l_param)
            }
            WM_DISPLAYCHANGE => {
                send(AppBarRequest::DisplayChanged);
                DefWindowProcW(hwnd, msg, w_param, l_param)
            }
            _ => DefWindowProcW(hwnd, msg, w_param, l_param),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(left: i32, top: i32, right: i32, bottom: i32) -> RECT {
        RECT {
            left,
            top,
            right,
            bottom,
        }
    }

    #[test]
    fn edge_request_spans_the_monitor_of_the_requested_rect() {
        // A secondary monitor placed to the left of the primary one.
        let monitor = rect(-1920, 0, 0, 1080);
        let desired = rect(-1920, 1040, -640, 1080);
        let (proposed, thickness) = edge_request(desired, AppBarEdge::Bottom, monitor);
        assert_eq!(thickness, 40);
        assert_eq!(proposed.left, -1920);
        assert_eq!(proposed.right, 0);
        assert_eq!(proposed.top, 1040);
        assert_eq!(proposed.bottom, 1080);
    }

    #[test]
    fn vertical_strips_cover_the_screen_height() {
        let monitor = rect(0, 0, 1920, 1080);
        let desired = rect(0, 400, 56, 800);
        let (proposed, thickness) = edge_request(desired, AppBarEdge::Left, monitor);
        assert_eq!(thickness, 56);
        assert_eq!(proposed.left, 0);
        assert_eq!(proposed.right, 56);
        assert_eq!(proposed.top, 0);
        assert_eq!(proposed.bottom, 1080);
    }

    #[test]
    fn thickness_is_restored_after_the_shell_moves_the_edge() {
        // The taskbar already occupies the bottom edge, so QUERYPOS may return a rect
        // whose bottom was moved up. The bar must keep its requested thickness.
        let requested = rect(0, 964, 1280, 1024);
        let approved = rect(0, 940, 1280, 996);
        let final_rect = clamp_edge_thickness(approved, AppBarEdge::Bottom, 60);
        assert_eq!(final_rect.bottom, 996);
        assert_eq!(final_rect.top, 936);
        assert_eq!(final_rect.bottom - final_rect.top, 60);
        assert_eq!(final_rect.left, requested.left);
        assert_eq!(final_rect.right, requested.right);
    }

    #[test]
    fn top_and_horizontal_strips_keep_their_thickness() {
        let final_rect = clamp_edge_thickness(rect(0, 40, 1920, 200), AppBarEdge::Top, 32);
        assert_eq!(final_rect.top, 40);
        assert_eq!(final_rect.bottom, 72);
    }

    #[test]
    fn left_and_right_strips_keep_their_thickness() {
        let left = clamp_edge_thickness(rect(40, 0, 200, 1080), AppBarEdge::Left, 48);
        assert_eq!(left.right - left.left, 48);

        let right = clamp_edge_thickness(rect(1800, 0, 1920, 1080), AppBarEdge::Right, 64);
        assert_eq!(right.right - right.left, 64);
        assert_eq!(right.right, 1920);
    }

    #[test]
    fn intersection_requires_positive_area() {
        let screen = rect(0, 0, 1920, 1080);
        assert!(rectangles_intersect(&rect(0, 1040, 1920, 1080), &screen));
        assert!(!rectangles_intersect(&rect(0, 1080, 1920, 1120), &screen));
        assert!(!rectangles_intersect(&rect(1920, 0, 2200, 100), &screen));
        assert!(!rectangles_intersect(&rect(500, 500, 500, 600), &screen));
    }

    #[test]
    fn stale_reservations_are_only_dropped_when_no_monitor_contains_them() {
        let monitors = [rect(0, 0, 1920, 1080), rect(-1920, 0, 0, 1080)];
        assert!(intersects_any_monitor(
            &rect(-1920, 1040, -640, 1080),
            &monitors
        ));
        assert!(intersects_any_monitor(
            &rect(1800, 1040, 1920, 1080),
            &monitors
        ));
        // A bottom strip left behind after its monitor shrank no longer intersects.
        assert!(!intersects_any_monitor(
            &rect(-1920, 1080, -640, 1120),
            &monitors
        ));
        assert!(!intersects_any_monitor(
            &rect(1920, 0, 3840, 1080),
            &monitors
        ));
    }
}
