//! All TIS access and source memory live on one worker for this non-UI Node CLI.
//! Neither Tokio nor the event tap accesses Carbon. Calls complete before subsequent
//! remote key injection, so text cannot overtake an input-source switch.
use crate::input_source::{Backend, Controller};
use std::ffi::c_void;
use std::ptr::null_mut;
use std::sync::{OnceLock, mpsc};
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
struct MacSources;
impl Backend for MacSources {
    type Source = Source;
    fn current(&mut self) -> Option<Source> {
        Source::owned(unsafe { TISCopyCurrentKeyboardInputSource() })
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
        // CJK input modes can report a successful TIS selection without activating
        // the IME correctly. Prefer the user's enabled system shortcut for toggles;
        // explicit restoration still uses select(), never a blind second toggle.
        let Some(before) = self.current() else {
            return false;
        };
        if std::env::var("LANFLY_INPUT_SOURCE_METHOD").as_deref() != Ok("tis") {
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
        std::thread::sleep(Duration::from_millis(5));
    }
}

pub fn trace(message: &str) {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    if *ENABLED.get_or_init(|| std::env::var("LANFLY_INPUT_DEBUG").as_deref() == Ok("1")) {
        eprintln!("[lanfly:input-source] {message}");
    }
}

enum Command {
    Capture {
        remote: bool,
        switching: bool,
        reply: mpsc::SyncSender<bool>,
    },
    Toggle(mpsc::SyncSender<bool>),
}

fn commands() -> Option<&'static mpsc::SyncSender<Command>> {
    static COMMANDS: OnceLock<Option<mpsc::SyncSender<Command>>> = OnceLock::new();
    COMMANDS
        .get_or_init(|| {
            let (send, receive) = mpsc::sync_channel(16);
            std::thread::Builder::new()
                .name("lanfly-input-source".into())
                .spawn(move || {
                    let mut sources = Controller::default();
                    let mut backend = MacSources;
                    let mut remote = false;
                    let mut lease = Instant::now();
                    loop {
                        match receive.recv_timeout(Duration::from_millis(20)) {
                            Ok(Command::Capture {
                                remote: next,
                                switching,
                                reply,
                            }) => {
                                if next != remote {
                                    trace(&format!("capture remote={next}"));
                                }
                                remote = next;
                                lease = Instant::now() + Duration::from_secs(1);
                                let result = sources.capture(
                                    remote,
                                    switching,
                                    Instant::now(),
                                    &mut backend,
                                );
                                let _ = reply.send(result);
                            }
                            Ok(Command::Toggle(reply)) => {
                                let result = sources.toggle(&mut backend);
                                let _ = reply.send(result);
                            }
                            Err(mpsc::RecvTimeoutError::Timeout) => {
                                if remote && Instant::now() >= lease {
                                    remote = false;
                                }
                                // Preserve local input even when no Caps notification arrives.
                                // A lease prevents a stalled JS thread retaining capture forever.
                                sources.capture(remote, false, Instant::now(), &mut backend);
                            }
                            Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        }
                    }
                })
                .ok()
                .map(|_| send)
        })
        .as_ref()
}

fn request(command: impl FnOnce(mpsc::SyncSender<bool>) -> Command) -> bool {
    let Some(commands) = commands() else {
        return false;
    };
    let (reply, result) = mpsc::sync_channel(1);
    commands.send(command(reply)).is_ok() && result.recv().unwrap_or(false)
}

pub fn capture(remote: bool, switching: bool) -> bool {
    request(|reply| Command::Capture {
        remote,
        switching,
        reply,
    })
}
pub fn toggle() -> bool {
    request(Command::Toggle)
}
