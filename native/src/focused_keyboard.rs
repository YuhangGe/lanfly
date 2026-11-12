//! Keyboard-only capture while a browser stage owns focus. No cursor/edge state.
use crate::keyboard::{InputSourceKey, held_key, valid_key};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::time::{Duration, Instant};

const LEASE: Duration = Duration::from_millis(750);
const CAPS_FLAGS: u64 = 0x0101_0080;

#[derive(Default)]
pub struct FocusedKeyboard {
    deadline: Option<Instant>,
    pid: i32,
    ignored: BTreeSet<u16>,
    source: InputSourceKey,
    events: Vec<Value>,
}
impl FocusedKeyboard {
    pub fn owner_pid(&self) -> i32 {
        self.pid
    }
    pub fn start(&mut self, now: Instant, pid: i32, held: BTreeSet<u16>) {
        self.deadline = Some(now + LEASE);
        self.pid = pid;
        self.ignored = held;
        self.source = InputSourceKey::default();
        self.events.clear();
    }
    pub fn active(&mut self, now: Instant, pid: i32) -> bool {
        if self
            .deadline
            .is_some_and(|until| now <= until && pid == self.pid && pid != 0)
        {
            true
        } else {
            self.stop();
            false
        }
    }
    pub fn renew(&mut self, now: Instant, pid: i32) -> bool {
        let active = self.active(now, pid);
        if active {
            self.deadline = Some(now + LEASE);
        }
        active
    }
    pub fn stop(&mut self) {
        if self.deadline.take().is_some() {
            self.events.clear();
            self.events.push(json!({"t":"release"}));
            self.ignored.clear();
        }
    }
    pub fn source_press(&mut self) {
        if self.events.len() >= 1024 {
            self.stop();
            return;
        }
        self.events.push(json!({"t":"source"}));
    }
    /// Returns true when the original event should be suppressed locally.
    pub fn key(&mut self, kind: u32, key: u16, flags: u64, raw_caps: bool) -> bool {
        if !valid_key(kind, key) {
            return false;
        }
        if self.ignored.contains(&key) {
            if held_key(kind, key, flags) == Some(false) {
                self.ignored.remove(&key);
            }
            return false;
        }
        if raw_caps && matches!(key, 57 | 255) {
            return true;
        }
        if let Some(switching) = self.source.update(kind, key, flags) {
            if switching {
                self.source_press();
            }
            return true;
        }
        if self.events.len() >= 1024 {
            self.stop();
            return false;
        }
        if let Some(down) = held_key(kind, key, flags) {
            self.events.push(json!({"t":"key", "key":key, "down":down, "flags":flags & 0x00ff_ffff & !CAPS_FLAGS}));
        }
        true
    }
    pub fn take(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.events)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_and_following_keys_share_one_ordered_queue() {
        let mut capture = FocusedKeyboard::default();
        capture.start(Instant::now(), 42, BTreeSet::new());
        capture.source_press();
        assert!(capture.key(12, 57, 0x0100_0080, true));
        assert!(capture.key(10, 0, 1 << 16, true));
        assert!(capture.key(11, 0, 0, true));
        let events = capture.take();
        assert_eq!(events.len(), 3);
        assert_eq!(events[0]["t"], "source");
        assert_eq!(events[1]["down"], true);
        assert_eq!(events[1]["flags"], 0);
        assert_eq!(events[2]["down"], false);
    }
    #[test]
    fn focus_change_and_expiry_release_and_cannot_be_renewed() {
        let mut capture = FocusedKeyboard::default();
        let now = Instant::now();
        capture.start(now, 42, BTreeSet::new());
        assert!(!capture.renew(now, 43));
        assert_eq!(capture.take(), vec![json!({"t":"release"})]);
        assert!(!capture.renew(now, 42));
        capture.start(now, 42, BTreeSet::new());
        assert!(!capture.active(now + Duration::from_secs(1), 42));
        assert_eq!(capture.take(), vec![json!({"t":"release"})]);
    }
    #[test]
    fn key_held_before_focus_finishes_locally() {
        let mut capture = FocusedKeyboard::default();
        capture.start(Instant::now(), 42, BTreeSet::from([48]));
        assert!(!capture.key(11, 48, 0, true));
        assert!(capture.take().is_empty());
        assert!(capture.key(10, 48, 0, true));
        assert_eq!(capture.take().len(), 1);
    }
}
