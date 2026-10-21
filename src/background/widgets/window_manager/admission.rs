use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

// Agent helpers often open a console for less than a second. Do not rearrange
// the desktop until it has survived this interval, including focus/name events.
const TERMINAL_SETTLE_TIME: Duration = Duration::from_millis(750);

#[derive(Default)]
pub(super) struct TerminalAdmission {
    pending: HashMap<isize, PendingTerminal>,
}

impl TerminalAdmission {
    pub fn observe(
        &mut self,
        hwnd: isize,
        process_id: u32,
        now: Instant,
    ) -> (PendingTerminal, bool) {
        if let Some(pending) = self.pending.get(&hwnd)
            && pending.process_id == process_id
        {
            return (*pending, false);
        }
        let pending = PendingTerminal {
            process_id,
            deadline: now + TERMINAL_SETTLE_TIME,
        };
        self.pending.insert(hwnd, pending);
        (pending, true)
    }

    pub fn contains(&self, hwnd: isize, pending: PendingTerminal) -> bool {
        self.pending.get(&hwnd) == Some(&pending)
    }

    pub fn remove(&mut self, hwnd: isize) {
        self.pending.remove(&hwnd);
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) struct PendingTerminal {
    pub process_id: u32,
    pub deadline: Instant,
}

pub(super) fn is_terminal_class(class: &str) -> bool {
    matches!(
        class,
        "ConsoleWindowClass" | "CASCADIA_HOSTING_WINDOW_CLASS"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_events_do_not_postpone_admission() {
        let mut admission = TerminalAdmission::default();
        let now = Instant::now();
        let (pending, first) = admission.observe(42, 100, now);
        assert!(first);
        assert_eq!(pending.deadline, now + TERMINAL_SETTLE_TIME);
        assert!(admission.observe(42, 100, now + Duration::from_millis(500)) == (pending, false));
        assert!(admission.observe(42, 100, pending.deadline) == (pending, false));
    }

    #[test]
    fn closed_and_reused_handles_invalidate_old_callbacks() {
        let mut admission = TerminalAdmission::default();
        let now = Instant::now();
        let (old, _) = admission.observe(42, 100, now);
        admission.remove(42);
        assert!(!admission.contains(42, old));

        let (new, _) = admission.observe(42, 100, now + Duration::from_millis(100));
        assert!(!admission.contains(42, old));
        assert!(admission.contains(42, new));

        let (reused, _) = admission.observe(42, 200, now + Duration::from_millis(200));
        assert!(!admission.contains(42, new));
        assert!(admission.contains(42, reused));
    }

    #[test]
    fn ordinary_apps_do_not_need_to_settle() {
        assert!(is_terminal_class("ConsoleWindowClass"));
        assert!(is_terminal_class("CASCADIA_HOSTING_WINDOW_CLASS"));
        assert!(!is_terminal_class("Chrome_WidgetWin_1"));
        assert!(!is_terminal_class("WinUIDesktopWin32WindowClass"));
    }
}
