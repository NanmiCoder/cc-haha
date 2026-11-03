//! The `Cell<Option<u32>>` sibling of `test_support::with_flag` /
//! `with_usize_flag`: arms a thread-local with a value for the closure's
//! run, resetting to `None` even on panic. Kept apart from `test_support.rs`
//! only because that file is already at the crate's 400-line file cap.

use std::cell::Cell;

pub(crate) fn with_option_u32_flag<R>(
    flag: &'static std::thread::LocalKey<Cell<Option<u32>>>,
    value: u32,
    run: impl FnOnce() -> R,
) -> R {
    struct ResetOnDrop(&'static std::thread::LocalKey<Cell<Option<u32>>>);
    impl Drop for ResetOnDrop {
        fn drop(&mut self) {
            self.0.with(|cell| cell.set(None));
        }
    }
    flag.with(|cell| cell.set(Some(value)));
    let _reset = ResetOnDrop(flag);
    run()
}
