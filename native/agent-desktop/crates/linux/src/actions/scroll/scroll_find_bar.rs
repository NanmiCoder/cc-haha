use std::collections::HashMap;

use agent_desktop_core::{AdapterError, DeliverySemantics, ErrorCode};

use super::scroll_plan::Axis;

/// One node of the window as the crawl met it: where it hangs and, for a
/// scroll bar, which way it runs when that could be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Site {
    pub(crate) parent: Option<usize>,
    pub(crate) bar: Option<Orientation>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Orientation {
    Vertical,
    Horizontal,
    Unknown,
}

fn runs(orientation: Orientation, axis: Axis) -> bool {
    matches!(
        (orientation, axis),
        (Orientation::Vertical, Axis::Vertical)
            | (Orientation::Horizontal, Axis::Horizontal)
            | (Orientation::Unknown, _)
    )
}

/// How far each ancestor of `target` is above it, nearest first.
fn distances(sites: &[Site], target: usize) -> HashMap<usize, usize> {
    let mut found = HashMap::new();
    let mut at = sites.get(target).and_then(|site| site.parent);
    let mut distance = 1;
    while let Some(index) = at {
        if found.insert(index, distance).is_some() {
            break;
        }
        at = sites.get(index).and_then(|site| site.parent);
        distance += 1;
    }
    found
}

/// The scroll bar that scrolls the target along `axis`: the one that hangs
/// off the nearest ancestor of the target, since a bar scrolls the content
/// beside it, a bar that says which way it runs ahead of one that does not.
/// A target scroll bar can only be moved by an outer container's bar.
/// When the target was found and no bar hangs off its ancestors, none: a
/// bar of another pane would scroll the wrong content. When the target was
/// not met, the only bar that runs the right way; several candidates refuse.
pub(crate) fn choose_bar(
    sites: &[Site],
    target: Option<usize>,
    axis: Axis,
) -> Result<Option<usize>, AdapterError> {
    let bars: Vec<usize> = sites
        .iter()
        .enumerate()
        .filter(|(_, site)| site.bar.is_some_and(|way| runs(way, axis)))
        .map(|(index, _)| index)
        .collect();
    if let Some(target) = target {
        let mut above = distances(sites, target);
        if let Some(parent) = sites
            .get(target)
            .filter(|site| site.bar.is_some())
            .and_then(|site| site.parent)
        {
            above.remove(&parent);
        }
        let mut ranked: Vec<_> = bars
            .iter()
            .filter_map(|&bar| {
                let site = sites.get(bar)?;
                let unknown = usize::from(site.bar == Some(Orientation::Unknown));
                above
                    .get(&site.parent?)
                    .map(|distance| (*distance, unknown, bar))
            })
            .collect();
        ranked.sort_unstable();
        return match ranked.as_slice() {
            [] => Ok(None),
            [(distance, unknown, _), (next_distance, next_unknown, _), ..]
                if (distance, unknown) == (next_distance, next_unknown) =>
            {
                Err(ambiguous())
            }
            [(_, _, bar), ..] => Ok(Some(*bar)),
        };
    }
    match bars.as_slice() {
        [] => Ok(None),
        [only] => Ok(Some(*only)),
        _ => Err(ambiguous()),
    }
}

fn ambiguous() -> AdapterError {
    AdapterError::new(
        ErrorCode::AmbiguousTarget,
        "Several equally ranked scroll bars could move the target",
    )
    .with_details(serde_json::json!({"kind": "scroll_bar_ambiguous"}))
    .with_disposition(DeliverySemantics::not_delivered())
}

#[cfg(test)]
#[path = "scroll_find_bar_tests.rs"]
mod tests;
