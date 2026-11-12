//! TIS access and source memory belong to macOS's main thread. Its distributed
//! input-source notifications require the main CFRunLoop, which Node/libuv does
//! not pump. Tokio callers dispatch through Neon; the event tap never calls TIS.
use crate::input_source::{Backend, Controller};
use neon::event::Channel;
use std::cell::RefCell;
use std::ffi::c_void;
use std::ptr::null_mut;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock, mpsc};
use std::time::{Duration, Instant};

type Ref = *mut c_void;
#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
    static kTISPropertyInputSourceID: Ref;
    static kTISPropertyInputModeID: Ref;
    static kTISPropertyInputSourceCategory: Ref;
    static kTISCategoryKeyboardInputSource: Ref;
    static kTISPropertyInputSourceIsSelectCapable: Ref;
    static kTISPropertyInputSourceIsASCIICapable: Ref;
    fn TISCopyCurrentKeyboardInputSource() -> Ref;
    fn TISCopyCurrentASCIICapableKeyboardInputSource() -> Ref;
    fn TISCreateInputSourceList(properties: Ref, include_all: bool) -> Ref;
    fn TISGetInputSourceProperty(source: Ref, property: Ref) -> Ref;
    fn TISSelectInputSource(source: Ref) -> i32;
}
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    static kCFRunLoopDefaultMode: Ref;
    fn CFRunLoopRunInMode(mode: Ref, seconds: f64, return_after_source: bool) -> i32;
    fn CFRelease(value: Ref);
    fn CFRetain(value: Ref) -> Ref;
    fn CFEqual(a: Ref, b: Ref) -> bool;
    fn CFBooleanGetValue(value: Ref) -> bool;
    fn CFStringGetCString(string: Ref, buffer: *mut i8, size: isize, encoding: u32) -> bool;
    fn CFArrayGetCount(array: Ref) -> isize;
    fn CFArrayGetValueAtIndex(array: Ref, index: isize) -> Ref;
}
struct Source(Ref);
impl Source {
    fn owned(value: Ref) -> Option<Self> {
        if value.is_null() {
            None
        } else {
            Some(Self(value))
        }
    }
    fn identity(&self) -> String {
        let string = |key| {
            let value = unsafe { TISGetInputSourceProperty(self.0, key) };
            let mut buffer = [0_i8; 1024];
            if value.is_null()
                || !unsafe {
                    CFStringGetCString(
                        value,
                        buffer.as_mut_ptr(),
                        buffer.len() as isize,
                        0x08000100,
                    )
                }
            {
                return String::new();
            }
            unsafe { std::ffi::CStr::from_ptr(buffer.as_ptr()) }
                .to_string_lossy()
                .into_owned()
        };
        format!(
            "{}/{}",
            string(unsafe { kTISPropertyInputSourceID }),
            string(unsafe { kTISPropertyInputModeID })
        )
    }
    fn boolean(&self, property: Ref) -> bool {
        let value = unsafe { TISGetInputSourceProperty(self.0, property) };
        !value.is_null() && unsafe { CFBooleanGetValue(value) }
    }
}
impl Clone for Source {
    fn clone(&self) -> Self {
        Self(unsafe { CFRetain(self.0) })
    }
}
impl PartialEq for Source {
    fn eq(&self, other: &Self) -> bool {
        unsafe { CFEqual(self.0, other.0) }
    }
}
impl Drop for Source {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0) };
    }
}
#[derive(Default)]
struct MacSources {
    observed: Option<String>,
}
impl Backend for MacSources {
    type Source = Source;
    fn current(&mut self) -> Option<Source> {
        let source = Source::owned(unsafe { TISCopyCurrentKeyboardInputSource() });
        if trace_enabled() {
            let identity = source.as_ref().map(Source::identity);
            if identity != self.observed {
                trace(&format!("observed source={identity:?}"));
                self.observed = identity;
            }
        }
        source
    }
    fn ascii(&mut self) -> Option<Source> {
        Source::owned(unsafe { TISCopyCurrentASCIICapableKeyboardInputSource() })
    }
    fn enabled(&mut self) -> Vec<Source> {
        let Some(list) = Source::owned(unsafe { TISCreateInputSourceList(null_mut(), false) })
        else {
            return vec![];
        };
        let mut sources = vec![];
        for i in 0..unsafe { CFArrayGetCount(list.0) } {
            let raw = unsafe { CFArrayGetValueAtIndex(list.0, i) };
            if raw.is_null() {
                continue;
            }
            let category =
                unsafe { TISGetInputSourceProperty(raw, kTISPropertyInputSourceCategory) };
            if category.is_null() || !unsafe { CFEqual(category, kTISCategoryKeyboardInputSource) }
            {
                continue;
            }
            let source = Source(unsafe { CFRetain(raw) });
            if source.boolean(unsafe { kTISPropertyInputSourceIsSelectCapable }) {
                sources.push(source);
            }
        }
        sources
    }
    fn is_ascii(&self, source: &Source) -> bool {
        source.boolean(unsafe { kTISPropertyInputSourceIsASCIICapable })
    }
    fn select(&mut self, source: &Source) -> bool {
        let before = self.current().map(|s| s.identity());
        let status = unsafe { TISSelectInputSource(source.0) };
        // Even noErr is only an acknowledgement. Observe the selected source before
        // allowing the next key through, including when restoring the controller.
        let applied = wait_until(|| self.current().as_ref() == Some(source));
        trace(&format!(
            "tis before={before:?} target={} status={status} applied={applied}",
            source.identity()
        ));
        applied
    }
    fn switch(&mut self, source: &Source) -> bool {
        // Prefer a concrete, verified target over a blind Caps injection. Some CJK
        // modes need a system shortcut instead; expose that as a separate method,
        // never chain two asynchronous switches and risk undoing the first one.
        let Some(before) = self.current() else {
            return false;
        };
        if std::env::var("LANFLY_INPUT_SOURCE_METHOD").as_deref() == Ok("shortcut") {
            let posted = crate::hid::input_source_shortcut();
            if posted != 0 {
                let applied = posted > 0
                    && wait_until(|| self.current().is_some_and(|current| current != before));
                trace(&format!(
                    "shortcut before={:?} after={:?} submitted={posted} applied={applied}",
                    before.identity(),
                    self.current().as_ref().map(Source::identity)
                ));
                // Never follow an acknowledged shortcut with another toggle: a late
                // first switch could otherwise immediately be undone by the fallback.
                return applied;
            }
        }
        self.select(source)
    }
}
fn wait_until(mut ready: impl FnMut() -> bool) -> bool {
    let until = Instant::now() + Duration::from_millis(250);
    loop {
        if ready() {
            return true;
        }
        if Instant::now() >= until {
            return false;
        }
        pump();
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn pump() {
    // CF distributed notifications are delivered on the process MAIN run loop.
    // Pumping a worker's loop does not invalidate TIS's per-process cache.
    unsafe { CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.001, true) };
}

fn trace_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("LANFLY_INPUT_DEBUG").as_deref() == Ok("1"))
}

pub fn trace(message: &str) {
    if trace_enabled() {
        eprintln!("[lanfly:input-source] {message}");
    }
}

#[link(name = "System")]
unsafe extern "C" {
    fn pthread_main_np() -> i32;
}
fn is_main_thread() -> bool {
    unsafe { pthread_main_np() != 0 }
}

static MAIN: OnceLock<Channel> = OnceLock::new();
pub fn initialize(channel: Channel) {
    // A Node worker-thread environment is not the macOS main thread.
    if is_main_thread() {
        let _ = MAIN.set(channel);
    }
}

#[derive(Clone, Copy)]
enum Action {
    Capture { remote: bool, switching: bool },
    Toggle,
    Finish { restore: bool },
}

#[derive(Default)]
struct State {
    sources: Controller<Source>,
    backend: MacSources,
    remote: bool,
}
thread_local! { static STATE: RefCell<State> = RefCell::new(State::default()); }

fn on_main(action: Action) -> bool {
    if !is_main_thread() {
        return false;
    }
    pump();
    STATE.with(|state| {
        let mut state = state.borrow_mut();
        let State {
            sources,
            backend,
            remote,
        } = &mut *state;
        match action {
            Action::Capture {
                remote: next,
                switching,
            } => {
                if next != *remote {
                    trace(&format!(
                        "capture remote={next} source={:?}",
                        backend.current().as_ref().map(Source::identity)
                    ));
                    *remote = next;
                }
                sources.capture(next, switching, Instant::now(), backend)
            }
            Action::Toggle => sources.toggle(backend),
            Action::Finish { restore } => {
                *remote = false;
                sources.finish(restore, backend)
            }
        }
    })
}

fn request(action: Action) -> bool {
    // Never enqueue and synchronously wait on the Node/macOS main thread itself.
    if is_main_thread() {
        return on_main(action);
    }
    let Some(channel) = MAIN.get() else {
        return false;
    };
    let (reply, result) = mpsc::sync_channel(1);
    let cancelled = Arc::new(AtomicBool::new(false));
    let pending = cancelled.clone();
    if channel
        .try_send(move |_| {
            if !pending.load(Ordering::Acquire) {
                let _ = reply.send(on_main(action));
            }
            Ok(())
        })
        .is_err()
    {
        return false;
    }
    match result.recv_timeout(Duration::from_secs(1)) {
        Ok(result) => result,
        Err(_) => {
            cancelled.store(true, Ordering::Release);
            false
        }
    }
}

pub fn capture(remote: bool, switching: bool) -> bool {
    request(Action::Capture { remote, switching })
}
pub fn toggle() -> bool {
    request(Action::Toggle)
}
pub fn finish(restore: bool) -> bool {
    request(Action::Finish { restore })
}
