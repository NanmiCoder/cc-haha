use agent_desktop_core::{AdapterError, ErrorCode, NativeHandle};

/// The verified process identity a resolved element carries, so the live-read
/// path can corroborate that the provider is still the one resolution verified
/// (followed by A14-9's rule: a dead provider's reads can succeed empty on
/// some builds), and the handle payload is the only place the generation token
/// survives from resolution to the reader.
#[derive(Debug, Clone)]
pub(crate) struct ProcessPayload {
    pub(crate) pid: u32,
    pub(crate) token: String,
}

#[cfg(target_os = "windows")]
mod imp {
    use super::ProcessPayload;

    /// Owns one UI Automation element for the crate.
    ///
    /// Refcounting is delegated on purpose. `uiautomation::UIElement` wraps a
    /// `windows-core` COM interface whose `Clone` is `AddRef` and whose `Drop`
    /// is `Release`, so a hand-written pair here would release twice. The
    /// encapsulation the macOS wrapper establishes is kept: the inner field is
    /// crate-visible only, there is no `Copy`, and there is no raw accessor.
    /// The second field is the verified process identity captured by the
    /// resolver (`ProcessPayload`), `None` on an element that never verified
    /// one.
    #[derive(Clone)]
    pub struct UIAElement(
        pub(crate) uiautomation::UIElement,
        pub(crate) Option<ProcessPayload>,
    );

    impl From<uiautomation::UIElement> for UIAElement {
        fn from(element: uiautomation::UIElement) -> Self {
            Self(element, None)
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::ProcessPayload;

    /// Canned stand-in so every tree module compiles on a non-Windows lane.
    #[derive(Clone)]
    pub struct UIAElement(pub(crate) CannedElement, pub(crate) Option<ProcessPayload>);

    #[derive(Clone, Default)]
    pub struct CannedElement;

    impl From<CannedElement> for UIAElement {
        fn from(element: CannedElement) -> Self {
            Self(element, None)
        }
    }
}

pub use imp::UIAElement;

#[cfg(not(target_os = "windows"))]
pub use imp::CannedElement;

impl UIAElement {
    /// Moves ownership of the element into a core `NativeHandle`.
    ///
    /// By value, so a caller cannot keep a second reference to the same
    /// wrapper through this path.
    pub fn into_native_handle(self) -> NativeHandle {
        NativeHandle::new(self)
    }

    /// Stamps the verified process identity onto the element so the live-read
    /// path can corroborate liveness against it before answering.
    pub(crate) fn with_verified_process(self, pid: u32, token: String) -> Self {
        Self(self.0, Some(ProcessPayload { pid, token }))
    }

    /// The verified process identity, if this element resolved through the
    /// strict resolver.
    pub(crate) fn verified_process(&self) -> Option<(u32, &str)> {
        self.1
            .as_ref()
            .map(|payload| (payload.pid, payload.token.as_str()))
    }
}

/// Borrows the UI Automation element carried by a core `NativeHandle`.
///
/// A handle built by another platform, or an empty one, is rejected rather
/// than reinterpreted: `downcast_ref` is a type check, never a pointer cast.
pub fn uia_element(handle: &NativeHandle) -> Result<&UIAElement, AdapterError> {
    handle.downcast_ref::<UIAElement>().ok_or_else(|| {
        AdapterError::new(
            ErrorCode::InvalidArgs,
            "Native handle does not contain a Windows UI Automation element",
        )
        .with_details(serde_json::json!({
            "kind": "invalid_native_handle",
            "platform": "windows",
            "empty": handle.is_null()
        }))
    })
}

#[cfg(test)]
#[path = "element_tests.rs"]
mod tests;
