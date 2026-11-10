//! Balance cursor capture even when a macOS call fails partway through a switch.
pub trait CursorBackend {
    fn background_control(&mut self) -> bool;
    fn hide(&mut self) -> bool;
    fn connect_mouse(&mut self, connected: bool) -> bool;
    fn restore_position(&mut self);
    fn show(&mut self);
}

#[derive(Default)]
pub struct CursorCapture {
    hidden: bool,
    detached: bool,
}

impl CursorCapture {
    pub fn acquire(&mut self, backend: &mut impl CursorBackend) -> bool {
        if self.detached {
            return true;
        }
        if !backend.background_control() {
            return false;
        }
        if !backend.hide() {
            self.release(backend);
            return false;
        }
        self.hidden = true;
        // Do not warp on entry: macOS folds that artificial displacement into a
        // subsequent relative-motion event, immediately pushing the client back
        // over its entry edge. Hiding before detaching does not add such motion.
        self.detached = true;
        if !backend.connect_mouse(false) {
            self.release(backend);
            return false;
        }
        true
    }

    pub fn release(&mut self, backend: &mut impl CursorBackend) {
        if self.detached {
            backend.connect_mouse(true);
            backend.restore_position();
            self.detached = false;
        }
        if self.hidden {
            backend.show();
            self.hidden = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default)]
    struct Backend {
        calls: Vec<&'static str>,
        fail: &'static str,
    }
    impl Backend {
        fn call(&mut self, name: &'static str) -> bool {
            self.calls.push(name);
            self.fail != name
        }
    }
    impl CursorBackend for Backend {
        fn background_control(&mut self) -> bool {
            self.call("background")
        }
        fn hide(&mut self) -> bool {
            self.call("hide")
        }
        fn connect_mouse(&mut self, connected: bool) -> bool {
            self.call(if connected { "connect" } else { "detach" })
        }
        fn restore_position(&mut self) {
            self.call("restore");
        }
        fn show(&mut self) {
            self.call("show");
        }
    }
    #[test]
    fn capture_does_not_warp_on_entry_and_restores_exactly_once() {
        let mut capture = CursorCapture::default();
        let mut backend = Backend::default();
        assert!(capture.acquire(&mut backend));
        assert!(capture.acquire(&mut backend));
        capture.release(&mut backend);
        capture.release(&mut backend);
        assert_eq!(
            backend.calls,
            ["background", "hide", "detach", "connect", "restore", "show"]
        );
    }
    #[test]
    fn background_failure_does_not_move_or_hide_the_cursor() {
        let mut capture = CursorCapture::default();
        let mut backend = Backend {
            fail: "background",
            ..Default::default()
        };
        assert!(!capture.acquire(&mut backend));
        capture.release(&mut backend);
        assert_eq!(backend.calls, ["background"]);
    }
    #[test]
    fn hide_failure_does_not_move_cursor_or_unbalance_hide_count() {
        let mut capture = CursorCapture::default();
        let mut backend = Backend {
            fail: "hide",
            ..Default::default()
        };
        assert!(!capture.acquire(&mut backend));
        capture.release(&mut backend);
        assert_eq!(backend.calls, ["background", "hide"]);
    }
    #[test]
    fn capture_failure_restores_local_mouse_and_visibility() {
        let mut capture = CursorCapture::default();
        let mut backend = Backend {
            fail: "detach",
            ..Default::default()
        };
        assert!(!capture.acquire(&mut backend));
        capture.release(&mut backend);
        assert_eq!(
            backend.calls,
            ["background", "hide", "detach", "connect", "restore", "show"]
        );
    }
}
