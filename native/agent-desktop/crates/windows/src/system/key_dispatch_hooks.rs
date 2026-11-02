use std::cell::{Cell, RefCell};

pub(super) mod force_higher_integrity {
    use super::Cell;

    thread_local! {
        static ACTIVE: Cell<bool> = const { Cell::new(false) };
    }

    pub(crate) fn is_active() -> bool {
        ACTIVE.with(Cell::get)
    }

    pub(crate) fn with<R>(run: impl FnOnce() -> R) -> R {
        crate::system::fixture::test_support::with_flag(&ACTIVE, true, run)
    }
}

pub(super) mod force_focus_lost {
    use super::Cell;

    thread_local! {
        static ACTIVE: Cell<bool> = const { Cell::new(false) };
    }

    pub(crate) fn is_active() -> bool {
        ACTIVE.with(Cell::get)
    }

    pub(crate) fn arm() {
        ACTIVE.with(|flag| flag.set(true));
    }

    pub(crate) fn with_armed_after_hook<R>(
        mut hook: impl FnMut() + 'static,
        run: impl FnOnce() -> R,
    ) -> R {
        struct ResetOnDrop;
        impl Drop for ResetOnDrop {
            fn drop(&mut self) {
                ACTIVE.with(|flag| flag.set(false));
                super::between_verify_and_inject::clear();
            }
        }
        super::between_verify_and_inject::install(Box::new(move || {
            hook();
            arm();
        }));
        let _reset = ResetOnDrop;
        run()
    }
}

pub(super) mod between_verify_and_inject {
    use super::RefCell;

    thread_local! {
        static HOOK: RefCell<Option<Box<dyn FnMut()>>> = RefCell::new(None);
    }

    pub(crate) fn run() {
        HOOK.with(|cell| {
            if let Some(hook) = cell.borrow_mut().as_mut() {
                hook();
            }
        });
    }

    pub(crate) fn install(hook: Box<dyn FnMut()>) {
        HOOK.with(|cell| *cell.borrow_mut() = Some(hook));
    }

    pub(crate) fn clear() {
        HOOK.with(|cell| *cell.borrow_mut() = None);
    }
}

pub(super) mod synthesis_probe {
    use super::Cell;

    thread_local! {
        static COUNT: Cell<u32> = const { Cell::new(0) };
    }

    pub(crate) fn note() {
        COUNT.with(|cell| cell.set(cell.get() + 1));
    }

    pub(crate) fn count() -> u32 {
        COUNT.with(Cell::get)
    }

    pub(crate) fn reset() {
        COUNT.with(|cell| cell.set(0));
    }
}

pub(super) mod force_keyboard_focus_denied {
    use super::Cell;

    thread_local! {
        static ACTIVE: Cell<bool> = const { Cell::new(false) };
    }

    pub(crate) fn is_active() -> bool {
        ACTIVE.with(Cell::get)
    }

    pub(crate) fn with<R>(run: impl FnOnce() -> R) -> R {
        crate::system::fixture::test_support::with_flag(&ACTIVE, true, run)
    }
}
