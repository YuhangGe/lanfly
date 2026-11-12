//! Manual regression fixture: preserve the current source without capturing any keys/mouse.
//! A separate process changes the source while this main-thread loop is running.
#[cfg(target_os = "macos")]
#[allow(dead_code)]
#[path = "../src/hid.rs"]
mod hid;
#[cfg(target_os = "macos")]
#[allow(dead_code)]
#[path = "../src/input_source.rs"]
mod input_source;
#[cfg(target_os = "macos")]
#[allow(dead_code)]
#[path = "../src/macos_input_source.rs"]
mod macos_input_source;

#[cfg(target_os = "macos")]
#[link(name = "lanfly_input_source", kind = "static")]
unsafe extern "C" {}
#[cfg(target_os = "macos")]
#[link(name = "Foundation", kind = "framework")]
unsafe extern "C" {}
#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {}
#[cfg(target_os = "macos")]
#[link(name = "IOKit", kind = "framework")]
unsafe extern "C" {}

fn main() {
    #[cfg(target_os = "macos")]
    {
        use std::time::{Duration, Instant};
        let seconds = std::env::args()
            .nth(1)
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(8)
            .clamp(1, 60);
        assert!(macos_input_source::capture(false, false));
        assert!(macos_input_source::capture(true, false));
        println!("CAPTURE_READY");
        // The driver first proves that an independent process really changed
        // the global source, then creates this file to resume the guard.
        if let Some(release) = std::env::args().nth(2) {
            let deadline = Instant::now() + Duration::from_secs(15);
            while !std::path::Path::new(&release).exists() {
                assert!(Instant::now() < deadline, "driver did not release fixture");
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        let until = Instant::now() + Duration::from_secs(seconds);
        while Instant::now() < until {
            assert!(
                macos_input_source::capture(true, false),
                "source restoration failed"
            );
            std::thread::sleep(Duration::from_millis(4));
        }
        assert!(macos_input_source::capture(false, false));
    }
    #[cfg(not(target_os = "macos"))]
    panic!("This fixture requires macOS");
}
