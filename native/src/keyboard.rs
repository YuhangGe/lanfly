//! macOS flagsChanged includes both held modifiers and input-source notifications.
use std::time::{Duration, Instant};

pub const FLAGS_MASK: u64 = 0x01ff_ffff;
pub const INPUT_SOURCE_KEY: u16 = 0xff;

#[derive(Default)]
pub struct InputSourceKey {
    pressed: bool,
    caps_lock: Option<bool>,
    last_action: Option<(Instant, u16)>,
}
impl InputSourceKey {
    /// One action per physical press, ignoring the release and duplicate notifications.
    pub fn update(&mut self, kind: u32, key: u16, flags: u64) -> Option<bool> {
        self.update_at(kind, key, flags, Instant::now())
    }

    /// Fallback for peers/devices without raw HID observation. Stateless Caps flags
    /// describe physical edges; AlphaShift alone describes a latched lock state.
    /// Only coalesce different key codes that represent the same notification.
    pub fn update_at(&mut self, kind: u32, key: u16, flags: u64, now: Instant) -> Option<bool> {
        if !matches!(key, 57 | INPUT_SOURCE_KEY) || !matches!(kind, 10..=12) {
            return None;
        }
        let alpha = flags & (1 << 16) != 0;
        let toggle = if kind == 10 || (kind == 12 && flags & 0x0100_0080 != 0) {
            let edge = !self.pressed;
            self.pressed = true;
            self.caps_lock = Some(alpha);
            edge
        } else if kind == 11 || key == INPUT_SOURCE_KEY || self.pressed {
            self.pressed = false;
            self.caps_lock = Some(alpha);
            false
        } else {
            let changed = self.caps_lock != Some(alpha);
            self.caps_lock = Some(alpha);
            changed
        };
        if toggle {
            if self.last_action.is_some_and(|(last, code)| {
                code != key && now.duration_since(last) < Duration::from_millis(50)
            }) {
                return Some(false);
            }
            self.last_action = Some((now, key));
        }
        Some(toggle)
    }
}

pub fn valid_key(kind: u32, key: u16) -> bool {
    key <= 127 || (kind == 12 && key == INPUT_SOURCE_KEY)
}

pub fn held_key(kind: u32, key: u16, flags: u64) -> Option<bool> {
    match kind {
        10 => Some(true),
        11 => Some(false),
        12 => {
            // Caps Lock and the CJK input-source toggle are state changes, not
            // modifiers that must stay pressed until a later key-up arrives.
            if key == 57 || key == INPUT_SOURCE_KEY {
                return Some(false);
            }
            let (mask, device, devices) = match key {
                56 => (1 << 17, 0x02, 0x06),
                60 => (1 << 17, 0x04, 0x06),
                59 => (1 << 18, 0x01, 0x2001),
                62 => (1 << 18, 0x2000, 0x2001),
                58 => (1 << 19, 0x20, 0x60),
                61 => (1 << 19, 0x40, 0x60),
                55 => (1 << 20, 0x08, 0x18),
                54 => (1 << 20, 0x10, 0x18),
                63 => return Some(flags & (1 << 23) != 0),
                _ => return None,
            };
            // Prefer device-specific flags when supplied (e.g. release left
            // Shift while right Shift remains down). Synthetic events may have
            // only the aggregate modifier bit, so retain that fallback.
            Some(if flags & devices != 0 {
                flags & device != 0
            } else {
                flags & mask != 0
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_input_source_notification_but_not_arbitrary_extended_keys() {
        assert!(valid_key(12, INPUT_SOURCE_KEY));
        assert!(!valid_key(10, INPUT_SOURCE_KEY));
        assert!(!valid_key(11, INPUT_SOURCE_KEY));
        assert!(!valid_key(12, 0xfe));
        assert!(!valid_key(12, 0xffff));
    }
    #[test]
    fn input_source_press_is_forwarded_once_without_forwarding_its_release() {
        let mut key = InputSourceKey::default();
        assert_eq!(key.update(12, INPUT_SOURCE_KEY, 0x0100_0080), Some(true));
        assert_eq!(key.update(12, INPUT_SOURCE_KEY, 0x0100_0080), Some(false));
        assert_eq!(key.update(12, INPUT_SOURCE_KEY, 0), Some(false));
        assert_eq!(key.update(12, INPUT_SOURCE_KEY, 0x0100_0080), Some(true));
    }
    #[test]
    fn stateless_caps_release_does_not_toggle_even_after_a_long_hold() {
        let mut key = InputSourceKey::default();
        let now = Instant::now();
        assert_eq!(key.update_at(12, 57, 0x0100_0080, now), Some(true));
        assert_eq!(
            key.update_at(12, 57, 0, now + Duration::from_millis(500)),
            Some(false)
        );
        assert_eq!(key.update_at(12, 56, 1 << 17, now), None);
        assert_eq!(
            key.update_at(12, 57, 0x0100_0080, now + Duration::from_millis(600)),
            Some(true)
        );
        assert_eq!(
            key.update_at(12, 57, 0, now + Duration::from_millis(604)),
            Some(false)
        );
    }
    #[test]
    fn quick_presses_and_latched_caps_transitions_are_not_debounced_away() {
        let mut key = InputSourceKey::default();
        let now = Instant::now();
        assert_eq!(key.update_at(12, 57, 1 << 16, now), Some(true));
        assert_eq!(key.update_at(12, 57, 1 << 16, now), Some(false));
        assert_eq!(
            key.update_at(12, 57, 0, now + Duration::from_millis(100)),
            Some(true)
        );
        let mut key = InputSourceKey::default();
        assert_eq!(key.update_at(12, 57, 0x0100_0080, now), Some(true));
        assert_eq!(
            key.update_at(12, 57, 0, now + Duration::from_millis(10)),
            Some(false)
        );
        assert_eq!(
            key.update_at(12, 57, 0x0100_0080, now + Duration::from_millis(100)),
            Some(true)
        );
    }
    #[test]
    fn caps_and_input_source_companion_notifications_produce_one_action() {
        let mut key = InputSourceKey::default();
        let now = Instant::now();
        assert_eq!(key.update_at(12, 57, 1 << 16, now), Some(true));
        assert_eq!(
            key.update_at(
                12,
                INPUT_SOURCE_KEY,
                0x0100_0080,
                now + Duration::from_millis(4)
            ),
            Some(false)
        );
        assert_eq!(
            key.update_at(12, INPUT_SOURCE_KEY, 0, now + Duration::from_millis(8)),
            Some(false)
        );
    }
    #[test]
    fn preserves_stateless_caps_lock_flags() {
        // NX_ALPHASHIFT_STATELESS_MASK | NX_DEVICE_ALPHASHIFT_STATELESS_MASK
        let flags = 0x0100_0080;
        assert_eq!(flags & FLAGS_MASK, flags);
        assert_eq!(held_key(12, INPUT_SOURCE_KEY, flags), Some(false));
        assert_eq!(held_key(12, 57, 1 << 16), Some(false));
        assert_eq!(
            held_key(12, INPUT_SOURCE_KEY, flags | (1 << 20)),
            Some(false)
        );
    }
    #[test]
    fn tracks_the_changed_modifier_instead_of_any_remaining_modifier() {
        assert_eq!(held_key(12, 56, 1 << 20), Some(false));
        assert_eq!(held_key(12, 55, 1 << 20), Some(true));
        assert_eq!(held_key(12, 56, (1 << 17) | 0x04), Some(false));
        assert_eq!(held_key(12, 60, (1 << 17) | 0x04), Some(true));
        assert_eq!(held_key(10, 0, 0), Some(true));
        assert_eq!(held_key(11, 0, 1 << 17), Some(false));
    }
}
