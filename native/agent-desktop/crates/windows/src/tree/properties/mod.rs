use agent_desktop_core::AdapterError;

use super::properties::property_ids::TreeProperty;

pub use super::properties::element_properties::ElementProperties;
pub use super::properties::property_outcome::{MAX_EVIDENCE_CHARS, PropertyOutcome, PropertyValue};

/// Bounds a string read and reports whether it survived intact.
///
/// A value longer than the bound is not truncated into evidence; the caller
/// marks it `Unknown`.
pub fn bounded_text(value: String) -> PropertyOutcome {
    if value.chars().take(MAX_EVIDENCE_CHARS + 1).count() > MAX_EVIDENCE_CHARS {
        PropertyOutcome::Unknown
    } else {
        PropertyOutcome::Known(PropertyValue::Text(value))
    }
}

/// Measures one side of a rectangle.
///
/// Saturating, because a provider is free to hand back nonsense and this crate
/// denies panicking paths: `right - left` on extreme values overflows `i32` and
/// would abort a debug build. An inverted side is degenerate, not
/// negative-sized, so it collapses to zero - the same shape A14-8 measured on a
/// minimized top-level window - rather than travelling downstream as a negative
/// width no consumer expects.
pub fn extent(near: i32, far: i32) -> f64 {
    f64::from(far.saturating_sub(near).max(0))
}

/// Reports whether a rectangle is measurable and encloses real area.
///
/// Finiteness is part of the test rather than decoration. A provider is free to
/// answer `NaN` or an infinity, and such a value satisfies a bare
/// positive-dimension comparison while comparing false against every point.
/// Accepting it turns an unmeasurable answer into a verified one - the exact
/// false positive a post-write re-read exists to prevent - and carries an
/// unanswerable question into a hit-test probe.
///
/// One definition, because the readers that must decide whether a rectangle can
/// be trusted - the pre-probe guard ladder, the scroll-viewport ancestor climb
/// and the post-invoke visibility judgement - are otherwise three chances for
/// the same predicate to disagree.
#[cfg(target_os = "windows")]
pub(crate) fn rect_has_area(rect: &agent_desktop_core::Rect) -> bool {
    rect.x.is_finite()
        && rect.y.is_finite()
        && rect.width.is_finite()
        && rect.height.is_finite()
        && rect.width > 0.0
        && rect.height > 0.0
}

/// Builds the structured error for a property read that failed, carrying the
/// property's name and never its value, so a failure cannot leak content
/// through the error path.
///
/// The base's own details are merged into rather than replaced, so the
/// `complete`/`retryable` pair the classifier decided for that failure
/// survives into the payload a caller and a trace segment read. It is
/// deliberately not re-decided here: what an unreadable property means depends
/// on why it could not be read, and the classifier already separates those
/// families - a provider that does not implement the property is a settled
/// absence, a transport timeout is incomplete and retryable. Flattening them
/// to one value would be the wrong stamp on whichever family it did not match.
///
/// Merging also leaves the typed retryability every core retry consumer gates
/// on exactly where it was: the `retryable` key that goes back in is the
/// base's own, so the value derived from it is the value already derived.
///
/// Only the payload is at stake. A wrap whose details omit `retryable`
/// preserves the typed stamp too, because `with_details` overwrites it only
/// when the new details carry that key - the property that lets
/// `live_read.rs`'s vanished-target check key on the error code alone.
pub fn property_read_error(base: AdapterError, property: TreeProperty) -> AdapterError {
    let mut details = base
        .details
        .clone()
        .filter(serde_json::Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}));
    if let Some(object) = details.as_object_mut() {
        object.insert("kind".into(), "property_read_failed".into());
        object.insert("property".into(), property.as_str().into());
    }
    base.with_details(details)
}

/// Pinned here rather than in `properties_tests.rs`, which sits at the
/// per-file line cap; this is a pure function of the error the classifier
/// already built, so it needs no property set and no platform surface.
#[cfg(test)]
mod property_read_error_tests {
    use super::{TreeProperty, property_read_error};
    use crate::tree::automation::{ERR_INVALID_ARG, ERR_TIMEOUT, UiaFailure, uia_failure_error};

    /// A property read failure's disposition is the classifier's, carried
    /// through the wrap rather than re-decided by it. Both halves are
    /// asserted: the typed retryability every core retry consumer gates on
    /// must be identical either side of the wrap, and the payload must still
    /// say the same thing, since a consumer reading only the JSON would
    /// otherwise see a failure carrying no disposition at all. Asserting the
    /// keys merely exist would pass on a wrong value, so each is checked
    /// against its own family's answer - a transport timeout is incomplete
    /// and retryable, an invalid request is a settled absence.
    #[test]
    fn wrapping_a_read_failure_carries_the_classifiers_disposition_through_intact() {
        for (sentinel, retryable, complete) in
            [(ERR_TIMEOUT, true, false), (ERR_INVALID_ARG, false, true)]
        {
            let base =
                uia_failure_error(UiaFailure::Sentinel(sentinel), "read an element property");
            let base_explicit = base.is_explicitly_retryable();
            let base_default = base.permits_retry_by_default();

            let wrapped = property_read_error(base, TreeProperty::Name);

            assert_eq!(wrapped.is_explicitly_retryable(), base_explicit);
            assert_eq!(wrapped.permits_retry_by_default(), base_default);
            assert_eq!(wrapped.is_explicitly_retryable(), retryable);
            let details = wrapped
                .details
                .expect("a wrapped read failure carries details");
            assert_eq!(details["kind"], "property_read_failed");
            assert_eq!(details["property"], TreeProperty::Name.as_str());
            assert_eq!(details["retryable"], serde_json::json!(retryable));
            assert_eq!(details["complete"], serde_json::json!(complete));
        }
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use super::{
        ElementProperties, PropertyOutcome, PropertyValue, TreeProperty, bounded_text,
        property_read_error,
    };
    use crate::tree::automation::{failure_of, uia_failure_error};
    use crate::tree::element::UIAElement;
    use crate::tree::properties::property_ids::uia_property;
    use agent_desktop_core::{AdapterError, Deadline, Rect};
    use uiautomation::Error as UiaError;
    use uiautomation::variants::{Value, Variant};
    use windows::Win32::UI::Accessibility::UiaGetReservedNotSupportedValue;
    use windows::core::{IUnknown, Interface};

    /// Reads the walk property set from one element, live.
    ///
    /// Errors are collected rather than propagated: a single failed property
    /// makes that slot `Unknown`, it does not abandon the element. The
    /// returned errors carry shape only and feed the walk's incompleteness
    /// accounting.
    pub fn read_live(element: &UIAElement) -> (ElementProperties, Vec<AdapterError>) {
        read_with(element, live_read, None)
    }

    /// The same live read, bounded by an operation deadline consulted between
    /// each of the set's cross-process calls.
    ///
    /// `read_live` never checked the deadline between properties, so a caller
    /// bounded by its own timeout - `live_read.rs`'s shared element read, and
    /// through it every poll-style consumer - could pay the full width of the
    /// property set on every iteration regardless of how little budget
    /// remained. This is the same reads, the same classification, the same
    /// `Vec<AdapterError>` shape; it only adds a place to stop early.
    pub fn read_live_bounded(
        element: &UIAElement,
        deadline: Deadline,
    ) -> (ElementProperties, Vec<AdapterError>) {
        read_with(element, live_read, Some(deadline))
    }

    /// Reads the walk property set from an element's cache.
    ///
    /// A property absent from the cache request is a programming error, not a
    /// live fetch: it classifies `Unknown` with a structured error, never
    /// `Absent`, so a missing request entry cannot masquerade as a provider
    /// that does not implement the property.
    pub fn read_cached(element: &UIAElement) -> (ElementProperties, Vec<AdapterError>) {
        read_with(element, cached_read, None)
    }

    /// Reads one property live, for the cache policy's provider-class probe
    /// and for tests.
    pub fn read_one(element: &UIAElement, property: TreeProperty) -> PropertyOutcome {
        live_read(element, property).unwrap_or(PropertyOutcome::Unknown)
    }

    fn live_read(
        element: &UIAElement,
        property: TreeProperty,
    ) -> Result<PropertyOutcome, AdapterError> {
        if property == TreeProperty::BoundingRectangle {
            return element
                .0
                .get_bounding_rectangle()
                .map(rect_outcome)
                .map_err(|error| failed(&error, property, "read an element property"));
        }
        element
            .0
            .get_property_value(uia_property(property))
            .map(|variant| classify(&variant))
            .map_err(|error| failed(&error, property, "read an element property"))
    }

    fn cached_read(
        element: &UIAElement,
        property: TreeProperty,
    ) -> Result<PropertyOutcome, AdapterError> {
        if property == TreeProperty::BoundingRectangle {
            return element
                .0
                .get_cached_bounding_rectangle()
                .map(rect_outcome)
                .map_err(|error| failed(&error, property, "read a cached element property"));
        }
        element
            .0
            .get_cached_property_value(uia_property(property))
            .map(|variant| classify(&variant))
            .map_err(|error| failed(&error, property, "read a cached element property"))
    }

    fn failed(error: &UiaError, property: TreeProperty, context: &str) -> AdapterError {
        property_read_error(uia_failure_error(failure_of(error), context), property)
    }

    /// `deadline` is consulted once per property, before that property's own
    /// cross-process call: `None` (the walk's `read_live`/`read_cached`
    /// paths, which own their budget elsewhere) never stops early, `Some`
    /// (`read_live_bounded`) truncates the set the moment it expires, leaving
    /// the remaining properties unread rather than starting a call that would
    /// outlast the deadline anyway.
    fn read_with(
        element: &UIAElement,
        read: impl Fn(&UIAElement, TreeProperty) -> Result<PropertyOutcome, AdapterError>,
        deadline: Option<Deadline>,
    ) -> (ElementProperties, Vec<AdapterError>) {
        let mut reads = Vec::with_capacity(TreeProperty::WALK_SET.len());
        let mut errors = Vec::new();
        let mut truncated = false;
        for property in TreeProperty::WALK_SET {
            if property.is_element_valued() {
                continue;
            }
            if let Some(deadline) = deadline {
                if deadline.is_expired() {
                    if !truncated {
                        errors.push(deadline.timeout_error());
                        truncated = true;
                    }
                    reads.push((property, PropertyOutcome::Unknown));
                    continue;
                }
            }
            match read(element, property) {
                Ok(outcome) => reads.push((property, outcome)),
                Err(error) => {
                    errors.push(error);
                    reads.push((property, PropertyOutcome::Unknown));
                }
            }
        }
        (ElementProperties::from_reads(reads), errors)
    }

    /// Converts a UI Automation rectangle into core's.
    ///
    /// An inverted rectangle - `right` left of `left` - is degenerate, not
    /// negative-sized. It collapses to zero extent, which is the same shape a
    /// minimized top-level window reports (A14-8), rather than travelling
    /// downstream as a negative width that no consumer expects.
    ///
    /// Crate-visible because a reader that needs the provider's own failure -
    /// rather than the tri-state this module's classification produces from it -
    /// still has to convert the rectangle the same way.
    pub(crate) fn rect_from_uia(rectangle: uiautomation::types::Rect) -> Rect {
        Rect {
            x: f64::from(rectangle.get_left()),
            y: f64::from(rectangle.get_top()),
            width: super::extent(rectangle.get_left(), rectangle.get_right()),
            height: super::extent(rectangle.get_top(), rectangle.get_bottom()),
        }
    }

    fn rect_outcome(rectangle: uiautomation::types::Rect) -> PropertyOutcome {
        PropertyOutcome::Known(PropertyValue::Bounds(rect_from_uia(rectangle)))
    }

    /// Turns one variant into the tri-state.
    ///
    /// The not-supported sentinel is compared by **pointer identity**, which
    /// is the only reliable test: it arrives as `VT_UNKNOWN` carrying the
    /// singleton `UiaGetReservedNotSupportedValue` returns, and no field of
    /// the variant distinguishes it from any other interface pointer.
    /// `VT_EMPTY`, `VT_NULL` and `VT_VOID` mean the provider answered with
    /// nothing, which is `Absent`; a variant this reader cannot decode is
    /// `Unknown`, because presenting an undecoded value as identity evidence
    /// is what silently breaks re-identification downstream.
    fn classify(variant: &Variant) -> PropertyOutcome {
        if is_not_supported(variant) {
            return PropertyOutcome::Absent;
        }
        match variant.get_value() {
            Err(_) => PropertyOutcome::Unknown,
            Ok(Value::EMPTY | Value::NULL | Value::VOID) => PropertyOutcome::Absent,
            Ok(Value::STRING(text)) => bounded_text(text),
            Ok(Value::BOOL(flag)) => PropertyOutcome::Known(PropertyValue::Flag(flag)),
            Ok(Value::I4(number) | Value::INT(number)) => {
                PropertyOutcome::Known(PropertyValue::Number(number))
            }
            Ok(_) => PropertyOutcome::Unknown,
        }
    }

    thread_local! {
        /// The not-supported sentinel, fetched once per thread.
        ///
        /// UI Automation documents it as a process singleton, so its address
        /// is stable and the comparison below is a pointer test. Fetching it
        /// per property per element turned a constant into an FFI call on the
        /// hottest path in the walk.
        static NOT_SUPPORTED: Option<IUnknown> =
            unsafe { UiaGetReservedNotSupportedValue() }.ok();
    }

    fn is_not_supported(variant: &Variant) -> bool {
        let Ok(Value::UNKNOWN(candidate)) = variant.get_value() else {
            return false;
        };
        NOT_SUPPORTED.with(|sentinel| {
            sentinel
                .as_ref()
                .is_some_and(|sentinel| candidate.as_raw() == sentinel.as_raw())
        })
    }
}

#[cfg(target_os = "windows")]
pub use imp::{read_cached, read_live, read_live_bounded, read_one};

#[cfg(target_os = "windows")]
pub(crate) use imp::rect_from_uia;

pub mod element_properties;
pub mod property_ids;
pub mod property_outcome;
#[cfg(test)]
#[path = "properties_tests.rs"]
mod tests;
