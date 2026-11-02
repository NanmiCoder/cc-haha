use std::time::Duration;

use crate::input::plan::Plan;
use crate::input::step::Step;

/// Press to press, the longest a receiver check may keep the next click of a
/// multi-click gesture waiting. GTK, Qt and GNOME read two presses as one
/// gesture only inside 400 ms, so the budget keeps a margin.
pub(crate) const PRESS_TO_PRESS_BUDGET: Duration = Duration::from_millis(300);

/// The plans of one physical gesture and the time its presses may take.
pub(crate) struct Gesture {
    pub(crate) plans: Vec<Plan>,
    pub(crate) press_budget: Option<Duration>,
}

impl Gesture {
    pub(crate) fn unbounded(plans: Vec<Plan>) -> Self {
        Self {
            plans,
            press_budget: None,
        }
    }

    /// Gives every press its own plan, so the receiver is proven before each one.
    pub(crate) fn clicks(plans: Vec<Plan>) -> Self {
        Self {
            plans: plans.into_iter().flat_map(split_presses).collect(),
            press_budget: Some(PRESS_TO_PRESS_BUDGET),
        }
    }
}

fn split_presses(plan: Plan) -> Vec<Plan> {
    let Plan {
        steps,
        release_origin,
    } = plan;
    let mut plans = Vec::new();
    let mut current = Vec::new();
    let mut presses = 0;
    for step in steps {
        if matches!(step, Step::Button { down: true, .. }) {
            presses += 1;
            if presses > 1 {
                plans.push(Plan {
                    steps: std::mem::take(&mut current),
                    release_origin,
                });
            }
        }
        current.push(step);
    }
    plans.push(Plan {
        steps: current,
        release_origin,
    });
    plans
}

#[cfg(test)]
#[path = "gesture_tests.rs"]
mod tests;
