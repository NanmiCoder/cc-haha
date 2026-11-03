use crate::error::AdResult;

#[unsafe(no_mangle)]
pub extern "C" fn ad_test_panic_boundary() -> AdResult {
    crate::ffi_try::trap_panic(|| panic!("synthetic panic at the exported cdylib boundary"))
}
