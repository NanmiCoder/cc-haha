use agent_desktop_core::NotificationInfo;

use crate::system::shell::light::Light;
use crate::system::shell::search::Walk;
use crate::tree::AtspiElement;
use crate::tree::vocabulary::role_numbers::{LABEL, NOTIFICATION, PUSH_BUTTON};

#[derive(Debug, Clone)]
pub(crate) struct Entry {
    pub(crate) info: NotificationInfo,
    pub(crate) node: AtspiElement,
    pub(crate) header: Vec<Light>,
    pub(crate) actions: Vec<Light>,
}

impl Entry {
    /// The header buttons in the order a dismissal tries them, the last
    /// first. Which of them closes the entry is told by its effect.
    pub(crate) fn close_candidates(&self) -> impl Iterator<Item = &Light> {
        self.header.iter().rev()
    }

    /// The header button before the last one, which reveals the actions.
    pub(crate) fn expand(&self) -> Option<&Light> {
        self.header
            .len()
            .checked_sub(2)
            .and_then(|at| self.header.get(at))
    }
}

/// The notification nodes of a reading that stand under no other one.
pub(crate) fn roots(walk: &Walk) -> Vec<usize> {
    let mut roots: Vec<usize> = Vec::new();
    for (at, visit) in walk.visits.iter().enumerate() {
        let nested = roots.iter().any(|root| walk.within(at, *root));
        if visit.light.role == NOTIFICATION && !nested {
            roots.push(at);
        }
    }
    roots
}

/// Reads one entry from the nodes under its notification node.
///
/// The shell lays an entry out as a header, the body and the action row. The
/// header is the one container that holds the unnamed push buttons, so it is
/// found by the controls it carries and not by any text: its first label is
/// the app and later labels are the age. Labels outside the header are the
/// title, then the body. Named push buttons outside the header are the
/// actions.
pub(crate) fn extract(walk: &Walk, root: usize, index: usize) -> Option<Entry> {
    let below: Vec<usize> = (root + 1..walk.visits.len())
        .take_while(|at| walk.within(*at, root))
        .collect();
    let light = |at: usize| &walk.visits[at].light;
    let is_button = |at: &usize| light(*at).role == PUSH_BUTTON;
    let buttons: Vec<usize> = below
        .iter()
        .copied()
        .filter(is_button)
        .filter(|at| {
            let nested = below
                .iter()
                .filter(|outer| is_button(outer) && *outer != at)
                .any(|outer| walk.within(*at, *outer));
            !nested
        })
        .collect();
    let unnamed = |at: &usize| light(*at).name.trim().is_empty();
    let header = buttons
        .iter()
        .find(|at| unnamed(at))
        .and_then(|at| walk.visits[*at].parent)?;
    let (mut heading, mut content) = (Vec::new(), Vec::new());
    for at in &below {
        let label = light(*at);
        let pressable = buttons.iter().any(|button| walk.within(*at, *button));
        if label.role != LABEL || label.name.trim().is_empty() || pressable {
            continue;
        }
        if walk.within(*at, header) {
            heading.push(label.name.as_str());
        } else {
            content.push(label.name.as_str());
        }
    }
    let (mut controls, mut actions) = (Vec::new(), Vec::new());
    for at in &buttons {
        match (walk.within(*at, header), unnamed(at)) {
            (true, true) => controls.push(light(*at).clone()),
            (false, false) => actions.push(light(*at).clone()),
            _ => {}
        }
    }
    let (app_name, title) = (heading.first()?, content.first()?);
    let body: Vec<&str> = content.iter().skip(1).copied().collect();
    Some(Entry {
        info: NotificationInfo {
            index,
            app_name: (*app_name).to_owned(),
            title: (*title).to_owned(),
            body: (!body.is_empty()).then(|| body.join("\n")),
            actions: actions.iter().map(|action| action.name.clone()).collect(),
        },
        node: light(root).element.clone(),
        header: controls,
        actions,
    })
}

#[cfg(test)]
#[path = "extract_tests.rs"]
mod tests;
