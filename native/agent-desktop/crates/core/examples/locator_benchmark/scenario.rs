use crate::fixture::Fixture;
use agent_desktop_core::{LocatorQuery, Rect};
use std::collections::BTreeSet;

pub(crate) struct Scenario {
    pub name: &'static str,
    pub frames: Vec<Fixture>,
    pub query: LocatorQuery,
    pub expected_matches: usize,
}

impl Scenario {
    pub fn frame(&self, run: usize) -> &Fixture {
        &self.frames[run % self.frames.len()]
    }

    pub fn moving_bounds_verified(&self) -> bool {
        let bounds = self
            .frames
            .iter()
            .flat_map(target_bounds)
            .map(rect_key)
            .collect::<BTreeSet<_>>();
        bounds.len() > 1
    }
}

fn target_bounds(fixture: &Fixture) -> impl Iterator<Item = Rect> + '_ {
    fixture.nodes.iter().filter_map(|node| {
        node.identifiers
            .1
            .as_deref()
            .is_some_and(|value| value == "composer-send")
            .then_some(node.bounds)
    })
}

fn rect_key(bounds: Rect) -> (i64, i64, i64, i64) {
    (
        (bounds.x * 100.0) as i64,
        (bounds.y * 100.0) as i64,
        (bounds.width * 100.0) as i64,
        (bounds.height * 100.0) as i64,
    )
}
