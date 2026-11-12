fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }

    cc::Build::new()
        .file("src/input_source_bridge.m")
        .flag("-fobjc-arc")
        .flag("-mmacosx-version-min=12.0")
        .compile("lanfly_input_source");

    cc::Build::new()
        .file("src/desktop_capture.mm")
        .flag("-fobjc-arc")
        .flag("-fblocks")
        .flag("-Wno-deprecated-declarations")
        .flag("-Wno-unguarded-availability-new")
        .flag("-Wno-unused-parameter")
        .flag("-mmacosx-version-min=12.0")
        .compile("lanfly_desktop_capture");

    println!("cargo:rustc-link-lib=framework=ScreenCaptureKit");
    println!("cargo:rustc-link-lib=framework=CoreMedia");
    println!("cargo:rustc-link-lib=framework=CoreVideo");
    println!("cargo:rustc-link-lib=framework=CoreGraphics");
    println!("cargo:rustc-link-lib=framework=VideoToolbox");
    println!("cargo:rustc-link-lib=framework=Foundation");
    println!("cargo:rustc-link-lib=framework=IOKit");
    println!("cargo:rustc-link-lib=c++");
    println!("cargo:rerun-if-changed=src/desktop_capture.mm");
    println!("cargo:rerun-if-changed=src/input_source_bridge.m");
}
