use neon::prelude::*;

#[cfg(any(target_os = "macos", test))]
mod cursor;

#[cfg(any(target_os = "macos", test))]
mod keyboard;

#[cfg(any(target_os = "macos", test))]
mod input_source;

#[cfg(any(target_os = "macos", test))]
mod startup;

#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "macos")]
mod macos_input_source;

#[cfg(target_os = "macos")]
mod hid;

#[cfg(target_os = "macos")]
mod desktop;

#[cfg(target_os = "macos")]
mod desktop_capture;

#[cfg(target_os = "macos")]
mod desktop_encoder;

#[cfg(target_os = "macos")]
mod desktop_input;

fn status(mut cx: FunctionContext) -> JsResult<JsString> {
    #[cfg(target_os = "macos")]
    return Ok(cx.string(macos::status().to_string()));
    #[cfg(not(target_os = "macos"))]
    Ok(cx.string(r#"{"screens":0,"accessibility":false,"inputMonitoring":false}"#))
}

fn permissions(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    #[cfg(target_os = "macos")]
    macos::permissions();
    Ok(cx.undefined())
}

fn start(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let role = cx.argument::<JsString>(0)?.value(&mut cx);
    let edge = cx.argument::<JsString>(1)?.value(&mut cx);
    #[cfg(target_os = "macos")]
    if let Err(error) = macos::start(&role, &edge) {
        return cx.throw_error(error);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (role, edge);
        return cx.throw_error("INPUT_UNSUPPORTED");
    }
    #[allow(unreachable_code)]
    Ok(cx.undefined())
}

fn poll(mut cx: FunctionContext) -> JsResult<JsString> {
    #[cfg(target_os = "macos")]
    return Ok(cx.string(macos::poll().to_string()));
    #[cfg(not(target_os = "macos"))]
    Ok(cx.string("[]"))
}

fn inject(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let value = cx.argument::<JsString>(0)?.value(&mut cx);
    #[cfg(target_os = "macos")]
    if let Err(error) = macos::inject(&value) {
        return cx.throw_error(error);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = value;
    Ok(cx.undefined())
}

fn reset(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    #[cfg(target_os = "macos")]
    macos::reset();
    Ok(cx.undefined())
}

fn stop(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    #[cfg(target_os = "macos")]
    macos::stop();
    Ok(cx.undefined())
}

fn desktop_status(mut cx: FunctionContext) -> JsResult<JsString> {
    #[cfg(target_os = "macos")]
    return Ok(cx.string(desktop::status().to_string()));
    #[cfg(not(target_os = "macos"))]
    Ok(cx.string(
        r#"{"supported":false,"available":false,"screenRecording":false,"accessibility":false,"screens":0}"#,
    ))
}

fn desktop_permissions(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    #[cfg(target_os = "macos")]
    desktop::request_permissions();
    Ok(cx.undefined())
}

fn desktop_start(mut cx: FunctionContext) -> JsResult<JsString> {
    let session = cx.argument::<JsString>(0)?.value(&mut cx);
    let config = cx.argument::<JsString>(1)?.value(&mut cx);
    #[cfg(target_os = "macos")]
    match desktop::start(&session, &config) {
        Ok(value) => Ok(cx.string(value.to_string())),
        Err(error) => cx.throw_error(error),
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (session, config);
        cx.throw_error("DESKTOP_UNSUPPORTED")
    }
}

fn desktop_offer(mut cx: FunctionContext) -> JsResult<JsString> {
    let session = cx.argument::<JsString>(0)?.value(&mut cx);
    let sdp = cx.argument::<JsString>(1)?.value(&mut cx);
    #[cfg(target_os = "macos")]
    match desktop::offer(&session, &sdp) {
        Ok(value) => Ok(cx.string(value)),
        Err(error) => cx.throw_error(error),
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (session, sdp);
        cx.throw_error("DESKTOP_UNSUPPORTED")
    }
}

fn desktop_ice(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let session = cx.argument::<JsString>(0)?.value(&mut cx);
    let candidate = cx.argument::<JsString>(1)?.value(&mut cx);
    #[cfg(target_os = "macos")]
    if let Err(error) = desktop::add_ice(&session, &candidate) {
        return cx.throw_error(error);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (session, candidate);
        return cx.throw_error("DESKTOP_UNSUPPORTED");
    }
    Ok(cx.undefined())
}

fn desktop_stop(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let session = cx.argument::<JsString>(0)?.value(&mut cx);
    #[cfg(target_os = "macos")]
    if let Err(error) = desktop::stop(&session) {
        return cx.throw_error(error);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = session;
        return cx.throw_error("DESKTOP_UNSUPPORTED");
    }
    Ok(cx.undefined())
}

fn desktop_stop_all(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    #[cfg(target_os = "macos")]
    desktop::stop_all();
    Ok(cx.undefined())
}

fn desktop_poll(mut cx: FunctionContext) -> JsResult<JsString> {
    #[cfg(target_os = "macos")]
    return Ok(cx.string(desktop::poll().to_string()));
    #[cfg(not(target_os = "macos"))]
    Ok(cx.string("[]"))
}

fn desktop_bitrate(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let session = cx.argument::<JsString>(0)?.value(&mut cx);
    let bitrate = cx.argument::<JsNumber>(1)?.value(&mut cx) as u32;
    #[cfg(target_os = "macos")]
    if let Err(error) = desktop::set_bitrate(&session, bitrate) {
        return cx.throw_error(error);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (session, bitrate);
        return cx.throw_error("DESKTOP_UNSUPPORTED");
    }
    Ok(cx.undefined())
}

fn desktop_keyframe(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let session = cx.argument::<JsString>(0)?.value(&mut cx);
    #[cfg(target_os = "macos")]
    if let Err(error) = desktop::request_keyframe(&session) {
        return cx.throw_error(error);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = session;
        return cx.throw_error("DESKTOP_UNSUPPORTED");
    }
    Ok(cx.undefined())
}

fn desktop_input(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let value = cx.argument::<JsString>(0)?.value(&mut cx);
    #[cfg(target_os = "macos")]
    if let Err(error) = desktop::input(&value) {
        return cx.throw_error(error);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = value;
        return cx.throw_error("DESKTOP_UNSUPPORTED");
    }
    Ok(cx.undefined())
}

#[neon::main]
fn main(mut cx: ModuleContext) -> NeonResult<()> {
    #[cfg(target_os = "macos")]
    {
        let mut channel = cx.channel();
        channel.unref(&mut cx);
        macos_input_source::initialize(channel);
    }
    cx.export_function("status", status)?;
    cx.export_function("requestPermissions", permissions)?;
    cx.export_function("start", start)?;
    cx.export_function("poll", poll)?;
    cx.export_function("inject", inject)?;
    cx.export_function("reset", reset)?;
    cx.export_function("stop", stop)?;
    cx.export_function("desktopStatus", desktop_status)?;
    cx.export_function("desktopRequestPermissions", desktop_permissions)?;
    cx.export_function("desktopStart", desktop_start)?;
    cx.export_function("desktopOffer", desktop_offer)?;
    cx.export_function("desktopIce", desktop_ice)?;
    cx.export_function("desktopStop", desktop_stop)?;
    cx.export_function("desktopStopAll", desktop_stop_all)?;
    cx.export_function("desktopPoll", desktop_poll)?;
    cx.export_function("desktopBitrate", desktop_bitrate)?;
    cx.export_function("desktopKeyframe", desktop_keyframe)?;
    cx.export_function("desktopInput", desktop_input)?;
    Ok(())
}
