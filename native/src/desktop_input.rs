//! Absolute mouse and keyboard injection for remote desktop sessions.
//!
//! This is deliberately independent from the edge-switching keyboard/mouse sharing state
//! machine. Both use Quartz, but a desktop session must not enter the edge-capture state or
//! conflict with an existing two-screen arrangement. A DesktopService session disables edge
//! sharing before this module is used.
use std::collections::BTreeSet;
use std::ffi::c_void;
use std::sync::{Mutex, OnceLock};

use core_foundation_sys::base::CFRelease;
use serde::Deserialize;

type Ref = *mut c_void;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Point {
    x: f64,
    y: f64,
}
#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn CGPreflightPostEventAccess() -> bool;
    fn CGRequestPostEventAccess() -> bool;
    fn CGWarpMouseCursorPosition(point: Point) -> i32;
    fn CGEventCreateMouseEvent(source: Ref, kind: u32, point: Point, button: u32) -> Ref;
    fn CGEventCreateKeyboardEvent(source: Ref, key: u16, down: bool) -> Ref;
    fn CGEventCreateScrollWheelEvent2(
        source: Ref,
        units: u32,
        count: u32,
        a: i32,
        b: i32,
        c: i32,
    ) -> Ref;
    fn CGEventSetFlags(event: Ref, flags: u64);
    fn CGEventSetIntegerValueField(event: Ref, field: u32, value: i64);
    fn CGEventPost(tap: u32, event: Ref);
}

const TAG: i64 = 0x4c41_4e46_4c59;
const FLAGS_MASK: u64 = 0x00ff_ffff;

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct WireInput {
    t: String,
    x: f64,
    y: f64,
    button: u16,
    down: bool,
    dx: f64,
    dy: f64,
    drag: u16,
    key: u16,
    flags: u64,
    clicks: i64,
}

#[derive(Clone, Copy)]
struct Bounds {
    origin_x: f64,
    origin_y: f64,
    width: f64,
    height: f64,
}

struct State {
    bounds: Bounds,
    keys: BTreeSet<u16>,
    buttons: BTreeSet<u16>,
}

fn main_bounds() -> Bounds {
    let (origin_x, origin_y, width, height) =
        crate::macos::display_bounds_tuple(crate::macos::main_display_id());
    Bounds {
        origin_x,
        origin_y,
        width: width.max(1.0),
        height: height.max(1.0),
    }
}

static STATE: OnceLock<Mutex<State>> = OnceLock::new();

fn state() -> &'static Mutex<State> {
    STATE.get_or_init(|| {
        Mutex::new(State {
            bounds: main_bounds(),
            keys: BTreeSet::new(),
            buttons: BTreeSet::new(),
        })
    })
}

pub fn accessible() -> bool {
    unsafe { AXIsProcessTrusted() || CGPreflightPostEventAccess() }
}

pub fn request_permissions() {
    unsafe {
        CGRequestPostEventAccess();
    }
}

fn post(event: Ref) {
    if event.is_null() {
        return;
    }
    unsafe {
        CGEventSetIntegerValueField(event, 42, TAG);
        CGEventPost(0, event);
        CFRelease(event as *const c_void);
    }
}

fn point_for(bounds: &Bounds, x: f64, y: f64) -> Point {
    let fx = x.clamp(0.0, 1.0);
    let fy = y.clamp(0.0, 1.0);
    Point {
        x: bounds.origin_x + fx * (bounds.width - 1.0).max(1.0),
        y: bounds.origin_y + fy * (bounds.height - 1.0).max(1.0),
    }
}

fn cg_button(button: u16) -> u32 {
    // Browser: 0 left, 1 middle, 2 right. Quartz: 0 left, 1 right, 2 center.
    match button {
        0 => 0,
        1 => 2,
        2 => 1,
        _ => button as u32,
    }
}

fn move_to(point: Point, kind: u32) {
    unsafe {
        // Absolute warp is required here: unlike edge sharing, the caller supplies a target
        // point rather than a relative delta.
        CGWarpMouseCursorPosition(point);
        let event = CGEventCreateMouseEvent(std::ptr::null_mut(), kind, point, 0);
        post(event);
    }
}

fn release_all(state: &mut State) {
    for key in std::mem::take(&mut state.keys) {
        unsafe {
            let event = CGEventCreateKeyboardEvent(std::ptr::null_mut(), key, false);
            if !event.is_null() {
                CGEventSetFlags(event, 0);
            }
            post(event);
        }
    }
    for button in std::mem::take(&mut state.buttons) {
        unsafe {
            let kind = match button {
                0 => 2,
                2 => 4,
                _ => 26,
            };
            let event = CGEventCreateMouseEvent(
                std::ptr::null_mut(),
                kind,
                point_for(&state.bounds, 0.5, 0.5),
                cg_button(button),
            );
            post(event);
        }
    }
}

pub fn reset() {
    let mut state = state().lock().unwrap();
    release_all(&mut state);
}

pub fn handle(value: &str) -> Result<(), String> {
    if value.len() > 4096 {
        return Err("DESKTOP_INPUT_INVALID".into());
    }
    if !accessible() {
        return Err("DESKTOP_INPUT_PERMISSION".into());
    }
    let input: WireInput = serde_json::from_str(value).map_err(|_| "DESKTOP_INPUT_INVALID")?;
    let mut state = state().lock().unwrap();
    state.bounds = main_bounds();
    let bounds = state.bounds;
    match input.t.as_str() {
        "move" => {
            if !input.x.is_finite() || !input.y.is_finite() || input.drag > 3 {
                return Err("DESKTOP_INPUT_INVALID".into());
            }
            let kind = match input.drag {
                1 => 6,
                2 => 7,
                3 => 27,
                _ => 5,
            };
            move_to(point_for(&bounds, input.x, input.y), kind);
        }
        "button" => {
            if !input.x.is_finite()
                || !input.y.is_finite()
                || input.button > 31
                || !(0..=3).contains(&input.clicks)
            {
                return Err("DESKTOP_INPUT_INVALID".into());
            }
            let point = point_for(&bounds, input.x, input.y);
            move_to(point, 5);
            let kind = match (input.button, input.down) {
                (0, true) => 1,
                (0, false) => 2,
                (2, true) => 3,
                (2, false) => 4,
                (_, true) => 25,
                (_, false) => 26,
            };
            if input.down {
                state.buttons.insert(input.button);
            } else {
                state.buttons.remove(&input.button);
            }
            unsafe {
                let event = CGEventCreateMouseEvent(
                    std::ptr::null_mut(),
                    kind,
                    point,
                    cg_button(input.button),
                );
                // A single click is the common case; double-click is expressed by two events.
                if !event.is_null() {
                    CGEventSetIntegerValueField(event, 1, input.clicks.max(1));
                }
                post(event);
            }
        }
        "wheel" => {
            if !input.x.is_finite()
                || !input.y.is_finite()
                || !input.dx.is_finite()
                || !input.dy.is_finite()
                || input.dx.abs() > 1000.0
                || input.dy.abs() > 1000.0
            {
                return Err("DESKTOP_INPUT_INVALID".into());
            }
            let point = point_for(&bounds, input.x, input.y);
            move_to(point, 5);
            unsafe {
                // Browser wheel deltaY is positive when scrolling down; Quartz uses the
                // opposite sign for a positive wheel delta.
                let event = CGEventCreateScrollWheelEvent2(
                    std::ptr::null_mut(),
                    0,
                    2,
                    input.dx.round() as i32,
                    (-input.dy).round() as i32,
                    0,
                );
                post(event);
            }
        }
        "key" => {
            if input.key > 127 || input.flags & !FLAGS_MASK != 0 {
                return Err("DESKTOP_INPUT_INVALID".into());
            }
            if input.down {
                state.keys.insert(input.key);
            } else {
                state.keys.remove(&input.key);
            }
            unsafe {
                let event = CGEventCreateKeyboardEvent(std::ptr::null_mut(), input.key, input.down);
                if !event.is_null() {
                    CGEventSetFlags(event, input.flags);
                }
                post(event);
            }
        }
        "release" => release_all(&mut state),
        _ => return Err("DESKTOP_INPUT_INVALID".into()),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_wire_events_without_posting() {
        assert!(handle(r#"{"t":"move","x":"nope"}"#).is_err());
        assert!(handle(r#"{"t":"key","key":9999}"#).is_err());
        assert!(handle(r#"{"t":"bogus"}"#).is_err());
    }
}
