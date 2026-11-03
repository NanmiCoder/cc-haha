use super::{GdiDcPair, gdi_balance, reject_oversized_capture, restore_selected_bitmap};
use agent_desktop_core::ErrorCode;

#[test]
fn capture_dimensions_stop_at_the_png_pixel_budget() {
    reject_oversized_capture(8_192, 8_192).expect("the 64M-pixel boundary is accepted");
    let error = reject_oversized_capture(8_193, 8_192)
        .expect_err("one pixel over the boundary is rejected before allocation");
    assert_eq!(error.code, ErrorCode::InvalidArgs);
}

/// A bitmap still selected into a DC cannot be deleted, so a failed restore
/// leaks it for the life of the process. Releasing the balance counter anyway
/// would erase the only evidence that the leak happened, and the exhaustion
/// condition that causes the failure is exactly when that evidence matters.
#[test]
#[cfg(target_os = "windows")]
fn a_failed_restore_of_the_previous_selection_is_not_recorded_as_released() {
    use windows_sys::Win32::Graphics::Gdi::{CreateCompatibleBitmap, SelectObject};

    gdi_balance::reset();
    let Ok(pair) = GdiDcPair::create("gdi restore guard") else {
        panic!("the test host must be able to create a screen and memory DC");
    };
    let bitmap = unsafe { CreateCompatibleBitmap(pair.screen_dc, 4, 4) };
    assert!(
        !bitmap.is_null(),
        "the test host must allocate a 4x4 bitmap"
    );
    let previous = unsafe { SelectObject(pair.memory_dc, bitmap) };
    assert!(!previous.is_null(), "selecting a fresh bitmap must succeed");
    gdi_balance::acquire();

    let live_before = gdi_balance::live();
    restore_selected_bitmap(pair.memory_dc, std::ptr::null_mut(), bitmap);

    assert_eq!(
        gdi_balance::live(),
        live_before,
        "restoring a null selection fails, so the bitmap is still selected and \
         cannot have been deleted; releasing the counter would report a freed \
         object that is still alive"
    );

    restore_selected_bitmap(pair.memory_dc, previous, bitmap);
    assert_eq!(
        gdi_balance::live(),
        live_before - 1,
        "a restore that succeeds does release the counter"
    );
}
