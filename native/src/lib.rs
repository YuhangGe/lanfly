use neon::prelude::*;

#[cfg(any(target_os = "macos", test))]
mod cursor;

#[cfg(any(target_os = "macos", test))]
mod keyboard;

#[cfg(target_os = "macos")]
mod macos;

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

#[neon::main]
fn main(mut cx: ModuleContext) -> NeonResult<()> {
    cx.export_function("status", status)?;
    cx.export_function("requestPermissions", permissions)?;
    cx.export_function("start", start)?;
    cx.export_function("poll", poll)?;
    cx.export_function("inject", inject)?;
    cx.export_function("reset", reset)?;
    cx.export_function("stop", stop)?;
    Ok(())
}
