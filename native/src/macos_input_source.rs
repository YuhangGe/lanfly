//! Carbon input-source APIs are only called by Node's JS thread, never by the event tap.
use crate::input_source::{Backend, Controller};
use std::cell::RefCell;
use std::ffi::c_void;
use std::ptr::null_mut;
use std::time::Instant;

type Ref = *mut c_void;
#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
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
        unsafe { TISSelectInputSource(source.0) == 0 }
    }
}
thread_local! { static SOURCES: RefCell<Controller<Source>> = RefCell::new(Controller::default()); }
pub fn capture(remote: bool, switching: bool) -> bool {
    SOURCES.with(|sources| {
        sources
            .borrow_mut()
            .capture(remote, switching, Instant::now(), &mut MacSources)
    })
}
pub fn toggle() -> bool {
    SOURCES.with(|sources| sources.borrow_mut().toggle(&mut MacSources))
}
