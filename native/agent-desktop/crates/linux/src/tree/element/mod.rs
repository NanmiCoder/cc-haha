pub(crate) mod ancestry;
pub(super) mod bounded;
pub(super) mod child_list;
pub(super) mod raw_node;

use agent_desktop_core::{AdapterError, ErrorCode, NativeHandle};

use super::element::ancestry::Ancestry;

/// Identifies one accessible object on the accessibility bus: the unique bus
/// name of the owning application, the object path, and that application's
/// process id. The ancestry the walk recorded for it rides along so later
/// code never climbs `Parent`; equality is the address alone.
#[derive(Debug, Clone)]
pub(crate) struct AtspiElement {
    bus_name: String,
    path: String,
    pid: u32,
    ancestry: Ancestry,
    menu_owner: Option<(String, String, u32)>,
}

impl PartialEq for AtspiElement {
    fn eq(&self, other: &Self) -> bool {
        self.bus_name == other.bus_name && self.path == other.path && self.pid == other.pid
    }
}

impl Eq for AtspiElement {}

impl AtspiElement {
    pub(crate) fn new(bus_name: impl Into<String>, path: impl Into<String>, pid: u32) -> Self {
        Self {
            bus_name: bus_name.into(),
            path: path.into(),
            pid,
            ancestry: Ancestry::default(),
            menu_owner: None,
        }
    }

    pub(crate) fn bus_name(&self) -> &str {
        &self.bus_name
    }

    pub(crate) fn path(&self) -> &str {
        &self.path
    }

    pub(crate) fn object_identity(&self) -> String {
        format!("{}{}", self.bus_name, self.path)
    }

    pub(crate) fn pid(&self) -> u32 {
        self.pid
    }

    /// The same element without its ancestry: what gets stored inside another
    /// element's ancestry, which never nests ancestry of its own.
    pub(crate) fn address(&self) -> Self {
        Self::new(self.bus_name.clone(), self.path.clone(), self.pid)
    }

    pub(crate) fn ancestry(&self) -> &Ancestry {
        &self.ancestry
    }

    /// The window root the walk this element came from descended under.
    pub(crate) fn frame(&self) -> Option<&AtspiElement> {
        self.ancestry.frame()
    }

    /// The nearest scroll pane or viewport ancestor the walk passed through.
    pub(crate) fn scroll_container(&self) -> Option<&AtspiElement> {
        self.ancestry.scroll_container()
    }

    /// Whether the walk this element came from passed through a web document
    /// on the way down, which decides if DOM identifiers are read below it.
    pub(crate) fn in_web_document(&self) -> bool {
        self.ancestry.in_web_document()
    }

    pub(crate) fn set_ancestry(&mut self, ancestry: Ancestry) {
        self.ancestry = ancestry;
    }

    pub(crate) fn is_menu_target(&self) -> bool {
        self.menu_owner.is_some()
    }

    pub(crate) fn set_menu_owner(&mut self, owner: &AtspiElement) {
        self.menu_owner = Some((owner.bus_name.clone(), owner.path.clone(), owner.pid));
    }

    pub(crate) fn menu_owner(&self) -> Option<AtspiElement> {
        let (bus, path, pid) = self.menu_owner.as_ref()?;
        Some(AtspiElement::new(bus.clone(), path.clone(), *pid))
    }

    pub(crate) fn into_native_handle(self) -> NativeHandle {
        NativeHandle::new(self)
    }
}

/// Borrows the element carried by a core `NativeHandle`. A handle built by
/// another platform, or an empty one, is rejected rather than reinterpreted.
pub(crate) fn atspi_element(handle: &NativeHandle) -> Result<&AtspiElement, AdapterError> {
    handle.downcast_ref::<AtspiElement>().ok_or_else(|| {
        AdapterError::new(
            ErrorCode::InvalidArgs,
            "Native handle does not contain a Linux accessibility element",
        )
        .with_details(serde_json::json!({
            "kind": "invalid_native_handle",
            "platform": "linux",
            "empty": handle.is_null()
        }))
    })
}
