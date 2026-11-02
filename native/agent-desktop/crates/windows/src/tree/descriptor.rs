use agent_desktop_core::NodeDescriptor;

use super::properties::ElementProperties;
use super::properties::property_ids::TreeProperty;

/// Produces the descriptor group from the read set.
///
/// Every slot is a positive claim: a failed or gated source read contributes
/// nothing, per the tri-state rule.
/// All four sources are `Known`-only emissions resolved by the same walk batch,
/// so nothing here costs a round trip.
///
/// Sources, each confirmed by the A16 probe family:
/// - `role_description` ← `LocalizedControlType` (A16-5: populated on every
///   control type across all three stacks, zero failed reads; the content is
///   the provider's display vocabulary, so it is not target text and never
///   withheld by the secure gate).
/// - `subrole` ← `AriaRole` (A16-6: non-empty on 164 of 165 settled Chromium
///   elements with short ARIA vocabulary tokens; a failed read produces no
///   subrole). `AriaRole` is provider vocabulary by the caller's pre-committed
///   branch - the verbatim-author-text sub-question returned zero on this box,
///   so it is not target text either.
/// - `placeholder` ← `HelpText`, but only where `HelpText` is not already the
///   description (the richer `FullDescription` wins the description slot).
/// - `dom_classes` has no source on the pinned stack (A16-6 measured
///   `AriaProperties` carrying no `class` token, and `HtmlClass` does not exist
///   in `uiautomation` 0.25.0), so it stays empty - the schema is settled for
///   whichever platform first produces it, and this one does not yet.
pub fn descriptors(properties: &ElementProperties) -> NodeDescriptor {
    NodeDescriptor {
        subrole: non_empty_text(properties.get(TreeProperty::AriaRole)),
        role_description: non_empty_text(properties.get(TreeProperty::LocalizedControlType)),
        placeholder: placeholder_of(properties),
        dom_classes: Vec::new(),
    }
}

/// The placeholder: `HelpText` where it is not already the description.
///
/// The description slot is `FullDescription` with `HelpText` as its fallback
/// (`name_evidence.rs::description_of`). So `HelpText` serves as the
/// description exactly when `FullDescription` is blank or failed; only when
/// `FullDescription` is a real, non-blank answer can `HelpText` double as the
/// placeholder instead. A property serving two slots is how the same string
/// ends up reported twice under different names.
pub fn placeholder_of(properties: &ElementProperties) -> Option<String> {
    let full = non_empty_text(properties.get(TreeProperty::FullDescription));
    if full.is_some() {
        non_empty_text(properties.get(TreeProperty::HelpText))
    } else {
        None
    }
}

fn non_empty_text(outcome: super::properties::property_outcome::PropertyOutcome) -> Option<String> {
    outcome.non_blank_text()
}

#[cfg(test)]
#[path = "descriptor_tests.rs"]
mod tests;
