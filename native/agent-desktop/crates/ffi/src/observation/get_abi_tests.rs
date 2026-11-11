use super::*;
use crate::actions::native_handle::into_ffi_handle;
use crate::adapter::AdAdapter;
use crate::types::AdNativeHandle;
use agent_desktop_core::{
    ActionOps, Deadline, InputOps, NativeHandle, ObservationOps, ProcessIdentity, Rect, SystemOps,
};

struct BoundsAdapter;

impl ActionOps for BoundsAdapter {}
impl InputOps for BoundsAdapter {}
impl SystemOps for BoundsAdapter {}

impl ObservationOps for BoundsAdapter {
    fn get_element_bounds(
        &self,
        _handle: &NativeHandle,
        _deadline: Deadline,
    ) -> Result<Option<Rect>, agent_desktop_core::AdapterError> {
        Ok(Some(Rect {
            x: 12.0,
            y: 34.0,
            width: 56.0,
            height: 78.0,
        }))
    }
}

/// The Windows adapter used to leave `get_element_bounds` on the trait's
/// `not_supported` default, so `ad_get("bounds")` hard-failed for every
/// caller regardless of the element. The fix is that the adapter now
/// implements it - `ad_get` itself was always a plain passthrough. This pins
/// the FFI side of that fix directly: an adapter that implements
/// `get_element_bounds` must have its answer reach the C boundary as `Ok`
/// with the bounds JSON, so a regression in the property dispatch or the
/// handle plumbing is caught even though no Windows-specific FFI code
/// exists to test.
#[test]
fn ad_get_bounds_reaches_the_c_boundary_when_the_adapter_implements_it() {
    let adapter = crate::adapter::register_adapter(AdAdapter {
        inner: Box::new(BoundsAdapter),
        session_id: None,
        _session_lease: None,
    })
    .unwrap();
    let adapter_id = adapter.addr();
    let token = into_ffi_handle(
        adapter_id,
        NativeHandle::null(),
        ProcessIdentity::new(42, "gen-1"),
    )
    .expect("a handle registers against the adapter that owns it");
    let handle = AdNativeHandle { ptr: token };
    let mut out: *mut std::os::raw::c_char = std::ptr::null_mut();

    let result = unsafe { ad_get(adapter, &handle, c"bounds".as_ptr(), &mut out) };

    assert_eq!(result, AdResult::Ok);
    assert!(
        !out.is_null(),
        "a supported bounds read must produce a JSON string, not a null out-pointer"
    );
    let json =
        unsafe { crate::convert::string::c_to_string(out) }.expect("bounds json is valid utf8");
    assert_eq!(json, "{\"x\":12,\"y\":34,\"width\":56,\"height\":78}");

    unsafe { crate::convert::string::free_c_string(out) };
    unsafe { crate::adapter::ad_adapter_destroy(adapter) };
}
