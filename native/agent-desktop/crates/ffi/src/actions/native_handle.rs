use crate::AdAdapter;
use crate::error::{AdResult, set_last_error};
use crate::ffi_try::trap_panic;
use crate::types::AdNativeHandle;
use agent_desktop_core::{NativeHandle, ProcessIdentity};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::atomic::AtomicUsize;

static NEXT_HANDLE_ID: AtomicUsize = AtomicUsize::new(1);

struct NativeHandleRecord {
    owner_adapter_id: usize,
    handle: Rc<NativeHandle>,
    process: ProcessIdentity,
}

thread_local! {
    static HANDLES: RefCell<HashMap<usize, NativeHandleRecord>> = RefCell::new(HashMap::new());
}

/// Releases a handle previously returned by an exact resolver and
/// zeroes the caller's struct so accidentally calling this twice is
/// a deterministic no-op instead of dropping its owned payload twice.
///
/// `AdNativeHandle.ptr` is an opaque registry token, not an operating-system
/// or Rust allocation address. Removing it releases the platform payload.
///
/// Ownership contract: the FFI owns the handle from the moment a resolver
/// writes `ptr`. Copying the struct after that point is unsupported. Releasing
/// the original zeroes it and makes a second release of that same struct a
/// no-op; releasing an unzeroed copy is rejected.
///
/// # Safety
///
/// `adapter` must be a non-null pointer returned by `ad_adapter_create`.
/// It must identify the same adapter that created the handle. The adapter may
/// already have been destroyed; handles remain independently owned until freed.
/// `handle` must be null or a `*mut AdNativeHandle` previously populated by an
/// exact resolver on the calling thread. On return `(*handle).ptr` is
/// `NULL` so a double-call is a no-op instead of a double-free.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_free_handle(
    adapter: *const AdAdapter,
    handle: *mut AdNativeHandle,
) -> AdResult {
    trap_panic(|| unsafe {
        let adapter_id = match crate::adapter::adapter_id(adapter) {
            Ok(id) => id,
            Err(error) => {
                set_last_error(&error);
                return AdResult::ErrInvalidArgs;
            }
        };
        if handle.is_null() {
            return AdResult::Ok;
        }
        let token = (*handle).ptr;
        if token.is_null() {
            return AdResult::Ok;
        }
        let result = release_ffi_handle(adapter_id, token.addr());
        match result {
            Ok(()) => {
                (*handle).ptr = std::ptr::null();
                AdResult::Ok
            }
            Err(error) => {
                set_last_error(&error);
                AdResult::ErrInvalidArgs
            }
        }
    })
}

pub(crate) fn into_ffi_handle(
    owner_adapter_id: usize,
    handle: NativeHandle,
    process: ProcessIdentity,
) -> Result<*const std::ffi::c_void, agent_desktop_core::AdapterError> {
    let id = crate::opaque_id::allocate(&NEXT_HANDLE_ID, "Native handle")?;
    HANDLES.with(|handles| {
        handles.borrow_mut().insert(
            id,
            NativeHandleRecord {
                owner_adapter_id,
                handle: Rc::new(handle),
                process,
            },
        );
    });
    Ok(std::ptr::with_exposed_provenance(id))
}

pub(crate) fn acquire_ffi_handle(
    owner_adapter_id: usize,
    handle: &AdNativeHandle,
) -> Result<(Rc<NativeHandle>, ProcessIdentity), agent_desktop_core::AdapterError> {
    if handle.ptr.is_null() {
        return Err(agent_desktop_core::AdapterError::new(
            agent_desktop_core::ErrorCode::InvalidArgs,
            "handle.ptr is null — the handle has already been freed or was never resolved",
        ));
    }
    HANDLES
        .with(|handles| {
            handles.borrow().get(&handle.ptr.addr()).and_then(|record| {
                (record.owner_adapter_id == owner_adapter_id)
                    .then(|| (Rc::clone(&record.handle), record.process.clone()))
            })
        })
        .ok_or_else(|| {
            agent_desktop_core::AdapterError::new(
                agent_desktop_core::ErrorCode::InvalidArgs,
                "native handle is invalid, freed, belongs to another adapter, or belongs to another thread",
            )
        })
}

fn release_ffi_handle(
    owner_adapter_id: usize,
    handle_id: usize,
) -> Result<(), agent_desktop_core::AdapterError> {
    HANDLES.with(|handles| {
        let mut handles = handles.borrow_mut();
        match handles.get(&handle_id) {
            Some(record) if record.owner_adapter_id == owner_adapter_id => {
                handles.remove(&handle_id);
                Ok(())
            }
            _ => Err(agent_desktop_core::AdapterError::new(
                agent_desktop_core::ErrorCode::InvalidArgs,
                "native handle is invalid, freed, belongs to another adapter, or belongs to another thread",
            )),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    struct DropProbe(Rc<Cell<u32>>);

    fn process() -> ProcessIdentity {
        ProcessIdentity::new(42, "generation-1")
    }

    impl Drop for DropProbe {
        fn drop(&mut self) {
            self.0.set(self.0.get() + 1);
        }
    }

    #[test]
    fn handle_cannot_cross_adapter_identity() {
        let token = into_ffi_handle(41, NativeHandle::null(), process()).unwrap();
        let handle = AdNativeHandle { ptr: token };

        assert!(acquire_ffi_handle(42, &handle).is_err());
        assert!(release_ffi_handle(42, token.addr()).is_err());
        assert!(acquire_ffi_handle(41, &handle).is_ok());
        assert!(release_ffi_handle(41, token.addr()).is_ok());
    }

    #[test]
    fn successful_release_drops_payload_once() {
        let drops = Rc::new(Cell::new(0));
        let token = into_ffi_handle(
            71,
            NativeHandle::new(DropProbe(Rc::clone(&drops))),
            process(),
        )
        .unwrap();

        assert!(release_ffi_handle(71, token.addr()).is_ok());
        assert_eq!(drops.get(), 1);
        assert!(release_ffi_handle(71, token.addr()).is_err());
        assert_eq!(drops.get(), 1);
    }

    #[test]
    fn public_free_rejects_wrong_adapter_without_consuming_handle() {
        let owner = crate::adapter::ad_adapter_create();
        let other = crate::adapter::ad_adapter_create();
        let token = into_ffi_handle(owner.addr(), NativeHandle::null(), process()).unwrap();
        let mut handle = AdNativeHandle { ptr: token };

        let wrong = unsafe { ad_free_handle(other, &mut handle) };
        assert_eq!(wrong, AdResult::ErrInvalidArgs);
        assert_eq!(handle.ptr, token);
        assert_eq!(unsafe { ad_free_handle(owner, &mut handle) }, AdResult::Ok);
        assert!(handle.ptr.is_null());

        unsafe {
            crate::adapter::ad_adapter_destroy(owner);
            crate::adapter::ad_adapter_destroy(other);
        }
    }

    #[test]
    fn handle_can_be_freed_after_adapter_destruction() {
        let owner = crate::adapter::ad_adapter_create();
        let token = into_ffi_handle(owner.addr(), NativeHandle::null(), process()).unwrap();
        let mut handle = AdNativeHandle { ptr: token };

        unsafe { crate::adapter::ad_adapter_destroy(owner) };

        assert_eq!(unsafe { ad_free_handle(owner, &mut handle) }, AdResult::Ok);
        assert!(handle.ptr.is_null());
    }
}
