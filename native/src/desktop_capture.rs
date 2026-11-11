//! ScreenCaptureKit capture handle. Frames stay as CVPixelBuffer / IOSurface backed
//! buffers all the way to VideoToolbox; nothing crosses the Neon boundary.
use std::ffi::{CStr, c_char, c_void};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use crossbeam_channel::{Sender, TrySendError};

pub type CVPixelBufferRef = *mut c_void;
type LFFrameCallback =
    extern "C" fn(ctx: *mut c_void, buffer: CVPixelBufferRef, pts_value: i64, pts_timescale: i32);
type LFErrorCallback = extern "C" fn(ctx: *mut c_void, message: *const c_char);

#[link(name = "CoreVideo", kind = "framework")]
unsafe extern "C" {
    fn CVPixelBufferRelease(buffer: CVPixelBufferRef);
}

unsafe extern "C" {
    fn lf_capture_start(
        max_width: u32,
        max_height: u32,
        fps: u32,
        on_frame: LFFrameCallback,
        on_error: LFErrorCallback,
        ctx: *mut c_void,
        error_buffer: *mut c_char,
        error_length: usize,
        out_width: *mut u32,
        out_height: *mut u32,
    ) -> *mut c_void;
    fn lf_capture_stop(handle: *mut c_void);
}

/// A retained CVPixelBuffer handed from the ScreenCaptureKit output queue to the encoder.
pub struct CapturedFrame {
    buffer: CVPixelBufferRef,
    pub pts_seconds: f64,
}

// The pointer is a CoreVideo buffer with its own retain count. Sending the retained handle to
// the encoder thread is the entire point of keeping the native buffer alive.
unsafe impl Send for CapturedFrame {}

impl CapturedFrame {
    pub fn buffer(&self) -> CVPixelBufferRef {
        self.buffer
    }
}

impl Drop for CapturedFrame {
    fn drop(&mut self) {
        if !self.buffer.is_null() {
            unsafe { CVPixelBufferRelease(self.buffer) };
            self.buffer = std::ptr::null_mut();
        }
    }
}

struct CaptureContext {
    frames: Sender<CapturedFrame>,
    error: Mutex<Option<String>>,
    dropped: AtomicU64,
}

extern "C" fn capture_frame(
    ctx: *mut c_void,
    buffer: CVPixelBufferRef,
    pts_value: i64,
    pts_timescale: i32,
) {
    if ctx.is_null() || buffer.is_null() {
        if !buffer.is_null() {
            unsafe { CVPixelBufferRelease(buffer) };
        }
        return;
    }
    // Take a counted reference for the duration of the callback. The stream's serial sample
    // queue plus lf_capture_stop's completion wait guarantee no *new* callback starts after the
    // leaked reference is released, while an in-flight callback keeps the allocation alive.
    unsafe { Arc::increment_strong_count(ctx as *const CaptureContext) };
    let context = unsafe { Arc::from_raw(ctx as *const CaptureContext) };
    let pts_seconds = if pts_timescale > 0 {
        pts_value as f64 / pts_timescale as f64
    } else {
        0.0
    };
    let frame = CapturedFrame {
        buffer,
        pts_seconds,
    };
    match context.frames.try_send(frame) {
        Ok(()) => {}
        Err(TrySendError::Full(frame)) => {
            context.dropped.fetch_add(1, Ordering::Relaxed);
            drop(frame);
        }
        Err(TrySendError::Disconnected(frame)) => drop(frame),
    }
    // `context` drops here, releasing the counted reference taken above.
}

extern "C" fn capture_error(ctx: *mut c_void, message: *const c_char) {
    if ctx.is_null() {
        return;
    }
    unsafe { Arc::increment_strong_count(ctx as *const CaptureContext) };
    let context = unsafe { Arc::from_raw(ctx as *const CaptureContext) };
    let text = if message.is_null() {
        "DESKTOP_CAPTURE_FAILED".to_owned()
    } else {
        unsafe { CStr::from_ptr(message) }
            .to_string_lossy()
            .into_owned()
    };
    if let Ok(mut error) = context.error.lock() {
        *error = Some(text);
    }
    // `context` drops here, releasing the counted reference taken above.
}

pub struct Capture {
    handle: usize,
    width: u32,
    height: u32,
    context: *const CaptureContext,
}

unsafe impl Send for Capture {}

impl Capture {
    /// Start the first (main) display at up to `max_width` x `max_height`, preserving the
    /// display aspect ratio. Returns the actual capture dimensions chosen by ScreenCaptureKit.
    pub fn start(
        max_width: u32,
        max_height: u32,
        fps: u32,
        frames: Sender<CapturedFrame>,
    ) -> Result<Self, String> {
        let context = Arc::new(CaptureContext {
            frames,
            error: Mutex::new(None),
            dropped: AtomicU64::new(0),
        });
        // One strong reference is owned by the raw pointer and released after the stream has
        // fully stopped. Callbacks borrow it temporarily without changing the count.
        let raw = Arc::into_raw(context) as *mut c_void;
        let mut error_buffer = [0_i8; 512];
        let mut width = 0_u32;
        let mut height = 0_u32;
        let handle = unsafe {
            lf_capture_start(
                max_width,
                max_height,
                fps,
                capture_frame,
                capture_error,
                raw,
                error_buffer.as_mut_ptr(),
                error_buffer.len(),
                &mut width,
                &mut height,
            )
        };
        if handle.is_null() {
            // Reclaim the only strong reference before reading the error.
            drop(unsafe { Arc::from_raw(raw as *const CaptureContext) });
            let message = unsafe { CStr::from_ptr(error_buffer.as_ptr()) }
                .to_string_lossy()
                .into_owned();
            return Err(if message.is_empty() {
                "DESKTOP_CAPTURE_FAILED".to_owned()
            } else {
                message
            });
        }
        Ok(Self {
            handle: handle as usize,
            width,
            height,
            context: raw as *const CaptureContext,
        })
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    pub fn take_error(&self) -> Option<String> {
        // Both the callback and the session use the same allocation; the weak field is only
        // used as a stable handle for reading errors.
        let context = unsafe { &*self.context };
        context.error.lock().ok().and_then(|mut value| value.take())
    }

    pub fn stop(&mut self) {
        if self.handle != 0 {
            unsafe { lf_capture_stop(self.handle as *mut c_void) };
            self.handle = 0;
        }
        if !self.context.is_null() {
            drop(unsafe { Arc::from_raw(self.context) });
            self.context = std::ptr::null();
        }
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.stop();
    }
}

// Screen Recording permission is a separate TCC grant from Accessibility.
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

#[derive(Clone, Copy)]
pub struct DisplayInfo {
    pub id: u32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    pub origin_x: f64,
    pub origin_y: f64,
    pub logical_width: f64,
    pub logical_height: f64,
}

pub fn screen_recording() -> bool {
    unsafe { CGPreflightScreenCaptureAccess() }
}

pub fn request_screen_recording() {
    unsafe {
        CGRequestScreenCaptureAccess();
    }
}

pub fn displays() -> Vec<DisplayInfo> {
    crate::macos::display_ids()
        .into_iter()
        .map(|id| {
            let (pixel_width, pixel_height) = crate::macos::display_pixels(id);
            let (origin_x, origin_y, width, height) = crate::macos::display_bounds_tuple(id);
            let logical_width = width.max(1.0);
            let logical_height = height.max(1.0);
            DisplayInfo {
                id,
                width: pixel_width,
                height: pixel_height,
                scale: if logical_width > 0.0 {
                    pixel_width as f64 / logical_width
                } else {
                    1.0
                },
                origin_x,
                origin_y,
                logical_width,
                logical_height,
            }
        })
        .collect()
}

pub fn main_display() -> Option<DisplayInfo> {
    let all = displays();
    let main = crate::macos::main_display_id();
    all.iter()
        .find(|display| display.id == main)
        .copied()
        .or_else(|| all.first().copied())
}
