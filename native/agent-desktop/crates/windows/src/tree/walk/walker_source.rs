use agent_desktop_core::{AdapterError, ObservationRoot};

use super::walker::{WalkBudget, WalkOutcome, walk_from_root};
use crate::tree::element::UIAElement;

#[cfg(target_os = "windows")]
mod imp {
    use crate::tree::automation::{UiaFailure, automation_client, failure_of, uia_error};
    use crate::tree::element::UIAElement;
    use crate::tree::name_evidence::read_label;
    use crate::tree::properties::property_ids::TreeProperty;
    use crate::tree::properties::{read_cached, read_live, read_one, rect_has_area};
    use crate::tree::walk::cache::{build_walk_cache_request, policy_for_root};
    use crate::tree::walk::walker::{DEFAULT_MAX_RAW_DEPTH, NodeKey, TreeSource, walk_vocabulary};
    use agent_desktop_core::{AdapterError, Deadline, LocatorField, Rect};
    use uiautomation::UIAutomation;
    use uiautomation::core::{UICacheRequest, UITreeWalker};

    /// The climb toward the root could not be completed with a confident
    /// answer: either the operation budget ran out between two cross-process
    /// walker calls, or a parent read failed with a fault other than
    /// exhaustion. Code review found the two collapsing into the same "no
    /// viewport" answer as reaching the true root, which a caller reads as
    /// licence to treat a genuinely clipped target as unclipped - so both
    /// causes share this one shape, distinct from `Ok(None)`.
    #[derive(Debug)]
    pub struct BudgetExpired;

    /// Whether two proxies address the same element.
    ///
    /// UI Automation hands back a new `IUIAutomationElement` per query, so
    /// asking the client is the only answer available. A free function because
    /// the enumeration walk and the ancestor climbs both need it, and a second
    /// copy is a second chance for the two to disagree.
    pub fn same_element(client: &UIAutomation, left: &UIAElement, right: &UIAElement) -> bool {
        client.compare_elements(&left.0, &right.0).unwrap_or(false)
    }

    /// The identity every cycle guard keys on: the runtime id when the provider
    /// publishes one, and otherwise the marker that sends the guard to
    /// [`same_element`].
    pub fn identity(node: &UIAElement) -> NodeKey {
        match node.0.get_runtime_id() {
            Ok(runtime_id) if !runtime_id.is_empty() => NodeKey::Runtime(runtime_id),
            _ => NodeKey::Unavailable,
        }
    }

    /// One step toward the root.
    ///
    /// Exhaustion is `Ok(None)` - the climb reached the top - while any other
    /// fault is `Err`, so a caller can tell "there is no parent" from "the
    /// parent could not be read" and refuse to decide on the second.
    pub fn parent_step(walker: &UITreeWalker, node: &UIAElement) -> Result<Option<UIAElement>, ()> {
        match walker.get_parent(&node.0) {
            Ok(parent) => Ok(Some(UIAElement::from(parent))),
            Err(error) => {
                if failure_of(&error).is_exhaustion() {
                    Ok(None)
                } else {
                    Err(())
                }
            }
        }
    }

    /// The nearest ancestor that advertises a scrollable viewport.
    ///
    /// Every step is a cross-process call, so the deadline is consulted once per
    /// step and a truncated climb is `Err` rather than a confident "no
    /// viewport" - which a caller would read as licence to skip the clipping
    /// question entirely.
    pub fn nearest_scroll_viewport(
        target: &UIAElement,
        walker: &UITreeWalker,
        deadline: Deadline,
    ) -> Result<Option<UIAElement>, BudgetExpired> {
        let mut current = target.clone();
        for _ in 0..DEFAULT_MAX_RAW_DEPTH as usize {
            if deadline.is_expired() {
                return Err(BudgetExpired);
            }
            let parent = match parent_step(walker, &current) {
                Ok(Some(parent)) => parent,
                Ok(None) => return Ok(None),
                Err(()) => return Err(BudgetExpired),
            };
            if read_one(&parent, TreeProperty::ScrollAvailable).flag() == Some(true) {
                return Ok(Some(parent));
            }
            current = parent;
        }
        Ok(None)
    }

    /// A resolved viewport's rectangle right now.
    ///
    /// Which ancestor clips the target is fixed for the life of one operation;
    /// its rectangle is not. A poller re-reads this and never the climb.
    pub fn viewport_bounds(viewport: &UIAElement) -> Result<Option<Rect>, AdapterError> {
        use windows::Win32::Foundation::HWND;
        use windows_sys::Win32::Foundation::{POINT, RECT};
        use windows_sys::Win32::Graphics::Gdi::ClientToScreen;
        use windows_sys::Win32::UI::WindowsAndMessaging::GetClientRect;

        let handle: HWND = viewport
            .0
            .get_native_window_handle()
            .map_err(|error| uia_error(&error, "read viewport window"))?
            .into();
        if !handle.0.is_null() {
            let mut rect = RECT::default();
            let mut origin = POINT::default();
            if unsafe { GetClientRect(handle.0, &mut rect) } == 0
                || unsafe { ClientToScreen(handle.0, &mut origin) } == 0
            {
                return Err(AdapterError::new(
                    agent_desktop_core::ErrorCode::ActionFailed,
                    "Could not read the native scroll viewport",
                ));
            }
            return Ok(Some(Rect {
                x: f64::from(origin.x),
                y: f64::from(origin.y),
                width: f64::from(rect.right - rect.left),
                height: f64::from(rect.bottom - rect.top),
            }));
        }
        match read_one(viewport, TreeProperty::BoundingRectangle).bounds() {
            LocatorField::Known(bounds) if rect_has_area(&bounds) => Ok(Some(bounds)),
            LocatorField::Absent => Ok(None),
            _ => Err(AdapterError::new(
                agent_desktop_core::ErrorCode::ActionFailed,
                "Could not read the scroll viewport bounds",
            )),
        }
    }

    /// The nearest scroll viewport's rectangle, for a caller that climbs once
    /// and reads once.
    pub fn nearest_scroll_viewport_bounds(
        target: &UIAElement,
        walker: &UITreeWalker,
        deadline: Deadline,
    ) -> Result<Option<Rect>, BudgetExpired> {
        nearest_scroll_viewport(target, walker, deadline)?
            .as_ref()
            .map(viewport_bounds)
            .transpose()
            .map(Option::flatten)
            .map_err(|_| BudgetExpired)
    }

    /// The production enumeration surface: the raw view walker, plus the cache
    /// request the provider class earned.
    pub struct UiaTreeSource {
        client: UIAutomation,
        walker: UITreeWalker,
        cache: Option<UICacheRequest>,
        /// Whether the root is Chromium/Electron provenance (the provenance
        /// gate): the transparent-wrapper depth skip must only fire under
        /// detected Chromium/WebView2 provenance, because the identical
        /// emptiness test would otherwise skip the anonymous `Group`/`Pane`
        /// containers native stacks are full of.
        chromium_provenance: bool,
    }

    impl UiaTreeSource {
        pub fn for_root(root: &UIAElement) -> Result<Self, AdapterError> {
            let client = automation_client()?;
            let walker = client
                .get_raw_view_walker()
                .map_err(|error| uia_error(&error, "open the raw view tree walker"))?;
            let cache = if policy_for_root(root).batches() {
                Some(build_walk_cache_request(&client)?)
            } else {
                None
            };
            Ok(Self {
                client,
                walker,
                cache,
                chromium_provenance: crate::tree::chromium::is_chromium_root(root),
            })
        }

        /// Prefetches the walk property set onto the caller's root.
        ///
        /// The root arrives from `ElementFromHandle` or from a stored ref, so
        /// it carries no cache of its own; without this the root alone would
        /// read `Unknown` for every property while its children read fine.
        pub fn prepare_root(&self, root: &UIAElement) -> Result<UIAElement, AdapterError> {
            match &self.cache {
                Some(request) => root
                    .0
                    .build_updated_cache(request)
                    .map(UIAElement::from)
                    .map_err(|error| {
                        uia_error(&error, "prefetch the properties of a root element")
                    }),
                None => Ok(root.clone()),
            }
        }

        /// Whether the root this source walks carries Chromium provenance; the
        /// wrapper-depth skip only fires when this is true.
        #[cfg(test)]
        pub(crate) fn chromium_provenance(&self) -> bool {
            self.chromium_provenance
        }
    }

    impl TreeSource for UiaTreeSource {
        type Node = UIAElement;

        fn first_child(&self, node: &UIAElement) -> Result<UIAElement, UiaFailure> {
            match &self.cache {
                Some(request) => self.walker.get_first_child_build_cache(&node.0, request),
                None => self.walker.get_first_child(&node.0),
            }
            .map(UIAElement::from)
            .map_err(|error| failure_of(&error))
        }

        fn next_sibling(&self, node: &UIAElement) -> Result<UIAElement, UiaFailure> {
            match &self.cache {
                Some(request) => self.walker.get_next_sibling_build_cache(&node.0, request),
                None => self.walker.get_next_sibling(&node.0),
            }
            .map(UIAElement::from)
            .map_err(|error| failure_of(&error))
        }

        fn identity(&self, node: &UIAElement) -> NodeKey {
            identity(node)
        }

        fn same_element(&self, left: &UIAElement, right: &UIAElement) -> bool {
            same_element(&self.client, left, right)
        }

        fn evidence(
            &self,
            node: &UIAElement,
        ) -> (
            crate::tree::properties::ElementProperties,
            agent_desktop_core::LocatorEvidence,
            u64,
        ) {
            let (properties, errors) = match &self.cache {
                Some(_) => read_cached(node),
                None => read_live(node),
            };
            let failed = u64::try_from(errors.len()).unwrap_or(u64::MAX);
            let label = read_label(node, self.cache.is_some());
            let vocabulary = walk_vocabulary(&properties, &label);
            (
                properties.clone(),
                properties.locator_evidence(vocabulary),
                failed,
            )
        }

        fn is_web_wrapper(
            &self,
            _node: &UIAElement,
            properties: &crate::tree::properties::ElementProperties,
        ) -> bool {
            self.chromium_provenance && crate::tree::walk::wrapper::is_web_wrapper(properties)
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use crate::tree::automation::{ERR_NONE, UiaFailure};
    use crate::tree::element::UIAElement;
    use crate::tree::properties::ElementProperties;
    use crate::tree::properties::element_properties::ResolvedVocabulary;
    use crate::tree::walk::walker::{NodeKey, TreeSource};
    use agent_desktop_core::AdapterError;

    /// Canned arm so the walk's entry point, and every module that calls it,
    /// compile and run on a non-Windows lane. It enumerates nothing, which is
    /// the exhaustion answer, so a walk here yields a single complete node.
    pub struct UiaTreeSource;

    impl UiaTreeSource {
        pub fn for_root(_root: &UIAElement) -> Result<Self, AdapterError> {
            Ok(Self)
        }

        pub fn prepare_root(&self, root: &UIAElement) -> Result<UIAElement, AdapterError> {
            Ok(root.clone())
        }
    }

    impl TreeSource for UiaTreeSource {
        type Node = UIAElement;

        fn first_child(&self, _node: &UIAElement) -> Result<UIAElement, UiaFailure> {
            Err(UiaFailure::Sentinel(ERR_NONE))
        }

        fn next_sibling(&self, _node: &UIAElement) -> Result<UIAElement, UiaFailure> {
            Err(UiaFailure::Sentinel(ERR_NONE))
        }

        fn identity(&self, _node: &UIAElement) -> NodeKey {
            NodeKey::Unavailable
        }

        fn same_element(&self, _left: &UIAElement, _right: &UIAElement) -> bool {
            false
        }

        fn evidence(
            &self,
            _node: &UIAElement,
        ) -> (
            crate::tree::properties::ElementProperties,
            agent_desktop_core::LocatorEvidence,
            u64,
        ) {
            (
                ElementProperties::default(),
                ElementProperties::default().locator_evidence(ResolvedVocabulary::unknown()),
                0,
            )
        }

        fn is_web_wrapper(
            &self,
            _node: &UIAElement,
            _properties: &crate::tree::properties::ElementProperties,
        ) -> bool {
            false
        }
    }
}

pub use imp::UiaTreeSource;

#[cfg(target_os = "windows")]
pub(crate) use imp::{
    BudgetExpired, identity, nearest_scroll_viewport, nearest_scroll_viewport_bounds, parent_step,
    same_element, viewport_bounds,
};

/// Walks a live UI Automation subtree from an arbitrary root element.
///
/// The cache policy is chosen once, from the root's provider class, and the
/// root is prefetched to match it, so the whole walk reads through one
/// consistent mechanism.
pub fn walk_uia_subtree(
    root: &UIAElement,
    root_source: &ObservationRoot<'_>,
    budget: WalkBudget,
) -> Result<WalkOutcome, AdapterError> {
    let source = UiaTreeSource::for_root(root)?;
    let prepared = source.prepare_root(root)?;
    walk_from_root(&source, &prepared, root_source, budget)
}

#[cfg(test)]
#[path = "walker_source_tests.rs"]
mod tests;
