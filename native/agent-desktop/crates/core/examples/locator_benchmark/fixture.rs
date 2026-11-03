use crate::fixture_node::FixtureNode;
use agent_desktop_core::WindowInfo;

#[derive(Clone)]
pub(crate) struct Fixture {
    pub nodes: Vec<FixtureNode>,
    pub roots: Vec<u32>,
    pub window: WindowInfo,
}
