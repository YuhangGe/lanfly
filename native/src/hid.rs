//! Post a synthetic Caps Lock through the HID system, matching how Deskflow handles modifiers.
//! CGEvent keyboard events do not reliably trigger the macOS Caps Lock/input-source behavior.
use std::ffi::{c_char, c_void};
use std::sync::OnceLock;

const KERN_SUCCESS: i32 = 0;
const NX_FLAGSCHANGED: u32 = 12;
const NX_EVENT_DATA_VERSION: u32 = 2;
const KIO_HID_PARAM_CONNECT_TYPE: u32 = 1;
const KIO_HID_SET_GLOBAL_EVENT_FLAGS: u32 = 1;
const ALPHA_SHIFT: u32 = 1 << 16;
const CAPS_LOCK_KEY: u16 = 57;

#[repr(C)]
struct IoGPoint {
    x: i32,
    y: i32,
}

#[link(name = "IOKit", kind = "framework")]
unsafe extern "C" {
    fn IOMasterPort(bootstrap_port: u32, master_port: *mut u32) -> i32;
    fn IOServiceMatching(name: *const c_char) -> *mut c_void;
    fn IOServiceGetMatchingServices(
        master_port: u32,
        matching: *mut c_void,
        existing: *mut u32,
    ) -> i32;
    fn IOIteratorNext(iterator: u32) -> u32;
    fn IOServiceOpen(service: u32, owning_task: u32, connect_type: u32, connect: *mut u32) -> i32;
    fn IOObjectRelease(object: u32) -> i32;
    fn IOHIDPostEvent(
        connect: u32,
        event_type: u32,
        location: IoGPoint,
        event_data: *const u8,
        event_data_version: u32,
        event_flags: u32,
        options: u32,
    ) -> i32;
    static mach_task_self_: u32;
}

fn open_driver() -> u32 {
    let mut master = 0;
    if unsafe { IOMasterPort(0, &mut master) } != KERN_SUCCESS {
        return 0;
    }
    let matching = unsafe { IOServiceMatching(c"IOHIDSystem".as_ptr()) };
    if matching.is_null() {
        return 0;
    }
    let mut iterator = 0;
    if unsafe { IOServiceGetMatchingServices(master, matching, &mut iterator) } != KERN_SUCCESS {
        return 0;
    }
    let service = unsafe { IOIteratorNext(iterator) };
    unsafe { IOObjectRelease(iterator) };
    if service == 0 {
        return 0;
    }
    let mut connection = 0;
    let result = unsafe {
        IOServiceOpen(
            service,
            mach_task_self_,
            KIO_HID_PARAM_CONNECT_TYPE,
            &mut connection,
        )
    };
    unsafe { IOObjectRelease(service) };
    if result == KERN_SUCCESS {
        connection
    } else {
        0
    }
}

fn post(driver: u32, flags: u32) -> bool {
    // NXEventData is an opaque union; key.keyCode lives at byte offset 8.
    let mut data = [0_u8; 256];
    data[8..10].copy_from_slice(&CAPS_LOCK_KEY.to_ne_bytes());
    unsafe {
        IOHIDPostEvent(
            driver,
            NX_FLAGSCHANGED,
            IoGPoint { x: 0, y: 0 },
            data.as_ptr(),
            NX_EVENT_DATA_VERSION,
            flags,
            KIO_HID_SET_GLOBAL_EVENT_FLAGS,
        ) == KERN_SUCCESS
    }
}

pub fn post_caps_lock() -> bool {
    static DRIVER: OnceLock<u32> = OnceLock::new();
    let driver = *DRIVER.get_or_init(open_driver);
    if driver == 0 {
        return false;
    }
    // A flags-changed down/up pair mirrors a physical Caps Lock press. The first event carries
    // AlphaShift; the release clears it so the next press can toggle again.
    post(driver, ALPHA_SHIFT) && post(driver, 0)
}
