//! Direct probe of macOS AX APIs with raw API output and click validation.
//!
//!   cargo run -p agent-desktop-macos --features dev-tools --example ax_probe -- <AppName>

#[cfg(target_os = "macos")]
fn main() {
    let app_name = std::env::args().nth(1).unwrap_or_else(|| "Finder".into());
    println!("=== AX Probe: '{}' ===\n", app_name);

    let pid = find_pid(&app_name).expect("app not running");
    println!("[pid] {}", pid);

    probe_app(pid);
}

#[cfg(target_os = "macos")]
fn find_pid(name: &str) -> Option<i32> {
    let out = std::process::Command::new("pgrep")
        .arg("-xi")
        .arg(name)
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .lines()
        .next()?
        .trim()
        .parse()
        .ok()
}

#[cfg(target_os = "macos")]
fn probe_app(pid: i32) {
    use accessibility_sys::*;
    use core_foundation::base::CFTypeRef;

    let app = unsafe { AXUIElementCreateApplication(pid) };

    println!("\n[1] App element attribute names:");
    let attr_names = get_attribute_names(app);
    for n in &attr_names {
        println!("    {n}");
    }

    println!("\n[2] Windows via kAXWindowsAttribute:");
    let windows = get_ax_children(app, kAXWindowsAttribute);
    println!("    count = {}", windows.len());
    for (i, win) in windows.iter().enumerate() {
        let role = read_string(*win, kAXRoleAttribute);
        let title = read_string(*win, kAXTitleAttribute);
        let pos = read_cgpoint(*win, kAXPositionAttribute);
        let size = read_cgsize(*win, kAXSizeAttribute);
        println!(
            "    [{i}] role={:?} title={:?} pos={:?} size={:?}",
            role, title, pos, size
        );

        let children = get_ax_children(*win, kAXChildrenAttribute);
        println!("         children = {}", children.len());
        for (ci, child) in children.iter().enumerate().take(8) {
            let cr = read_string(*child, kAXRoleAttribute);
            let ct = read_string(*child, kAXTitleAttribute);
            let cd = read_string(*child, kAXDescriptionAttribute);
            let cv = read_string(*child, kAXValueAttribute);
            let cpos = read_cgpoint(*child, kAXPositionAttribute);
            let csz = read_cgsize(*child, kAXSizeAttribute);

            println!(
                "           [{ci}] role={:?} title={:?} desc={:?} val={:?}",
                cr, ct, cd, cv
            );
            println!("                 pos={:?} size={:?}", cpos, csz);

            let ax_err = ax_press(*child);
            println!(
                "                 kAXPressAction → err={} (0=ok, -25200=fail, -25206=action_unsupported)",
                ax_err
            );

            if let (Some(p), Some(s)) = (cpos, csz) {
                let cx = p.0 + s.0 / 2.0;
                let cy = p.1 + s.1 / 2.0;
                let cg_ok = cg_click(cx, cy);
                println!(
                    "                 CGEvent click at ({:.0},{:.0}) → {}",
                    cx,
                    cy,
                    if cg_ok { "OK" } else { "FAIL" }
                );
            } else {
                println!("                 CGEvent click → no bounds available");
            }

            release_ax(*child);
        }
        for child in children.iter().skip(8) {
            release_ax(*child);
        }

        release_ax(*win);
        if i >= 1 {
            break;
        }
    }

    println!("\n[5] AXUIElementCopyMultipleAttributeValues vs individual calls:");
    speed_test(app, pid);

    println!("\n[6] CGEvent scroll at (400, 400):");
    let ok = cg_scroll(400.0, 400.0, 0, -3);
    println!("    result = {}", if ok { "OK" } else { "FAIL" });

    unsafe { core_foundation::base::CFRelease(app as CFTypeRef) };
    println!("\n=== Done ===");
}

#[cfg(target_os = "macos")]
fn get_attribute_names(el: accessibility_sys::AXUIElementRef) -> Vec<String> {
    use accessibility_sys::*;
    use core_foundation::{array::CFArray, base::CFTypeRef, base::TCFType, string::CFString};

    let mut out_ref: CFTypeRef = std::ptr::null_mut();
    let err = unsafe { AXUIElementCopyAttributeNames(el, &mut out_ref as *mut _ as *mut _) };
    if err != kAXErrorSuccess || out_ref.is_null() {
        return vec![];
    }
    let arr = unsafe { CFArray::<CFString>::wrap_under_create_rule(out_ref as _) };
    arr.into_iter().map(|s| s.to_string()).collect()
}

/// Read an array-typed AX attribute, retaining each element so it stays alive.
#[cfg(target_os = "macos")]
fn get_ax_children(
    el: accessibility_sys::AXUIElementRef,
    attr: &str,
) -> Vec<accessibility_sys::AXUIElementRef> {
    use accessibility_sys::*;
    use core_foundation::{
        array::CFArray,
        base::{CFRetain, CFType, CFTypeRef, TCFType},
        string::CFString,
    };

    let key = CFString::new(attr);
    let mut val: CFTypeRef = std::ptr::null_mut();
    let err = unsafe { AXUIElementCopyAttributeValue(el, key.as_concrete_TypeRef(), &mut val) };
    if err != kAXErrorSuccess || val.is_null() {
        return vec![];
    }

    let arr = unsafe { CFArray::<CFType>::wrap_under_create_rule(val as _) };
    arr.into_iter()
        .filter_map(|item| {
            let ptr = item.as_concrete_TypeRef() as AXUIElementRef;
            if ptr.is_null() {
                return None;
            }
            unsafe { CFRetain(ptr as CFTypeRef) };
            Some(ptr)
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn release_ax(el: accessibility_sys::AXUIElementRef) {
    if !el.is_null() {
        unsafe { core_foundation::base::CFRelease(el as core_foundation::base::CFTypeRef) };
    }
}

#[cfg(target_os = "macos")]
fn read_string(el: accessibility_sys::AXUIElementRef, attr: &str) -> Option<String> {
    use accessibility_sys::*;
    use core_foundation::{
        base::{CFType, CFTypeRef, TCFType},
        string::CFString,
    };

    let key = CFString::new(attr);
    let mut val: CFTypeRef = std::ptr::null_mut();
    let err = unsafe { AXUIElementCopyAttributeValue(el, key.as_concrete_TypeRef(), &mut val) };
    if err != kAXErrorSuccess || val.is_null() {
        return None;
    }
    let cf = unsafe { CFType::wrap_under_create_rule(val) };
    cf.downcast::<CFString>().map(|s| s.to_string())
}

#[cfg(target_os = "macos")]
fn read_cgpoint(el: accessibility_sys::AXUIElementRef, attr: &str) -> Option<(f64, f64)> {
    use accessibility_sys::*;
    use core_foundation::{
        base::{CFTypeRef, TCFType},
        string::CFString,
    };
    use core_graphics::geometry::CGPoint;

    let key = CFString::new(attr);
    let mut val: CFTypeRef = std::ptr::null_mut();
    let err = unsafe { AXUIElementCopyAttributeValue(el, key.as_concrete_TypeRef(), &mut val) };
    if err != kAXErrorSuccess || val.is_null() {
        return None;
    }
    let mut pt = CGPoint::new(0.0, 0.0);
    let ok = unsafe {
        AXValueGetValue(
            val as _,
            kAXValueTypeCGPoint,
            &mut pt as *mut _ as *mut std::ffi::c_void,
        )
    };
    unsafe { core_foundation::base::CFRelease(val) };
    if ok { Some((pt.x, pt.y)) } else { None }
}

#[cfg(target_os = "macos")]
fn read_cgsize(el: accessibility_sys::AXUIElementRef, attr: &str) -> Option<(f64, f64)> {
    use accessibility_sys::*;
    use core_foundation::{
        base::{CFTypeRef, TCFType},
        string::CFString,
    };
    use core_graphics::geometry::CGSize;

    let key = CFString::new(attr);
    let mut val: CFTypeRef = std::ptr::null_mut();
    let err = unsafe { AXUIElementCopyAttributeValue(el, key.as_concrete_TypeRef(), &mut val) };
    if err != kAXErrorSuccess || val.is_null() {
        return None;
    }
    let mut sz = CGSize::new(0.0, 0.0);
    let ok = unsafe {
        AXValueGetValue(
            val as _,
            kAXValueTypeCGSize,
            &mut sz as *mut _ as *mut std::ffi::c_void,
        )
    };
    unsafe { core_foundation::base::CFRelease(val) };
    if ok {
        Some((sz.width, sz.height))
    } else {
        None
    }
}

#[cfg(target_os = "macos")]
fn ax_press(el: accessibility_sys::AXUIElementRef) -> i32 {
    use accessibility_sys::*;
    use core_foundation::{base::TCFType, string::CFString};
    let action = CFString::new(kAXPressAction);
    unsafe { AXUIElementPerformAction(el, action.as_concrete_TypeRef()) }
}

#[cfg(target_os = "macos")]
fn cg_click(x: f64, y: f64) -> bool {
    use core_graphics::{
        event::{CGEvent, CGEventTapLocation, CGEventType, CGMouseButton},
        event_source::{CGEventSource, CGEventSourceStateID},
        geometry::CGPoint,
    };
    let src = match CGEventSource::new(CGEventSourceStateID::HIDSystemState) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let pt = CGPoint::new(x, y);
    let down = CGEvent::new_mouse_event(
        src.clone(),
        CGEventType::LeftMouseDown,
        pt,
        CGMouseButton::Left,
    );
    let up = CGEvent::new_mouse_event(src, CGEventType::LeftMouseUp, pt, CGMouseButton::Left);
    match (down, up) {
        (Ok(d), Ok(u)) => {
            d.post(CGEventTapLocation::HID);
            u.post(CGEventTapLocation::HID);
            true
        }
        _ => false,
    }
}

#[cfg(target_os = "macos")]
fn cg_scroll(_x: f64, _y: f64, dx: i32, dy: i32) -> bool {
    use core_graphics::{
        event::{CGEvent, CGEventTapLocation, ScrollEventUnit},
        event_source::{CGEventSource, CGEventSourceStateID},
    };
    let src = match CGEventSource::new(CGEventSourceStateID::HIDSystemState) {
        Ok(s) => s,
        Err(_) => return false,
    };
    match CGEvent::new_scroll_event(src, ScrollEventUnit::LINE, 2, dy, dx, 0) {
        Ok(ev) => {
            ev.post(CGEventTapLocation::HID);
            true
        }
        Err(_) => false,
    }
}

#[cfg(target_os = "macos")]
fn speed_test(app: accessibility_sys::AXUIElementRef, _pid: i32) {
    use accessibility_sys::*;
    use core_foundation::{
        array::CFArray,
        base::{CFRelease, CFTypeRef, TCFType},
        string::CFString,
    };
    use std::time::Instant;

    let windows = get_ax_children(app, kAXWindowsAttribute);
    let el = if let Some(&w) = windows.first() {
        w
    } else {
        app
    };

    let attrs = [
        kAXRoleAttribute,
        kAXTitleAttribute,
        kAXDescriptionAttribute,
        kAXValueAttribute,
        kAXEnabledAttribute,
        kAXFocusedAttribute,
    ];
    let cf_attrs: Vec<CFString> = attrs.iter().map(|a| CFString::new(a)).collect();
    let cf_refs: Vec<_> = cf_attrs.iter().map(|s| s.as_concrete_TypeRef()).collect();
    let names_arr = CFArray::from_copyable(&cf_refs);

    let t = Instant::now();
    for _ in 0..100 {
        let mut res: CFTypeRef = std::ptr::null_mut();
        unsafe {
            AXUIElementCopyMultipleAttributeValues(
                el,
                names_arr.as_concrete_TypeRef(),
                0,
                &mut res as *mut _ as *mut _,
            )
        };
        if !res.is_null() {
            unsafe { CFRelease(res) };
        }
    }
    let multi = t.elapsed();

    let t2 = Instant::now();
    for _ in 0..100 {
        for attr in &attrs {
            let _ = read_string(el, attr);
        }
    }
    let single = t2.elapsed();

    println!(
        "    100x multi-attr:    {:?} ({:?}/call)",
        multi,
        multi / 100
    );
    println!(
        "    100x individual:    {:?} ({:?}/call)",
        single,
        single / 100
    );
    println!(
        "    speedup:            {:.1}x",
        single.as_nanos() as f64 / multi.as_nanos().max(1) as f64
    );

    for w in windows {
        release_ax(w);
    }
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("macOS only");
}
