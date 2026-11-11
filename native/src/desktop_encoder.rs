//! VideoToolbox H.264 hardware encoder. The encoder consumes the retained CVPixelBuffer
//! produced by ScreenCaptureKit directly and emits Annex-B samples for the RTP payloader.
use std::collections::VecDeque;
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use bytes::Bytes;
use core_foundation::base::TCFType;
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use core_foundation_sys::base::{CFRelease, CFTypeRef};
use core_foundation_sys::string::CFStringRef;
use crossbeam_channel::{Receiver, Sender, TrySendError};

use crate::desktop_capture::{CapturedFrame, CVPixelBufferRef};

type OSStatus = i32;
type VTCompressionSessionRef = *mut c_void;
type CMSampleBufferRef = *mut c_void;
type CMBlockBufferRef = *mut c_void;
type CMFormatDescriptionRef = *mut c_void;
type VTEncodeInfoFlags = u32;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CMTime {
    value: i64,
    timescale: i32,
    flags: u32,
    epoch: i64,
}

const CM_TIME_INVALID: CMTime = CMTime {
    value: 0,
    timescale: 0,
    flags: 0,
    epoch: 0,
};
const CM_VIDEO_CODEC_TYPE_H264: u32 = 0x6176_6331; // 'avc1'
const VT_ENCODE_INFO_FRAME_DROPPED: u32 = 1 << 1;

#[link(name = "CoreMedia", kind = "framework")]
unsafe extern "C" {
    fn CMSampleBufferGetDataBuffer(sample: CMSampleBufferRef) -> CMBlockBufferRef;
    fn CMSampleBufferGetFormatDescription(sample: CMSampleBufferRef) -> CMFormatDescriptionRef;
    fn CMSampleBufferGetPresentationTimeStamp(sample: CMSampleBufferRef) -> CMTime;
    fn CMBlockBufferGetDataLength(buffer: CMBlockBufferRef) -> usize;
    fn CMBlockBufferCopyDataBytes(
        buffer: CMBlockBufferRef,
        offset: usize,
        length: usize,
        destination: *mut c_void,
    ) -> OSStatus;
    fn CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
        description: CMFormatDescriptionRef,
        index: usize,
        parameter_set_pointer: *mut *const u8,
        parameter_set_size: *mut usize,
        parameter_set_count: *mut usize,
        nal_header_length: *mut i32,
    ) -> OSStatus;
}

#[link(name = "VideoToolbox", kind = "framework")]
unsafe extern "C" {
    static kVTCompressionPropertyKey_RealTime: CFStringRef;
    static kVTCompressionPropertyKey_ProfileLevel: CFStringRef;
    static kVTCompressionPropertyKey_AllowFrameReordering: CFStringRef;
    static kVTCompressionPropertyKey_AllowOpenGOP: CFStringRef;
    static kVTCompressionPropertyKey_AverageBitRate: CFStringRef;
    static kVTCompressionPropertyKey_MaxKeyFrameInterval: CFStringRef;
    static kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration: CFStringRef;
    static kVTCompressionPropertyKey_ExpectedFrameRate: CFStringRef;
    static kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel: CFStringRef;
    static kVTEncodeFrameOptionKey_ForceKeyFrame: CFStringRef;

    fn VTCompressionSessionCreate(
        allocator: CFTypeRef,
        width: i32,
        height: i32,
        codec_type: u32,
        encoder_specification: CFTypeRef,
        source_image_buffer_attributes: CFTypeRef,
        compressed_data_allocator: CFTypeRef,
        output_callback: Option<VTCompressionOutputCallback>,
        output_callback_ref_con: *mut c_void,
        compression_session_out: *mut VTCompressionSessionRef,
    ) -> OSStatus;
    fn VTCompressionSessionEncodeFrame(
        session: VTCompressionSessionRef,
        image_buffer: CVPixelBufferRef,
        presentation_time_stamp: CMTime,
        duration: CMTime,
        frame_properties: CFTypeRef,
        source_frame_ref_con: *mut c_void,
        info_flags_out: *mut VTEncodeInfoFlags,
    ) -> OSStatus;
    fn VTCompressionSessionCompleteFrames(
        session: VTCompressionSessionRef,
        complete_until_presentation_time_stamp: CMTime,
    ) -> OSStatus;
    fn VTCompressionSessionInvalidate(session: VTCompressionSessionRef);
    fn VTCompressionSessionPrepareToEncodeFrames(session: VTCompressionSessionRef) -> OSStatus;
    fn VTCompressionSessionSetProperty(
        session: VTCompressionSessionRef,
        property_key: CFStringRef,
        property_value: CFTypeRef,
    ) -> OSStatus;
}

type VTCompressionOutputCallback = extern "C" fn(
    output_callback_ref_con: *mut c_void,
    source_frame_ref_con: *mut c_void,
    status: OSStatus,
    info_flags: VTEncodeInfoFlags,
    sample_buffer: CMSampleBufferRef,
);

pub struct EncodedFrame {
    pub data: Bytes,
    pub duration: Duration,
}

struct Shared {
    session: Mutex<VTCompressionSessionRef>,
    output: Sender<EncodedFrame>,
    last_pts: Mutex<f64>,
    force_keyframe: Arc<AtomicBool>,
    bitrate: AtomicU64,
    running: AtomicBool,
    errors: Mutex<VecDeque<String>>,
    dropped: AtomicU64,
    fps: u32,
}

// The VideoToolbox session and CoreVideo buffers are only touched through the session's own
// callback/serialized encode calls.
unsafe impl Send for Shared {}
unsafe impl Sync for Shared {}

pub struct Encoder {
    shared: Arc<Shared>,
    thread: Option<JoinHandle<()>>,
}

fn set_property(session: VTCompressionSessionRef, key: CFStringRef, value: CFTypeRef) -> bool {
    unsafe { VTCompressionSessionSetProperty(session, key, value) == 0 }
}

fn set_i32_property(session: VTCompressionSessionRef, key: CFStringRef, value: i32) -> bool {
    let number = CFNumber::from(value);
    set_property(session, key, number.as_CFTypeRef())
}

fn set_bool_property(session: VTCompressionSessionRef, key: CFStringRef, value: bool) -> bool {
    let boolean = if value {
        CFBoolean::true_value()
    } else {
        CFBoolean::false_value()
    };
    set_property(session, key, boolean.as_CFTypeRef())
}

fn set_string_property(session: VTCompressionSessionRef, key: CFStringRef, value: CFString) -> bool {
    set_property(session, key, value.as_CFTypeRef())
}

fn nalu_type(nal: &[u8]) -> u8 {
    nal.first().copied().unwrap_or(0) & 0x1f
}

fn parameter_sets(description: CMFormatDescriptionRef) -> Option<(Vec<u8>, Vec<u8>)> {
    if description.is_null() {
        return None;
    }
    let mut count = 0_usize;
    let mut header_length = 0_i32;
    let status = unsafe {
        CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            description,
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut count,
            &mut header_length,
        )
    };
    if status != 0 || count < 2 {
        return None;
    }
    let read = |index: usize| -> Option<Vec<u8>> {
        let mut pointer: *const u8 = std::ptr::null();
        let mut size = 0_usize;
        let status = unsafe {
            CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                description,
                index,
                &mut pointer,
                &mut size,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if status != 0 || pointer.is_null() || size == 0 || size > 4096 {
            return None;
        }
        Some(unsafe { std::slice::from_raw_parts(pointer, size) }.to_vec())
    };
    Some((read(0)?, read(1)?))
}

/// Convert VideoToolbox's AVCC (4-byte length prefixed) access unit into Annex-B, inserting
/// SPS/PPS in front of keyframes so the RTP H.264 payloader can emit STAP-A.
fn avcc_to_annex_b(data: &[u8], sps_pps: Option<(Vec<u8>, Vec<u8>)>) -> (Vec<u8>, bool) {
    let mut output = Vec::with_capacity(data.len() + 64);
    let mut keyframe = false;
    let mut offset = 0_usize;
    while offset + 4 <= data.len() {
        let length = u32::from_be_bytes([
            data[offset],
            data[offset + 1],
            data[offset + 2],
            data[offset + 3],
        ]) as usize;
        offset += 4;
        if length == 0 || offset + length > data.len() {
            break;
        }
        let nal = &data[offset..offset + length];
        let kind = nalu_type(nal);
        if kind == 5 {
            keyframe = true;
        }
        let cached_sets = sps_pps.is_some();
        if !(cached_sets && (kind == 7 || kind == 8)) && kind != 9 && kind != 12 {
            output.extend_from_slice(&[0, 0, 0, 1]);
            output.extend_from_slice(nal);
        }
        offset += length;
    }
    if keyframe {
        if let Some((sps, pps)) = sps_pps {
            let mut with_sets = Vec::with_capacity(output.len() + sps.len() + pps.len() + 8);
            with_sets.extend_from_slice(&[0, 0, 0, 1]);
            with_sets.extend_from_slice(&sps);
            with_sets.extend_from_slice(&[0, 0, 0, 1]);
            with_sets.extend_from_slice(&pps);
            with_sets.extend_from_slice(&output);
            return (with_sets, true);
        }
    }
    (output, keyframe)
}

fn push_error(shared: &Shared, message: impl Into<String>) {
    if let Ok(mut errors) = shared.errors.lock() {
        if errors.len() >= 8 {
            errors.pop_front();
        }
        errors.push_back(message.into());
    }
}

extern "C" fn output_callback(
    ref_con: *mut c_void,
    _source_frame_ref_con: *mut c_void,
    status: OSStatus,
    info_flags: VTEncodeInfoFlags,
    sample_buffer: CMSampleBufferRef,
) {
    if ref_con.is_null() {
        return;
    }
    let shared = unsafe { &*(ref_con as *const Shared) };
    if status != 0 {
        push_error(shared, format!("DESKTOP_ENCODE_FAILED_{status}"));
        return;
    }
    if sample_buffer.is_null() || info_flags & VT_ENCODE_INFO_FRAME_DROPPED != 0 {
        return;
    }

    let block = unsafe { CMSampleBufferGetDataBuffer(sample_buffer) };
    if block.is_null() {
        return;
    }
    let length = unsafe { CMBlockBufferGetDataLength(block) };
    if length == 0 || length > 8 * 1024 * 1024 {
        return;
    }
    let mut avcc = vec![0_u8; length];
    if unsafe { CMBlockBufferCopyDataBytes(block, 0, length, avcc.as_mut_ptr() as *mut c_void) } != 0
    {
        push_error(shared, "DESKTOP_ENCODE_COPY_FAILED");
        return;
    }

    let description = unsafe { CMSampleBufferGetFormatDescription(sample_buffer) };
    let (data, keyframe) = avcc_to_annex_b(&avcc, parameter_sets(description));
    if data.is_empty() {
        return;
    }

    let pts = unsafe { CMSampleBufferGetPresentationTimeStamp(sample_buffer) };
    let pts_seconds = if pts.timescale > 0 {
        pts.value as f64 / pts.timescale as f64
    } else {
        0.0
    };
    let mut last = shared.last_pts.lock().unwrap();
    let mut duration = if *last > 0.0 && pts_seconds > *last {
        Duration::from_secs_f64((pts_seconds - *last).min(0.5))
    } else {
        Duration::from_micros(1_000_000 / shared.fps.max(1) as u64)
    };
    if duration < Duration::from_millis(1) {
        duration = Duration::from_millis(1);
    }
    *last = pts_seconds;
    drop(last);

    let _ = keyframe;
    let frame = EncodedFrame {
        data: Bytes::from(data),
        duration,
    };
    match shared.output.try_send(frame) {
        Ok(()) => {}
        Err(TrySendError::Full(frame)) => {
            // Real-time first: the queue is deliberately tiny, so dropping the new frame
            // bounds latency to a few frame intervals instead of accumulating a backlog.
            shared.dropped.fetch_add(1, Ordering::Relaxed);
            drop(frame);
        }
        Err(TrySendError::Disconnected(_)) => {}
    }
}

fn encode_loop(shared: Arc<Shared>, frames: Receiver<CapturedFrame>) {
    while shared.running.load(Ordering::Relaxed) {
        let frame = match frames.recv_timeout(Duration::from_millis(50)) {
            Ok(frame) => frame,
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => continue,
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
        };
        let force = shared.force_keyframe.swap(false, Ordering::AcqRel);
        let frame_properties = if force {
            let key = unsafe { CFString::wrap_under_get_rule(kVTEncodeFrameOptionKey_ForceKeyFrame) };
            let value = CFBoolean::true_value().as_CFType();
            Some(CFDictionary::from_CFType_pairs(&[(key, value)]))
        } else {
            None
        };
        let pts = CMTime {
            value: (frame.pts_seconds * 1_000_000.0) as i64,
            timescale: 1_000_000,
            flags: 1,
            epoch: 0,
        };
        let duration = CMTime {
            value: 1,
            timescale: shared.fps.max(1) as i32,
            flags: 1,
            epoch: 0,
        };
        let session = *shared.session.lock().unwrap();
        if !session.is_null() {
            let mut info_flags = 0_u32;
            let status = unsafe {
                VTCompressionSessionEncodeFrame(
                    session,
                    frame.buffer(),
                    pts,
                    duration,
                    frame_properties
                        .as_ref()
                        .map(|value| value.as_CFTypeRef())
                        .unwrap_or(std::ptr::null()),
                    std::ptr::null_mut(),
                    &mut info_flags,
                )
            };
            if status != 0 {
                push_error(&shared, format!("DESKTOP_ENCODE_FAILED_{status}"));
            }
        }
        // VTCompressionSessionEncodeFrame retains the buffer for as long as it needs it.
        drop(frame);
    }
}

impl Encoder {
    pub fn start(
        width: u32,
        height: u32,
        fps: u32,
        bitrate: u32,
        frames: Receiver<CapturedFrame>,
        output: Sender<EncodedFrame>,
        force_keyframe: Arc<AtomicBool>,
    ) -> Result<Self, String> {
        let shared = Arc::new(Shared {
            session: Mutex::new(std::ptr::null_mut()),
            output,
            last_pts: Mutex::new(0.0),
            force_keyframe,
            bitrate: AtomicU64::new(bitrate as u64),
            running: AtomicBool::new(true),
            errors: Mutex::new(VecDeque::new()),
            dropped: AtomicU64::new(0),
            fps,
        });
        let mut session: VTCompressionSessionRef = std::ptr::null_mut();
        let status = unsafe {
            VTCompressionSessionCreate(
                std::ptr::null(),
                width as i32,
                height as i32,
                CM_VIDEO_CODEC_TYPE_H264,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                Some(output_callback),
                Arc::as_ptr(&shared) as *mut c_void,
                &mut session,
            )
        };
        if status != 0 || session.is_null() {
            return Err(format!("DESKTOP_ENCODER_CREATE_FAILED_{status}"));
        }

        let profile = unsafe {
            CFString::wrap_under_get_rule(kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel)
        };
        set_bool_property(
            session,
            unsafe { kVTCompressionPropertyKey_RealTime },
            true,
        );
        set_string_property(
            session,
            unsafe { kVTCompressionPropertyKey_ProfileLevel },
            profile,
        );
        set_bool_property(
            session,
            unsafe { kVTCompressionPropertyKey_AllowFrameReordering },
            false,
        );
        set_bool_property(
            session,
            unsafe { kVTCompressionPropertyKey_AllowOpenGOP },
            false,
        );
        set_i32_property(
            session,
            unsafe { kVTCompressionPropertyKey_AverageBitRate },
            bitrate as i32,
        );
        set_i32_property(
            session,
            unsafe { kVTCompressionPropertyKey_MaxKeyFrameInterval },
            (fps as i32 * 2).max(1),
        );
        set_i32_property(
            session,
            unsafe { kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration },
            2,
        );
        let expected = CFNumber::from(fps as f64);
        let _ = set_property(
            session,
            unsafe { kVTCompressionPropertyKey_ExpectedFrameRate },
            expected.as_CFTypeRef(),
        );
        unsafe { VTCompressionSessionPrepareToEncodeFrames(session) };
        *shared.session.lock().unwrap() = session;

        let thread = {
            let shared = shared.clone();
            std::thread::Builder::new()
                .name("lanfly-h264".to_owned())
                .spawn(move || encode_loop(shared, frames))
                .map_err(|_| "DESKTOP_ENCODER_THREAD".to_owned())?
        };
        Ok(Self {
            shared,
            thread: Some(thread),
        })
    }

    pub fn set_bitrate(&self, bitrate: u32) -> bool {
        let bitrate = bitrate.clamp(256_000, 24_000_000);
        self.shared.bitrate.store(bitrate as u64, Ordering::Relaxed);
        let session = *self.shared.session.lock().unwrap();
        if session.is_null() {
            return false;
        }
        set_i32_property(
            session,
            unsafe { kVTCompressionPropertyKey_AverageBitRate },
            bitrate as i32,
        )
    }

    pub fn take_error(&self) -> Option<String> {
        self.shared
            .errors
            .lock()
            .ok()
            .and_then(|mut errors| errors.pop_front())
    }

    pub fn stop(&mut self) {
        self.shared.running.store(false, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        let session = {
            let mut session = self.shared.session.lock().unwrap();
            std::mem::replace(&mut *session, std::ptr::null_mut())
        };
        if !session.is_null() {
            unsafe {
                VTCompressionSessionCompleteFrames(session, CM_TIME_INVALID);
                VTCompressionSessionInvalidate(session);
                CFRelease(session as CFTypeRef);
            }
        }
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_avcc_into_annex_b_and_marks_idr() {
        let mut data = Vec::new();
        data.extend_from_slice(&2_u32.to_be_bytes());
        data.extend_from_slice(&[0x65, 0x88]);
        data.extend_from_slice(&2_u32.to_be_bytes());
        data.extend_from_slice(&[0x41, 0x01]);
        let (annex, keyframe) = avcc_to_annex_b(&data, None);
        assert!(keyframe);
        assert_eq!(&annex[..5], &[0, 0, 0, 1, 0x65]);
    }

    #[test]
    fn inserts_sps_and_pps_before_keyframes_only() {
        let mut data = Vec::new();
        data.extend_from_slice(&2_u32.to_be_bytes());
        data.extend_from_slice(&[0x65, 0x88]);
        let (annex, keyframe) = avcc_to_annex_b(&data, Some((vec![0x67], vec![0x68])));
        assert!(keyframe);
        assert_eq!(&annex[..5], &[0, 0, 0, 1, 0x67]);
        assert_eq!(&annex[5..10], &[0, 0, 0, 1, 0x68]);
    }
}
