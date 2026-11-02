use std::{any::Any, marker::PhantomData, rc::Rc};

/// An owned platform accessibility payload.
///
/// Platform adapters may store a native RAII wrapper or a worker-thread token.
/// The payload is destroyed exactly once when this value is dropped. The handle
/// is intentionally neither `Send` nor `Sync` so thread-affine platform objects
/// cannot cross threads through the platform-neutral API.
///
/// ```compile_fail
/// use agent_desktop_core::NativeHandle;
/// fn require_send<T: Send>() {}
/// require_send::<NativeHandle>();
/// ```
///
/// ```compile_fail
/// use agent_desktop_core::NativeHandle;
/// fn require_sync<T: Sync>() {}
/// require_sync::<NativeHandle>();
/// ```
pub struct NativeHandle {
    payload: Option<Box<dyn Any>>,
    _thread_affinity: PhantomData<Rc<()>>,
}

impl NativeHandle {
    /// Owns a platform-specific payload until this handle is dropped.
    pub fn new<T: Any>(payload: T) -> Self {
        Self {
            payload: Some(Box::new(payload)),
            _thread_affinity: PhantomData,
        }
    }

    /// Borrows the payload when it has the requested platform-specific type.
    pub fn downcast_ref<T: Any>(&self) -> Option<&T> {
        self.payload.as_deref()?.downcast_ref::<T>()
    }

    /// Returns an empty handle for adapters and tests without a native payload.
    pub fn null() -> Self {
        Self {
            payload: None,
            _thread_affinity: PhantomData,
        }
    }

    /// Reports whether this handle has no platform payload.
    pub fn is_null(&self) -> bool {
        self.payload.is_none()
    }
}

#[cfg(test)]
mod tests {
    use super::NativeHandle;
    use std::{cell::Cell, rc::Rc};

    struct DropProbe(Rc<Cell<u32>>);

    impl Drop for DropProbe {
        fn drop(&mut self) {
            self.0.set(self.0.get() + 1);
        }
    }

    #[test]
    fn owns_and_downcasts_typed_payload() {
        let handle = NativeHandle::new(String::from("platform-token"));

        assert_eq!(
            handle.downcast_ref::<String>().map(String::as_str),
            Some("platform-token")
        );
        assert!(handle.downcast_ref::<u64>().is_none());
        assert!(!handle.is_null());
    }

    #[test]
    fn drops_payload_exactly_once() {
        let drops = Rc::new(Cell::new(0));
        {
            let _handle = NativeHandle::new(DropProbe(Rc::clone(&drops)));
            assert_eq!(drops.get(), 0);
        }
        assert_eq!(drops.get(), 1);
    }

    #[test]
    fn null_has_no_typed_payload() {
        let handle = NativeHandle::null();

        assert!(handle.is_null());
        assert!(handle.downcast_ref::<String>().is_none());
    }
}
