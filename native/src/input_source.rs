//! Input-source switching is an action, not a synthetic flagsChanged notification.
use std::time::{Duration, Instant};

pub trait Backend {
    type Source: Clone + PartialEq;
    fn current(&mut self) -> Option<Self::Source>;
    fn ascii(&mut self) -> Option<Self::Source>;
    fn enabled(&mut self) -> Vec<Self::Source>;
    fn is_ascii(&self, source: &Self::Source) -> bool;
    fn select(&mut self, source: &Self::Source) -> bool;
    fn switch(&mut self, source: &Self::Source) -> bool {
        self.select(source)
    }
}

pub struct Controller<S> {
    local: Option<S>,
    remote: bool,
    guard_until: Option<Instant>,
    last_snapshot: Option<Instant>,
    non_ascii: Option<S>,
}
impl<S: Clone + PartialEq> Default for Controller<S> {
    fn default() -> Self {
        Self {
            local: None,
            remote: false,
            guard_until: None,
            last_snapshot: None,
            non_ascii: None,
        }
    }
}
impl<S: Clone + PartialEq> Controller<S> {
    /// End a DOM-focused capture without carrying its grace window into another app.
    pub fn finish(&mut self, restore: bool, backend: &mut impl Backend<Source = S>) -> bool {
        let result = !restore || self.restore(backend);
        self.remote = false;
        self.guard_until = None;
        self.local = backend.current();
        self.last_snapshot = Some(Instant::now());
        result
    }
    /// macOS may switch the server's input source before its HID notification is
    /// delivered. Keep the original source, including a short guard for delayed changes.
    pub fn capture(
        &mut self,
        remote: bool,
        switching: bool,
        now: Instant,
        backend: &mut impl Backend<Source = S>,
    ) -> bool {
        if !remote {
            if self.remote {
                self.remote = false;
                self.guard_until = Some(now + Duration::from_millis(500));
            }
            if self.guard_until.is_some_and(|until| now <= until) {
                return self.restore(backend);
            }
            self.guard_until = None;
            if self
                .last_snapshot
                .is_none_or(|last| now.duration_since(last) >= Duration::from_millis(100))
            {
                self.local = backend.current();
                self.last_snapshot = Some(now);
            }
            return self.local.is_some();
        }
        if !self.remote {
            // If entering and pressing Caps Lock landed in one batch, retain the
            // last local snapshot: the current source may already have changed.
            if !switching || self.local.is_none() {
                self.local = backend.current();
            }
            self.remote = true;
        }
        // Caps can change the OS source without delivering a recognizable tap event.
        // Preserve the source for the entire capture, not just after a notification.
        self.restore(backend)
    }
    fn restore(&self, backend: &mut impl Backend<Source = S>) -> bool {
        match (&self.local, backend.current()) {
            (Some(original), Some(current)) if original != &current => backend.select(original),
            (Some(_), Some(_)) => true,
            _ => false,
        }
    }
    /// Select the client's own last non-Latin source / last ASCII source. Never
    /// install a layout, change preferences, or copy a source identifier from the server.
    pub fn toggle(&mut self, backend: &mut impl Backend<Source = S>) -> bool {
        let Some(current) = backend.current() else {
            return false;
        };
        let enabled = backend.enabled();
        let target = if backend.is_ascii(&current) {
            self.non_ascii
                .as_ref()
                .filter(|s| enabled.contains(s) && !backend.is_ascii(s))
                .cloned()
                .or_else(|| enabled.iter().find(|s| !backend.is_ascii(s)).cloned())
        } else {
            self.non_ascii = Some(current.clone());
            backend
                .ascii()
                .filter(|s| *s != current && enabled.contains(s) && backend.is_ascii(s))
                .or_else(|| enabled.iter().find(|s| backend.is_ascii(s)).cloned())
        };
        target.is_none_or(|source| backend.switch(&source))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fake {
        current: u8,
        sources: Vec<u8>,
        selections: Vec<u8>,
    }
    impl Backend for Fake {
        type Source = u8;
        fn current(&mut self) -> Option<u8> {
            Some(self.current)
        }
        fn ascii(&mut self) -> Option<u8> {
            Some(0)
        }
        fn enabled(&mut self) -> Vec<u8> {
            self.sources.clone()
        }
        fn is_ascii(&self, s: &u8) -> bool {
            *s == 0
        }
        fn select(&mut self, s: &u8) -> bool {
            self.current = *s;
            self.selections.push(*s);
            true
        }
    }
    fn backend(current: u8) -> Fake {
        Fake {
            current,
            sources: vec![0, 1, 2],
            selections: vec![],
        }
    }
    #[test]
    fn preserves_server_source_when_caps_notification_arrives_after_the_os_switch() {
        let mut controller = Controller::default();
        let mut b = backend(1);
        let now = Instant::now();
        assert!(controller.capture(false, false, now, &mut b));
        b.current = 0;
        assert!(controller.capture(true, true, now + Duration::from_millis(4), &mut b));
        assert_eq!(b.current, 1);
        assert_eq!(b.selections, vec![1]);
    }
    #[test]
    fn restores_a_delayed_server_switch_but_leaves_normal_local_switches_alone() {
        let mut controller = Controller::default();
        let mut b = backend(1);
        let now = Instant::now();
        controller.capture(true, false, now, &mut b);
        controller.capture(true, true, now, &mut b);
        b.current = 0;
        controller.capture(true, false, now + Duration::from_millis(20), &mut b);
        assert_eq!(b.current, 1);
        controller.capture(false, false, now + Duration::from_secs(1), &mut b);
        b.current = 0;
        controller.capture(false, false, now + Duration::from_secs(2), &mut b);
        assert_eq!(b.current, 0);
    }
    #[test]
    fn switches_clients_own_sources_and_remembers_its_last_non_ascii_source() {
        let mut controller = Controller::default();
        let mut b = backend(2);
        assert!(controller.toggle(&mut b));
        assert_eq!(b.current, 0);
        assert!(controller.toggle(&mut b));
        assert_eq!(b.current, 2);
        b.sources = vec![0, 1];
        b.current = 0;
        assert!(controller.toggle(&mut b));
        assert_eq!(b.current, 1);
    }
    #[test]
    fn a_single_source_is_a_noop() {
        let mut controller = Controller::default();
        let mut b = backend(0);
        b.sources = vec![0];
        assert!(controller.toggle(&mut b));
        assert!(b.selections.is_empty());
    }
    #[test]
    fn restores_during_capture_without_a_caps_notification_and_after_exit() {
        let mut controller = Controller::default();
        let mut b = backend(1);
        let now = Instant::now();
        controller.capture(true, false, now, &mut b);
        b.current = 0;
        assert!(controller.capture(true, false, now + Duration::from_secs(2), &mut b));
        assert_eq!(b.current, 1);
        controller.capture(false, false, now + Duration::from_secs(3), &mut b);
        b.current = 0;
        controller.capture(false, false, now + Duration::from_millis(3100), &mut b);
        assert_eq!(b.current, 1);
        controller.capture(false, false, now + Duration::from_secs(4), &mut b);
        b.current = 0;
        controller.capture(false, false, now + Duration::from_secs(5), &mut b);
        assert_eq!(b.current, 0);
    }
    #[test]
    fn losing_foreground_does_not_overwrite_the_new_apps_source() {
        let mut controller = Controller::default();
        let mut b = backend(1);
        let now = Instant::now();
        controller.capture(true, false, now, &mut b);
        b.current = 0;
        assert!(controller.finish(false, &mut b));
        assert_eq!(b.current, 0);
        assert!(b.selections.is_empty());
    }
}
