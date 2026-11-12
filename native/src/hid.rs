//! Physical Caps observation and the receiving Mac's configured input-source shortcut.
//! A synthetic Caps flagsChanged event is not an input-source switching API.
unsafe extern "C" {
    fn lanfly_caps_monitor_start(callback: extern "C" fn()) -> bool;
    fn lanfly_input_source_shortcut(tag: i64) -> i32;
}

pub fn monitor_caps(callback: extern "C" fn()) -> bool {
    unsafe { lanfly_caps_monitor_start(callback) }
}

pub fn input_source_shortcut() -> i32 {
    unsafe { lanfly_input_source_shortcut(0x4c41_4e46_4c59) }
}
