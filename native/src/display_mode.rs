//! A session temporarily selects an existing macOS display mode. Never creates modes.
use core_foundation_sys::array::{CFArrayGetCount, CFArrayGetValueAtIndex};
use core_foundation_sys::base::CFRelease;
use core_foundation_sys::dictionary::{
    CFDictionaryCreate, kCFTypeDictionaryKeyCallBacks, kCFTypeDictionaryValueCallBacks,
};
use core_foundation_sys::number::kCFBooleanTrue;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::ffi::c_void;

type Ref = *mut c_void;
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    static kCGDisplayShowDuplicateLowResolutionModes: Ref;
    fn CGMainDisplayID() -> u32;
    fn CGDisplayIsOnline(display: u32) -> u32;
    fn CGDisplayCopyDisplayMode(display: u32) -> Ref;
    fn CGDisplayCopyAllDisplayModes(display: u32, options: Ref) -> Ref;
    fn CGDisplayModeGetWidth(mode: Ref) -> usize;
    fn CGDisplayModeGetHeight(mode: Ref) -> usize;
    fn CGDisplayModeGetPixelWidth(mode: Ref) -> usize;
    fn CGDisplayModeGetPixelHeight(mode: Ref) -> usize;
    fn CGDisplayModeGetRefreshRate(mode: Ref) -> f64;
    fn CGDisplayModeGetIODisplayModeID(mode: Ref) -> u32;
    fn CGDisplayModeIsUsableForDesktopGUI(mode: Ref) -> bool;
    fn CGDisplaySetDisplayMode(display: u32, mode: Ref, options: Ref) -> i32;
}

struct Owned(Ref);
impl Drop for Owned {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0) };
        }
    }
}
#[derive(Clone, Copy, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Resolution {
    pub width: usize,
    pub height: usize,
}
fn dimensions(mode: Ref) -> (usize, usize) {
    unsafe { (CGDisplayModeGetWidth(mode), CGDisplayModeGetHeight(mode)) }
}
fn mode_list(display: u32) -> Owned {
    // Without this option macOS can omit the current Retina mode and all smaller
    // logical sizes, despite the option's historical "low resolution" name.
    let options = Owned(unsafe {
        let key = kCGDisplayShowDuplicateLowResolutionModes as *const c_void;
        let value = kCFBooleanTrue as *const c_void;
        CFDictionaryCreate(
            std::ptr::null(),
            &key,
            &value,
            1,
            &kCFTypeDictionaryKeyCallBacks,
            &kCFTypeDictionaryValueCallBacks,
        )
        .cast_mut()
        .cast()
    });
    Owned(unsafe { CGDisplayCopyAllDisplayModes(display, options.0) })
}
fn entries(list: &Owned) -> impl Iterator<Item = Ref> + '_ {
    let count = if list.0.is_null() {
        0
    } else {
        unsafe { CFArrayGetCount(list.0.cast()) }
    };
    (0..count).map(|i| unsafe { CFArrayGetValueAtIndex(list.0.cast(), i).cast_mut() })
}
fn mode_score(mode: Ref, current: Ref) -> f64 {
    unsafe {
        let scale =
            CGDisplayModeGetPixelWidth(current) as f64 / CGDisplayModeGetWidth(current) as f64;
        let density = CGDisplayModeGetPixelWidth(mode) as f64 / CGDisplayModeGetWidth(mode) as f64;
        (density - scale).abs() * 1000.0
            + (CGDisplayModeGetRefreshRate(mode) - CGDisplayModeGetRefreshRate(current)).abs()
    }
}
fn mode_json(mode: Ref) -> Value {
    let (width, height) = dimensions(mode);
    json!({"width":width,"height":height,"pixelWidth":unsafe {CGDisplayModeGetPixelWidth(mode)},"pixelHeight":unsafe {CGDisplayModeGetPixelHeight(mode)}})
}
pub fn info() -> Value {
    let display = unsafe { CGMainDisplayID() };
    let current = Owned(unsafe { CGDisplayCopyDisplayMode(display) });
    if current.0.is_null() {
        return json!({"supported":false,"modes":[]});
    }
    let list = mode_list(display);
    let mut modes: BTreeMap<(usize, usize), Ref> = BTreeMap::new();
    for mode in entries(&list) {
        let (w, h) = dimensions(mode);
        if unsafe { CGDisplayModeIsUsableForDesktopGUI(mode) }
            && (640..=7680).contains(&w)
            && (480..=4320).contains(&h)
        {
            let candidate = modes.entry((w, h)).or_insert(mode);
            if mode_score(mode, current.0) < mode_score(*candidate, current.0) {
                *candidate = mode;
            }
        }
    }
    json!({"supported":!modes.is_empty(),"current":mode_json(current.0),"modes":modes.into_values().map(mode_json).collect::<Vec<_>>()})
}

/// Retained mode references are stored as integers so the lease can live in the
/// shared session. Selection/restoration happens only during synchronous start/stop.
pub struct DisplayLease {
    display: u32,
    original: usize,
    selected: u32,
}
impl DisplayLease {
    pub fn apply(resolution: Option<Resolution>) -> Result<Option<Self>, String> {
        let Some(resolution) = resolution else {
            return Ok(None);
        };
        let display = unsafe { CGMainDisplayID() };
        let current = Owned(unsafe { CGDisplayCopyDisplayMode(display) });
        if current.0.is_null() {
            return Err("DESKTOP_NO_DISPLAY".into());
        }
        if dimensions(current.0) == (resolution.width, resolution.height) {
            return Ok(None);
        }
        let list = mode_list(display);
        let target = entries(&list)
            .filter(|mode| {
                dimensions(*mode) == (resolution.width, resolution.height)
                    && unsafe { CGDisplayModeIsUsableForDesktopGUI(*mode) }
            })
            .min_by(|a, b| mode_score(*a, current.0).total_cmp(&mode_score(*b, current.0)))
            .ok_or("DESKTOP_RESOLUTION_UNSUPPORTED")?;
        let selected = unsafe { CGDisplayModeGetIODisplayModeID(target) };
        if unsafe { CGDisplaySetDisplayMode(display, target, std::ptr::null_mut()) } != 0 {
            return Err("DESKTOP_RESOLUTION_FAILED".into());
        }
        let original = current.0 as usize;
        std::mem::forget(current);
        let lease = Self {
            display,
            original,
            selected,
        };
        let actual = Owned(unsafe { CGDisplayCopyDisplayMode(display) });
        if actual.0.is_null() || dimensions(actual.0) != (resolution.width, resolution.height) {
            drop(lease);
            return Err("DESKTOP_RESOLUTION_FAILED".into());
        }
        Ok(Some(lease))
    }
}
impl Drop for DisplayLease {
    fn drop(&mut self) {
        let original = Owned(self.original as Ref);
        if unsafe { CGDisplayIsOnline(self.display) } == 0 {
            return;
        }
        let current = Owned(unsafe { CGDisplayCopyDisplayMode(self.display) });
        // Respect a mode the controlled user selected during the session.
        if !current.0.is_null()
            && unsafe { CGDisplayModeGetIODisplayModeID(current.0) } == self.selected
        {
            let result =
                unsafe { CGDisplaySetDisplayMode(self.display, original.0, std::ptr::null_mut()) };
            if result != 0 {
                eprintln!("[lanfly:desktop] restore display mode failed: {result}");
            }
        }
    }
}
