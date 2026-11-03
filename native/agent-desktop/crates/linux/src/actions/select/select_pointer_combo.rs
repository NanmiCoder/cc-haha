use std::time::Duration;

use agent_desktop_core::{
    ActionResult, ActionStep, AdapterError, Deadline, DeliverySemantics, ErrorCode,
};
use serde_json::json;

use super::select_pointer::{Pointer, already_satisfied, pointer_required};
use super::select_popup::{Shown, commit, first_label};
use super::select_search::{Hit, Search, name_matches, search};
use crate::actions::click::{POLL_STEP, poll_until};
use crate::actions::context::Target;
use crate::actions::popup_verify::name_open_overview;
use crate::actions::select::{
    BusReader, advertises_selection, children_of, handle_of, miss_error, no_route,
};
use crate::system::menu::overview;
use crate::tree::AtspiElement;
use crate::tree::capabilities::action_read::{NodeView, read_node_view};
use crate::tree::capabilities::capability_rules::pointer_only_combo;
use crate::tree::vocabulary::state_bits::HAS_POPUP;

const POPUP_WAIT: Duration = Duration::from_millis(1500);
const CLOSE_WAIT: Duration = Duration::from_millis(1000);
const SCAN_NODE_LIMIT: usize = 300;
const SCAN_DEPTH_LIMIT: usize = 16;

pub(in crate::actions) fn is_pointer_combo(view: &NodeView) -> bool {
    let (Some(role), Some(popup), Some(names), Some(children)) = (
        view.role(),
        view.state(HAS_POPUP),
        view.action_names(),
        view.child_count(),
    ) else {
        return false;
    };
    pointer_only_combo(
        role,
        popup,
        advertises_selection(view),
        names,
        i32::try_from(children).unwrap_or(i32::MAX),
    )
}

/// What a combo shows of its choices: the lists below it that hold a
/// selection, in document order, the value its current list displays, the
/// search for a choice in the list a popup adds, the commit of the choice
/// that was found, and whether GNOME Shell reports its Activities Overview
/// open, which a popup that never appeared names as its cause.
trait Choices {
    fn lists(&mut self) -> Result<Vec<AtspiElement>, AdapterError>;
    fn shown(&mut self, current: &AtspiElement) -> Option<String>;
    fn find(
        &mut self,
        popup: &AtspiElement,
        wanted: &str,
    ) -> Result<Search<AtspiElement>, AdapterError>;
    fn commit(
        &mut self,
        hit: &Hit<AtspiElement>,
        current: &AtspiElement,
        wanted: &str,
    ) -> Result<ActionResult, AdapterError>;
    fn overview_open(&self) -> Option<bool>;
}

struct BusChoices<'a> {
    reader: BusReader<'a>,
    target: &'a Target<'a>,
}

impl Choices for BusChoices<'_> {
    fn lists(&mut self) -> Result<Vec<AtspiElement>, AdapterError> {
        let mut lists = Vec::new();
        let mut stack = vec![(self.target.element.clone(), 0usize)];
        let mut seen = 0;
        while let Some((node, depth)) = stack.pop() {
            seen += 1;
            if seen > SCAN_NODE_LIMIT {
                break;
            }
            let view = read_node_view(self.reader.bus, &handle_of(&node), self.reader.deadline)?;
            if advertises_selection(&view) {
                lists.push(node.clone());
            }
            if depth < SCAN_DEPTH_LIMIT {
                let children =
                    children_of(self.reader.bus, &node, view.role(), self.reader.deadline)?;
                stack.extend(children.into_iter().rev().map(|child| (child, depth + 1)));
            }
        }
        Ok(lists)
    }

    fn shown(&mut self, current: &AtspiElement) -> Option<String> {
        first_label(&mut self.reader, current)
    }

    fn find(
        &mut self,
        popup: &AtspiElement,
        wanted: &str,
    ) -> Result<Search<AtspiElement>, AdapterError> {
        search(&mut self.reader, popup, wanted)
    }

    fn commit(
        &mut self,
        hit: &Hit<AtspiElement>,
        current: &AtspiElement,
        wanted: &str,
    ) -> Result<ActionResult, AdapterError> {
        commit(
            &mut self.reader,
            self.target,
            hit,
            wanted,
            &Shown::ListOf(current),
        )
    }

    fn overview_open(&self) -> Option<bool> {
        overview::overview_open()
    }
}

fn same(left: &AtspiElement, right: &AtspiElement) -> bool {
    left.bus_name() == right.bus_name() && left.path() == right.path()
}

fn new_list(choices: &mut dyn Choices, closed: &[AtspiElement]) -> Option<AtspiElement> {
    choices
        .lists()
        .ok()?
        .into_iter()
        .find(|list| !closed.iter().any(|known| same(known, list)))
}

fn shows(choices: &mut dyn Choices, current: &AtspiElement, wanted: &str) -> Option<bool> {
    choices
        .shown(current)
        .map(|shown| name_matches(&shown, wanted))
}

fn popup_not_observed(overview: Option<bool>) -> AdapterError {
    name_open_overview(
        AdapterError::new(
            ErrorCode::ActionFailed,
            "The dropdown did not show its choices after the pointer click",
        )
        .with_suggestion(
            "Inspect a fresh snapshot before taking another action; no automatic retry is safe.",
        )
        .with_details(json!({ "kind": "popup_not_observed" }))
        .with_disposition(DeliverySemantics::delivered_unverified()),
        overview,
    )
}

fn wait_closed(choices: &mut dyn Choices, closed: &[AtspiElement], deadline: Deadline) -> bool {
    poll_until(
        deadline,
        CLOSE_WAIT,
        POLL_STEP,
        || new_list(choices, closed).is_none(),
        |gone| *gone,
    )
}

fn close_popup(
    choices: &mut dyn Choices,
    pointer: &dyn Pointer,
    closed: &[AtspiElement],
    deadline: Deadline,
) -> bool {
    if new_list(choices, closed).is_none() {
        return true;
    }
    let sent = pointer.escape().is_ok();
    sent && wait_closed(choices, closed, deadline)
}

fn after_opening(opened: Vec<ActionStep>, mut result: ActionResult) -> ActionResult {
    let committed = std::mem::take(&mut result.steps);
    result.with_steps(opened.into_iter().chain(committed).collect())
}

/// Selects a choice of a combo that only a pointer can open: click it, find
/// the choice in the list that appears, commit the choice through the list and
/// the popover that holds it, and wait for the popup to close by itself, which
/// Escape ends only when it does not. A choice that is not there closes the
/// popup and is `ELEMENT_NOT_FOUND`. A combo that
/// shows the wanted value already needs no input, so a request without a
/// pointer is refused only when something has to be clicked.
fn choose_by_pointer(
    choices: &mut dyn Choices,
    pointer: Option<&dyn Pointer>,
    combo: &AtspiElement,
    wanted: &str,
    deadline: Deadline,
) -> Result<ActionResult, AdapterError> {
    let closed = choices.lists()?;
    let current = closed.first().ok_or_else(no_route)?.clone();
    if shows(choices, &current, wanted) == Some(true) {
        return Ok(already_satisfied());
    }
    let pointer = pointer.ok_or_else(pointer_required)?;
    let opened = pointer.click(combo)?;
    let popup = poll_until(
        deadline,
        POPUP_WAIT,
        POLL_STEP,
        || new_list(choices, &closed),
        |popup| popup.is_some(),
    )
    .ok_or_else(|| popup_not_observed(choices.overview_open()))?;
    let hit = match choices.find(&popup, wanted)? {
        Search::Found(hit) => hit,
        miss => {
            let shut = close_popup(choices, pointer, &closed, deadline);
            let error = miss_error(&miss);
            return Err(if shut {
                error
            } else {
                error.with_disposition(DeliverySemantics::delivered_unverified())
            });
        }
    };
    let committed = choices.commit(&hit, &current, wanted);
    if committed.is_err() || !wait_closed(choices, &closed, deadline) {
        close_popup(choices, pointer, &closed, deadline);
    }
    committed.map(|result| after_opening(opened, result))
}

pub(in crate::actions) fn select_in_pointer_combo(
    target: &Target<'_>,
    display_value: &str,
    pointer: Option<&dyn Pointer>,
) -> Result<ActionResult, AdapterError> {
    let mut choices = BusChoices {
        reader: BusReader {
            bus: target.bus,
            deadline: target.deadline,
            inspected_role: None,
        },
        target,
    };
    choose_by_pointer(
        &mut choices,
        pointer,
        target.element,
        display_value,
        target.deadline,
    )
}

#[cfg(test)]
#[path = "select_pointer_combo_tests.rs"]
mod tests;
