#[cfg(target_os = "macos")]
mod imp {
    use accessibility_sys::AXUIElementRef;
    use agent_desktop_core::NativeHandle;
    use core_foundation::base::{CFRelease, CFRetain, CFTypeRef};

    pub struct AXElement(pub(crate) AXUIElementRef);

    impl AXElement {
        pub(crate) fn into_native_handle(self) -> NativeHandle {
            NativeHandle::new(self)
        }
    }

    impl Drop for AXElement {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CFRelease(self.0 as CFTypeRef) }
            }
        }
    }

    impl Clone for AXElement {
        fn clone(&self) -> Self {
            if !self.0.is_null() {
                unsafe { CFRetain(self.0 as CFTypeRef) };
            }
            AXElement(self.0)
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use agent_desktop_core::NativeHandle;

    pub struct AXElement(pub(crate) *const std::ffi::c_void);

    impl AXElement {
        pub(crate) fn into_native_handle(self) -> NativeHandle {
            NativeHandle::new(self)
        }
    }

    impl Drop for AXElement {
        fn drop(&mut self) {}
    }

    impl Clone for AXElement {
        fn clone(&self) -> Self {
            AXElement(self.0)
        }
    }
}

pub(crate) use imp::AXElement;

#[cfg(test)]
mod tests {
    use super::AXElement;

    #[test]
    fn converts_to_an_owned_typed_native_handle() {
        let handle = AXElement(std::ptr::null_mut()).into_native_handle();

        assert!(handle.downcast_ref::<AXElement>().is_some());
    }
}
