use std::collections::HashMap;
use std::time::Duration;

use super::*;

pub(crate) fn el(path: &str) -> AtspiElement {
    AtspiElement::new(":1.1", path, 1)
}

/// In-memory point results and verified ancestry. Missing parent edges are
/// deliberately unverified; point coordinates are retained for calibration.
#[derive(Default)]
pub(crate) struct FakeNodes {
    pub(crate) leads: HashMap<String, Hit>,
    pub(crate) child_lists: HashMap<String, Vec<String>>,
    pub(crate) parents: HashMap<String, String>,
    pub(crate) described: HashMap<String, Described>,
    pub(crate) endless: bool,
    pub(crate) points: Vec<(i32, i32)>,
    pub(crate) calls: Vec<&'static str>,
}

impl FakeNodes {
    pub(crate) fn lead(&mut self, from: &str, to: &str) -> &mut Self {
        self.leads.insert(from.to_owned(), Hit::Object(el(to)));
        self
    }

    pub(crate) fn parent(&mut self, node: &str, parent: &str) -> &mut Self {
        self.parents.insert(node.to_owned(), parent.to_owned());
        self
    }
}

impl NodeSource for FakeNodes {
    fn at_point(&mut self, from: &AtspiElement, point: (i32, i32)) -> Result<Hit, AdapterError> {
        self.calls.push("at_point");
        self.points.push(point);
        if self.endless {
            return Ok(Hit::Object(el(&format!("{}x", from.path()))));
        }
        Ok(self.leads.get(from.path()).cloned().unwrap_or(Hit::Null))
    }

    fn verified_parent(
        &mut self,
        node: &AtspiElement,
    ) -> Result<Option<AtspiElement>, AdapterError> {
        self.calls.push("verified_parent");
        Ok(self.parents.get(node.path()).map(|path| el(path)))
    }

    fn children(&mut self, node: &AtspiElement) -> Result<Option<Vec<AtspiElement>>, AdapterError> {
        self.calls.push("children");
        Ok(Some(match self.child_lists.get(node.path()) {
            Some(paths) => paths.iter().map(|path| el(path)).collect(),
            None => self
                .parents
                .iter()
                .filter(|(_, owner)| owner.as_str() == node.path())
                .map(|(path, _)| el(path))
                .collect(),
        }))
    }

    fn describe(&mut self, node: &AtspiElement) -> Result<Described, AdapterError> {
        self.calls.push("describe");
        Ok(self.described.get(node.path()).cloned().unwrap_or_default())
    }
}

fn deadline() -> Deadline {
    Deadline::after(5_000).expect("a deadline builds")
}

fn tree() -> FakeNodes {
    let mut nodes = FakeNodes::default();
    nodes
        .parent("/pane", "/frame")
        .parent("/target", "/pane")
        .parent("/child", "/target")
        .parent("/other", "/frame")
        .parent("/deep", "/target");
    nodes
}

fn run(nodes: &mut FakeNodes) -> Located {
    let frame = el("/frame");
    let chain = descend(nodes, &frame, (10, 10), deadline()).expect("the descent runs");
    let target = el("/target");
    locate(
        nodes,
        &Probe {
            target: &target,
            frame: &frame,
            window_point: (10, 10),
        },
        chain.as_deref(),
        deadline(),
    )
    .expect("locate runs")
}

#[test]
fn landings_match_verified_ancestry_and_geometry() {
    let mut nodes = tree();
    nodes
        .lead("/frame", "/pane")
        .lead("/pane", "/target")
        .lead("/target", "/child");
    assert_eq!(run(&mut nodes).landing, Landing::OnTarget);

    let mut nodes = tree();
    nodes.lead("/frame", "/pane").lead("/pane", "/target");
    nodes.lead("/target", "/target");
    assert_eq!(run(&mut nodes).landing, Landing::OnTarget);

    let mut nodes = tree();
    nodes.lead("/frame", "/deep");
    assert_eq!(run(&mut nodes).landing, Landing::OnTarget);

    let mut nodes = tree();
    nodes.lead("/frame", "/pane");
    assert_eq!(run(&mut nodes).landing, Landing::Ancestor);

    let mut nodes = tree();
    nodes.lead("/frame", "/frame");
    assert_eq!(run(&mut nodes).landing, Landing::Ancestor);

    let mut nodes = tree();
    nodes.lead("/frame", "/other");
    nodes.described.insert(
        "/other".to_owned(),
        Described {
            role: Some("push button".to_owned()),
            name: Some("Close".to_owned()),
            window_extents: Some(Extents {
                x: 0,
                y: 0,
                width: 50,
                height: 50,
            }),
        },
    );
    let located = run(&mut nodes);
    assert_eq!(located.landing, Landing::Elsewhere { contained: true });
    assert_eq!(
        located.lander.expect("described").name.as_deref(),
        Some("Close")
    );

    let mut nodes = tree();
    nodes.lead("/frame", "/other");
    nodes.described.insert(
        "/other".to_owned(),
        Described {
            window_extents: Some(Extents {
                x: 400,
                y: 400,
                width: 50,
                height: 50,
            }),
            ..Described::default()
        },
    );
    assert_eq!(
        run(&mut nodes).landing,
        Landing::Elsewhere { contained: false }
    );

    let mut nodes = tree();
    nodes.parents.remove("/target");
    nodes.leads.insert(
        "/frame".to_owned(),
        Hit::Object(AtspiElement::new(":1.2", "/target", 1)),
    );
    assert_eq!(run(&mut nodes).landing, Landing::Unresolved);
}

#[test]
fn null_failed_and_capped_queries_remain_unresolved() {
    assert_eq!(run(&mut tree()).landing, Landing::Unresolved);

    let mut nodes = tree();
    nodes.leads.insert("/frame".to_owned(), Hit::Failed);
    assert_eq!(run(&mut nodes).landing, Landing::Unresolved);

    let mut nodes = tree();
    nodes.lead("/frame", "/pane");
    nodes.leads.insert("/pane".to_owned(), Hit::Failed);
    assert_eq!(run(&mut nodes).landing, Landing::Unresolved);

    let mut nodes = tree();
    nodes.endless = true;
    let frame = el("/frame");
    let chain = descend(&mut nodes, &frame, (1, 1), deadline()).expect("descent runs");
    assert_eq!(nodes.points.len(), 50);
    assert_eq!(chain, None);
    assert_eq!(
        locate(
            &mut nodes,
            &Probe {
                target: &el("/target"),
                frame: &frame,
                window_point: (1, 1)
            },
            chain.as_deref(),
            deadline(),
        )
        .expect("locate runs")
        .landing,
        Landing::Unresolved
    );

    let mut nodes = tree();
    nodes.lead("/frame", "/other");
    nodes.parents.remove("/target");
    assert_eq!(run(&mut nodes).landing, Landing::Unresolved);
}

#[test]
fn deadline_and_window_point_are_preserved() {
    let mut nodes = tree();
    nodes.lead("/frame", "/target");
    let spent = Deadline::after(1).expect("a deadline builds");
    std::thread::sleep(Duration::from_millis(20));
    let error = descend(&mut nodes, &el("/frame"), (1, 1), spent).expect_err("timed out");
    assert_eq!(error.code, agent_desktop_core::ErrorCode::Timeout);
    assert!(nodes.points.is_empty());

    let mut nodes = tree();
    nodes.lead("/frame", "/target");
    descend(&mut nodes, &el("/frame"), (210, 17), deadline()).expect("descent runs");
    assert_eq!(nodes.points.first(), Some(&(210, 17)));
}

#[test]
fn a_lander_whose_own_ancestry_cannot_be_verified_is_unproved_whatever_its_rectangle() {
    let extents = |x, y, width, height| Described {
        window_extents: Some(Extents {
            x,
            y,
            width,
            height,
        }),
        ..Described::default()
    };
    for lander in [
        extents(0, 0, 20, 20),
        extents(0, 0, 200, 200),
        Described::default(),
    ] {
        let mut nodes = tree();
        nodes.lead("/frame", "/other");
        nodes.parents.remove("/other");
        nodes
            .described
            .insert("/target".to_owned(), extents(0, 0, 100, 100));
        nodes.described.insert("/other".to_owned(), lander);
        assert_eq!(run(&mut nodes).landing, Landing::Unproved);
    }
}
