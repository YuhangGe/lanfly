//! Quartz events stay on a native run-loop thread. No JS callback runs in an event tap.
//! A native watchdog restores local input even when Node stops polling or stalls.
use crate::cursor::{CursorBackend, CursorCapture};
use crate::keyboard::{FLAGS_MASK, InputSourceKey, held_key, valid_key};
use crate::macos_input_source;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::ffi::{c_char, c_void};
use std::ptr::null_mut;
use std::sync::{Mutex, OnceLock, mpsc};
use std::time::{Duration, Instant};

type Ref = *mut c_void;
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Point {
    x: f64,
    y: f64,
}
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Size {
    width: f64,
    height: f64,
}
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Rect {
    origin: Point,
    size: Size,
}

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn CGPreflightListenEventAccess() -> bool;
    fn CGPreflightPostEventAccess() -> bool;
    fn CGRequestListenEventAccess() -> bool;
    fn CGRequestPostEventAccess() -> bool;
    fn CGGetActiveDisplayList(max: u32, displays: *mut u32, count: *mut u32) -> i32;
    fn CGMainDisplayID() -> u32;
    fn CGDisplayBounds(display: u32) -> Rect;
    fn CGDisplayHideCursor(display: u32) -> i32;
    fn CGDisplayShowCursor(display: u32) -> i32;
    fn CGWarpMouseCursorPosition(point: Point) -> i32;
    // boolean_t is a 32-bit Mach integer, not C/Rust bool.
    fn CGAssociateMouseAndMouseCursorPosition(connected: i32) -> i32;
    fn CGEventTapCreate(
        tap: u32,
        place: u32,
        options: u32,
        mask: u64,
        callback: extern "C" fn(Ref, u32, Ref, Ref) -> Ref,
        user: Ref,
    ) -> Ref;
    fn CGEventTapEnable(tap: Ref, enabled: bool);
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
    fn CGEventGetLocation(event: Ref) -> Point;
    fn CGEventGetFlags(event: Ref) -> u64;
    fn CGEventGetIntegerValueField(event: Ref, field: u32) -> i64;
    fn CGEventGetDoubleValueField(event: Ref, field: u32) -> f64;
    fn CGEventSetIntegerValueField(event: Ref, field: u32, value: i64);
    fn CGEventSetType(event: Ref, kind: u32);
    fn CGEventSetFlags(event: Ref, flags: u64);
    fn CGEventPost(tap: u32, event: Ref);
    fn CGEventSourceKeyState(source: i32, key: u16) -> bool;
    fn CGEventSourceButtonState(source: i32, button: u32) -> bool;
}
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    static kCFBooleanTrue: Ref;
    fn CFMachPortInvalidate(port: Ref);
    fn CFMachPortCreateRunLoopSource(allocator: Ref, port: Ref, order: isize) -> Ref;
    fn CFRunLoopGetCurrent() -> Ref;
    fn CFRunLoopAddSource(run_loop: Ref, source: Ref, mode: Ref);
    fn CFRunLoopRunInMode(mode: Ref, seconds: f64, return_after_source: bool) -> i32;
    fn CFStringCreateWithCString(allocator: Ref, value: *const c_char, encoding: u32) -> Ref;
    fn CFRelease(value: Ref);
}

#[link(name = "System")]
unsafe extern "C" {
    fn dlsym(handle: Ref, name: *const c_char) -> Ref;
}

type DefaultConnection = unsafe extern "C" fn() -> i32;
type SetConnectionProperty = unsafe extern "C" fn(i32, i32, Ref, Ref) -> i32;
struct BackgroundCursor {
    connection: DefaultConnection,
    set: SetConnectionProperty,
}
impl BackgroundCursor {
    fn enable() -> bool {
        // Quartz's public hide/detach calls are foreground-oriented. This optional
        // WindowServer property permits this CLI process to control its cursor in
        // the background without activating an app or taking keyboard focus.
        // Resolve at runtime: missing private symbols must not break module loading.
        static API: OnceLock<Option<BackgroundCursor>> = OnceLock::new();
        let api = API.get_or_init(|| unsafe {
            let handle = -2_isize as Ref; // RTLD_DEFAULT on Darwin
            let connection = dlsym(handle, c"_CGSDefaultConnection".as_ptr());
            let set = dlsym(handle, c"CGSSetConnectionProperty".as_ptr());
            if connection.is_null() || set.is_null() {
                return None;
            }
            Some(BackgroundCursor {
                connection: std::mem::transmute::<Ref, DefaultConnection>(connection),
                set: std::mem::transmute::<Ref, SetConnectionProperty>(set),
            })
        });
        let Some(api) = api else {
            return false;
        };
        unsafe {
            let key = CFStringCreateWithCString(
                null_mut(),
                c"SetsCursorInBackground".as_ptr(),
                0x08000100,
            );
            if key.is_null() {
                return false;
            }
            let connection = (api.connection)();
            let result = (api.set)(connection, connection, key, kCFBooleanTrue);
            CFRelease(key);
            result == 0
        }
    }
}

struct MacCursor {
    bounds: Rect,
    restore: Point,
}
impl CursorBackend for MacCursor {
    fn background_control(&mut self) -> bool {
        BackgroundCursor::enable()
    }
    fn hide(&mut self) -> bool {
        unsafe { CGDisplayHideCursor(CGMainDisplayID()) == 0 }
    }
    fn connect_mouse(&mut self, connected: bool) -> bool {
        unsafe { CGAssociateMouseAndMouseCursorPosition(i32::from(connected)) == 0 }
    }
    fn restore_position(&mut self) {
        let b = self.bounds;
        let point = Point {
            x: self
                .restore
                .x
                .clamp(b.origin.x + 4.0, b.origin.x + b.size.width - 5.0),
            y: self
                .restore
                .y
                .clamp(b.origin.y + 4.0, b.origin.y + b.size.height - 5.0),
        };
        unsafe {
            CGWarpMouseCursorPosition(point);
        }
    }
    fn show(&mut self) {
        unsafe {
            CGDisplayShowCursor(CGMainDisplayID());
        }
    }
}

const TAG: i64 = 0x4c414e464c59;
const MODIFIERS: u64 = (1 << 17) | (1 << 18) | (1 << 19) | (1 << 20) | (1 << 23);
const EMERGENCY: u64 = (1 << 18) | (1 << 19) | (1 << 20); // Ctrl+Option+Command+Esc
const MASK: u64 = (1 << 1)
    | (1 << 2)
    | (1 << 3)
    | (1 << 4)
    | (1 << 5)
    | (1 << 6)
    | (1 << 7)
    | (1 << 10)
    | (1 << 11)
    | (1 << 12)
    | (1 << 22)
    | (1 << 25)
    | (1 << 26)
    | (1 << 27);

struct State {
    enabled: bool,
    server: bool,
    edge: String,
    remote: bool,
    capture: CursorCapture,
    bounds: Rect,
    cursor: Point,
    keys: BTreeSet<u16>,
    buttons: BTreeSet<u32>,
    physical_keys: BTreeSet<u16>,
    input_source_key: InputSourceKey,
    physical_buttons: BTreeSet<u32>,
    queue: Vec<Value>,
    tick: Instant,
    activity: Instant,
    cooldown: Instant,
}
impl Default for State {
    fn default() -> Self {
        Self {
            enabled: false,
            server: false,
            edge: "right".into(),
            remote: false,
            capture: CursorCapture::default(),
            bounds: Rect::default(),
            cursor: Point::default(),
            keys: BTreeSet::new(),
            buttons: BTreeSet::new(),
            physical_keys: BTreeSet::new(),
            input_source_key: InputSourceKey::default(),
            physical_buttons: BTreeSet::new(),
            queue: Vec::new(),
            tick: Instant::now(),
            activity: Instant::now(),
            cooldown: Instant::now(),
        }
    }
}
static STATE: OnceLock<Mutex<State>> = OnceLock::new();
static THREAD: crate::startup::RetryOnce = crate::startup::RetryOnce::new();
fn state() -> &'static Mutex<State> {
    STATE.get_or_init(|| Mutex::new(State::default()))
}

fn screens() -> u32 {
    let mut count = 0;
    let result = unsafe { CGGetActiveDisplayList(0, null_mut(), &mut count) };
    if result == 0 { count } else { 0 }
}
// A temporary keyboard tap tests the current process without posting input or
// intercepting events: it is never attached to a run loop and is invalidated immediately.
extern "C" fn permission_probe(_proxy: Ref, _kind: u32, event: Ref, _user: Ref) -> Ref {
    event
}
fn probe_keyboard_access(options: u32) -> bool {
    unsafe {
        let tap = CGEventTapCreate(
            0,
            0,
            options,
            (1 << 10) | (1 << 11),
            permission_probe,
            null_mut(),
        );
        if tap.is_null() {
            return false;
        }
        CFMachPortInvalidate(tap);
        CFRelease(tap);
        true
    }
}
fn permissions_status() -> (bool, bool) {
    // Preflight checks may lag behind System Settings. A newly created filtering
    // tap requires Accessibility; a listen-only keyboard tap checks monitoring access.
    let accessibility =
        unsafe { AXIsProcessTrusted() || CGPreflightPostEventAccess() } || probe_keyboard_access(0);
    let monitoring = unsafe { CGPreflightListenEventAccess() } || probe_keyboard_access(1);
    (accessibility, monitoring)
}
pub fn status() -> Value {
    let (accessibility, input_monitoring) = permissions_status();
    json!({ "screens": screens(), "accessibility": accessibility, "inputMonitoring": input_monitoring })
}
pub fn permissions() {
    unsafe {
        CGRequestPostEventAccess();
        CGRequestListenEventAccess();
    }
}

fn post(event: Ref) {
    if !event.is_null() {
        unsafe {
            CGEventSetIntegerValueField(event, 42, TAG);
            CGEventPost(0, event);
            CFRelease(event);
        }
    }
}

fn release(s: &mut State) {
    s.input_source_key = InputSourceKey::default();
    s.capture.release(&mut MacCursor {
        bounds: s.bounds,
        restore: s.cursor,
    });
    for key in std::mem::take(&mut s.keys) {
        unsafe {
            let event = CGEventCreateKeyboardEvent(null_mut(), key, false);
            if !event.is_null() {
                CGEventSetFlags(event, 0);
            }
            post(event);
        }
    }
    for button in std::mem::take(&mut s.buttons) {
        unsafe {
            post(CGEventCreateMouseEvent(
                null_mut(),
                match button {
                    0 => 2,
                    1 => 4,
                    _ => 26,
                },
                s.cursor,
                button,
            ));
        }
    }
    s.remote = false;
    s.cooldown = Instant::now() + Duration::from_millis(500);
}

pub fn reset() {
    macos_input_source::capture(false, false);
    let mut s = state().lock().unwrap();
    release(&mut s);
    s.queue.clear();
}
pub fn stop() {
    macos_input_source::capture(false, false);
    let mut s = state().lock().unwrap();
    release(&mut s);
    s.enabled = false;
    s.queue.clear();
}

fn thread_main(ready: mpsc::SyncSender<Result<(), String>>, activate: mpsc::Receiver<()>) {
    unsafe {
        // A session tap can swallow clicks/keys after WindowServer already moved
        // the hardware cursor. Filter at the HID entry point instead.
        let tap = CGEventTapCreate(0, 0, 0, MASK, callback, null_mut());
        if tap.is_null() {
            let _ = ready.send(Err("INPUT_PERMISSION".into()));
            return;
        }
        let source = CFMachPortCreateRunLoopSource(null_mut(), tap, 0);
        if source.is_null() {
            CFRelease(tap);
            let _ = ready.send(Err("INPUT_NATIVE_ERROR".into()));
            return;
        }
        let mode =
            CFStringCreateWithCString(null_mut(), c"kCFRunLoopDefaultMode".as_ptr(), 0x08000100);
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, mode);
        if ready.send(Ok(())).is_err() || activate.recv().is_err() {
            CFMachPortInvalidate(tap);
            CFRelease(source);
            CFRelease(tap);
            CFRelease(mode);
            return;
        }
        loop {
            CFRunLoopRunInMode(mode, 0.05, false);
            let mut s = state().lock().unwrap();
            if s.enabled
                && (s.tick.elapsed() > Duration::from_millis(1000)
                    || screens() != 1
                    || (!s.server
                        && s.remote
                        && s.activity.elapsed() > Duration::from_millis(1500)))
            {
                release(&mut s);
                s.enabled = false;
                s.queue.clear();
                s.queue.push(json!({"kind":"fault"}));
            }
            // Quartz disables taps on timeout. Recover local input before re-enabling.
            if !s.enabled {
                CGEventTapEnable(tap, true);
            }
        }
    }
}

pub fn start(role: &str, edge: &str) -> Result<(), String> {
    if !matches!(role, "server" | "client") || !matches!(edge, "left" | "right" | "top" | "bottom")
    {
        return Err("INPUT_INVALID".into());
    }
    if screens() != 1 {
        return Err("INPUT_SINGLE_SCREEN".into());
    }
    let (accessibility, monitoring) = permissions_status();
    if !accessibility || !monitoring {
        return Err("INPUT_PERMISSION".into());
    }
    if role == "server" && !BackgroundCursor::enable() {
        return Err("INPUT_CURSOR_CAPTURE".into());
    }
    THREAD.initialize(|| {
        let (tx, rx) = mpsc::sync_channel(1);
        let (activate, activation) = mpsc::channel();
        std::thread::spawn(move || thread_main(tx, activation));
        rx.recv_timeout(Duration::from_secs(2))
            .unwrap_or(Err("INPUT_NATIVE_ERROR".into()))?;
        activate
            .send(())
            .map_err(|_| "INPUT_NATIVE_ERROR".to_string())
    })?;
    let mut s = state().lock().unwrap();
    release(&mut s);
    s.server = role == "server";
    s.edge = edge.into();
    s.bounds = unsafe { CGDisplayBounds(CGMainDisplayID()) };
    if !s.bounds.size.width.is_finite()
        || !s.bounds.size.height.is_finite()
        || s.bounds.size.width < 10.0
        || s.bounds.size.height < 10.0
    {
        return Err("INPUT_SINGLE_SCREEN".into());
    }
    s.enabled = true;
    s.tick = Instant::now();
    s.physical_keys.clear();
    s.physical_buttons.clear();
    if s.server {
        // A key already held when sharing starts must receive its local key-up.
        // Modifier transitions arrive as flagsChanged; their flags gate entry instead.
        for key in 0..128 {
            if !(54..=63).contains(&key) && unsafe { CGEventSourceKeyState(1, key) } {
                s.physical_keys.insert(key);
            }
        }
        for button in 0..32 {
            if unsafe { CGEventSourceButtonState(1, button) } {
                s.physical_buttons.insert(button);
            }
        }
    }
    s.queue.clear();
    Ok(())
}

fn boundary(p: Point, b: Rect, edge: &str, dx: f64, dy: f64) -> bool {
    match edge {
        "left" => p.x <= b.origin.x + 1.0 && dx < 0.0,
        "right" => p.x >= b.origin.x + b.size.width - 2.0 && dx > 0.0,
        "top" => p.y <= b.origin.y + 1.0 && dy < 0.0,
        "bottom" => p.y >= b.origin.y + b.size.height - 2.0 && dy > 0.0,
        _ => false,
    }
}

extern "C" fn callback(_proxy: Ref, kind: u32, event: Ref, _user: Ref) -> Ref {
    let mut s = state().lock().unwrap();
    if kind >= 0xffff_fffe {
        release(&mut s);
        s.enabled = false;
        s.queue.clear();
        s.queue.push(json!({"kind":"fault"}));
        return event;
    }
    if event.is_null() {
        return event;
    }
    if !s.enabled || unsafe { CGEventGetIntegerValueField(event, 42) } == TAG {
        return event;
    }
    let flags = unsafe { CGEventGetFlags(event) };
    let key = unsafe { CGEventGetIntegerValueField(event, 9) } as u16;
    if kind == 10 && key == 53 && flags & EMERGENCY == EMERGENCY {
        release(&mut s);
        s.queue.clear();
        s.queue.push(json!({"kind":"emergency"}));
        return null_mut();
    }
    if !s.server {
        return event;
    }
    let button = unsafe { CGEventGetIntegerValueField(event, 3) } as u32;
    match kind {
        10 => {
            s.physical_keys.insert(key);
        }
        11 => {
            s.physical_keys.remove(&key);
        }
        1 | 3 | 25 => {
            s.physical_buttons.insert(button);
        }
        2 | 4 | 26 => {
            s.physical_buttons.remove(&button);
        }
        _ => {}
    }
    let dx = unsafe { CGEventGetDoubleValueField(event, 4) };
    let dy = unsafe { CGEventGetDoubleValueField(event, 5) };
    if !s.remote
        && kind == 5
        && Instant::now() >= s.cooldown
        && s.physical_keys.is_empty()
        && s.physical_buttons.is_empty()
        && flags & MODIFIERS == 0
    {
        let p = unsafe { CGEventGetLocation(event) };
        if boundary(p, s.bounds, &s.edge, dx, dy) {
            let mut backend = MacCursor {
                bounds: s.bounds,
                restore: p,
            };
            if !s.capture.acquire(&mut backend) {
                s.enabled = false;
                s.queue.clear();
                s.queue.push(json!({"kind":"fault", "reason":"cursor"}));
                return event;
            }
            s.remote = true;
            s.cursor = p;
            let b = s.bounds;
            s.queue
                .push(json!({"kind":"enter", "x":(p.x-b.origin.x)/b.size.width,
                "y":(p.y-b.origin.y)/b.size.height}));
            return null_mut();
        }
    }
    if !s.remote {
        return event;
    }
    if s.queue.len() >= 1024 {
        release(&mut s);
        s.enabled = false;
        s.queue.clear();
        s.queue.push(json!({"kind":"fault"}));
        return event;
    }
    if let Some(switching) = s.input_source_key.update(kind, key, flags) {
        if switching {
            s.queue.push(json!({"kind":"input-source"}));
        }
        return null_mut();
    }
    s.queue
        .push(json!({"kind":"event", "t":kind, "flags":flags & FLAGS_MASK,
        "key":key, "button":button.min(31), "dx":dx, "dy":dy,
        "sx":unsafe { CGEventGetIntegerValueField(event, 96) },
        "sy":unsafe { CGEventGetIntegerValueField(event, 97) },
        "lineX":unsafe { CGEventGetIntegerValueField(event, 11) },
        "lineY":unsafe { CGEventGetIntegerValueField(event, 12) },
        "continuous":unsafe { CGEventGetIntegerValueField(event, 88) } != 0,
        "phase":unsafe { CGEventGetIntegerValueField(event, 99) },
        "momentum":unsafe { CGEventGetIntegerValueField(event, 123) },
        "repeat":unsafe { CGEventGetIntegerValueField(event, 8) },
        "clicks":unsafe { CGEventGetIntegerValueField(event, 1) }}));
    null_mut()
}

pub fn poll() -> Value {
    let mut s = state().lock().unwrap();
    s.tick = Instant::now();
    let remote = s.enabled && s.server && s.remote;
    let mut events = std::mem::take(&mut s.queue);
    drop(s);
    let switching = events.iter().any(|e| e["kind"] == "input-source");
    if !macos_input_source::capture(remote, switching) {
        let mut s = state().lock().unwrap();
        release(&mut s);
        s.enabled = false;
        events.clear();
        events.push(json!({"kind":"fault", "reason":"input-source"}));
    }
    Value::Array(events)
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct Input {
    kind: String,
    t: u32,
    flags: u64,
    key: u16,
    button: u32,
    dx: f64,
    dy: f64,
    x: f64,
    y: f64,
    sx: i32,
    sy: i32,
    #[serde(rename = "lineX")]
    line_x: i32,
    #[serde(rename = "lineY")]
    line_y: i32,
    continuous: bool,
    phase: i64,
    momentum: i64,
    #[serde(rename = "repeat")]
    repeat_key: i64,
    clicks: i64,
}

pub fn inject(value: &str) -> Result<(), String> {
    if value.len() > 4096 {
        return Err("INPUT_INVALID".into());
    }
    let e: Input = serde_json::from_str(value).map_err(|_| "INPUT_INVALID")?;
    let mut s = state().lock().unwrap();
    if !s.enabled || s.server {
        return Err("INPUT_NOT_READY".into());
    }
    s.activity = Instant::now();
    let b = s.bounds;
    if e.kind == "heartbeat" {
        return Ok(());
    }
    if e.kind == "enter" {
        if !e.x.is_finite() || !e.y.is_finite() {
            return Err("INPUT_INVALID".into());
        }
        release(&mut s);
        s.cursor = Point {
            x: b.origin.x + e.x.clamp(0.0, 1.0) * (b.size.width - 1.0),
            y: b.origin.y + e.y.clamp(0.0, 1.0) * (b.size.height - 1.0),
        };
        match s.edge.as_str() {
            "left" => s.cursor.x = b.origin.x + 3.0,
            "right" => s.cursor.x = b.origin.x + b.size.width - 4.0,
            "top" => s.cursor.y = b.origin.y + 3.0,
            _ => s.cursor.y = b.origin.y + b.size.height - 4.0,
        }
        s.remote = true;
        unsafe {
            CGWarpMouseCursorPosition(s.cursor);
        }
        return Ok(());
    }
    if e.kind == "input-source" {
        if !s.remote {
            return Ok(());
        }
        drop(s);
        return if macos_input_source::toggle() {
            Ok(())
        } else {
            Err("INPUT_SOURCE_FAILED".into())
        };
    }
    if e.kind != "event"
        || !matches!(e.t, 1..=7 | 10..=12 | 22 | 25..=27)
        || !valid_key(e.t, e.key)
        || e.button > 31
        || !e.dx.is_finite()
        || !e.dy.is_finite()
        || e.dx.abs() > 10000.0
        || e.dy.abs() > 10000.0
        || e.flags & !FLAGS_MASK != 0
        || e.sx.unsigned_abs() > 10000
        || e.sy.unsigned_abs() > 10000
        || e.line_x.unsigned_abs() > 10000
        || e.line_y.unsigned_abs() > 10000
    {
        return Err("INPUT_INVALID".into());
    }
    if !s.remote {
        return Ok(());
    }
    // Compatibility with peers that still forward the stateless input-source notification.
    if let Some(switching) = s.input_source_key.update(e.t, e.key, e.flags) {
        drop(s);
        return if !switching || macos_input_source::toggle() {
            Ok(())
        } else {
            Err("INPUT_SOURCE_FAILED".into())
        };
    }
    unsafe {
        let event = if matches!(e.t, 10..=12) {
            let held = held_key(e.t, e.key, e.flags);
            if let Some(down) = held {
                if down {
                    s.keys.insert(e.key);
                } else {
                    s.keys.remove(&e.key);
                }
            }
            let event = CGEventCreateKeyboardEvent(null_mut(), e.key, held.unwrap_or(false));
            if !event.is_null() {
                CGEventSetIntegerValueField(event, 8, e.repeat_key.clamp(0, 1));
                CGEventSetType(event, e.t);
            }
            event
        } else if e.t == 22 {
            let event = CGEventCreateScrollWheelEvent2(
                null_mut(),
                if e.continuous { 0 } else { 1 },
                2,
                if e.continuous { e.sx } else { e.line_x },
                if e.continuous { e.sy } else { e.line_y },
                0,
            );
            if !event.is_null() {
                CGEventSetIntegerValueField(event, 99, e.phase & 0xff);
                CGEventSetIntegerValueField(event, 123, e.momentum & 0xff);
            }
            event
        } else {
            if matches!(e.t, 5..=7 | 27) {
                s.cursor.x = (s.cursor.x + e.dx).clamp(b.origin.x, b.origin.x + b.size.width - 1.0);
                s.cursor.y =
                    (s.cursor.y + e.dy).clamp(b.origin.y, b.origin.y + b.size.height - 1.0);
                if s.buttons.is_empty()
                    && s.keys.is_empty()
                    && e.flags & MODIFIERS == 0
                    && boundary(s.cursor, b, &s.edge, e.dx, e.dy)
                {
                    release(&mut s);
                    s.queue.push(json!({"kind":"leave"}));
                    return Ok(());
                }
            }
            match e.t {
                1 | 3 | 25 => {
                    s.buttons.insert(e.button);
                }
                2 | 4 | 26 => {
                    s.buttons.remove(&e.button);
                }
                _ => {}
            }
            let event = CGEventCreateMouseEvent(null_mut(), e.t, s.cursor, e.button);
            if !event.is_null() {
                CGEventSetIntegerValueField(event, 1, e.clicks.clamp(0, 3));
            }
            event
        };
        if event.is_null() {
            return Err("INPUT_NATIVE_ERROR".into());
        }
        CGEventSetFlags(event, e.flags);
        post(event);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn edges_require_outward_motion() {
        let b = Rect {
            origin: Point { x: 0.0, y: 0.0 },
            size: Size {
                width: 100.0,
                height: 80.0,
            },
        };
        assert!(boundary(Point { x: 99.0, y: 20.0 }, b, "right", 1.0, 0.0));
        assert!(!boundary(Point { x: 99.0, y: 20.0 }, b, "right", -1.0, 0.0));
        assert!(boundary(Point { x: 20.0, y: 0.0 }, b, "top", 0.0, -1.0));
    }
    #[test]
    fn invalid_wire_input_never_posts_events() {
        assert!(inject(r#"{"kind":"event","t":10,"key":65536}"#).is_err());
        assert!(inject(r#"{"kind":"event","extra":1}"#).is_err());
    }
}
