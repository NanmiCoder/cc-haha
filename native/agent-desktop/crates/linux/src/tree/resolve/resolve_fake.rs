use std::collections::HashMap;

use agent_desktop_core::{AdapterError, Deadline, LocatorEvidence, RefEntry};

use super::path_descent::level_of;
use super::resolve_search::evaluate;
use super::searched::Searched;
use crate::system::window::window_id;
use crate::tree::element::ancestry;
use crate::tree::live::test_support::{read_of, ref_entry};
use crate::tree::observe::node_evidence::evidence_for;
use crate::tree::observe::projection::project_node;
use crate::tree::resolve::Source;
use crate::tree::vocabulary::role_numbers::FRAME;
use crate::tree::walk::level::Level;
use crate::tree::walk::walker::walk_levels;
use crate::tree::walk::walker_expand::UNKNOWN_PID;
use crate::tree::walk::wrapper::classify;
use crate::tree::{
    AtspiElement, Expansion, Extents, Field, ObservedRead, RawNode, Walk, WalkLimits, WalkedNode,
};

pub(in crate::tree) const BUS: &str = ":1.2";
pub(in crate::tree) const FRAME_PATH: &str = "/frame";
pub(in crate::tree) const WINDOW_PID: u32 = 40;

pub(in crate::tree) struct FakeNode {
    pub(in crate::tree) bus: String,
    pub(in crate::tree) read: ObservedRead,
    pub(in crate::tree) children: Vec<String>,
    pub(in crate::tree) children_unread: bool,
}

#[derive(Default)]
pub(in crate::tree) struct Reads {
    pub(in crate::tree) gate: usize,
    pub(in crate::tree) levels: usize,
    pub(in crate::tree) evidence: usize,
    pub(in crate::tree) searches: usize,
}

/// The reads a test makes fail, by kind or by node path.
#[derive(Default)]
pub(in crate::tree) struct Faults {
    pub(in crate::tree) gate_error: Option<AdapterError>,
    pub(in crate::tree) recheck_error: Option<AdapterError>,
    pub(in crate::tree) search_error: Option<AdapterError>,
    pub(in crate::tree) level_errors: HashMap<String, AdapterError>,
    pub(in crate::tree) evidence_errors: HashMap<String, AdapterError>,
}

pub(in crate::tree) struct Fake {
    pub(in crate::tree) nodes: HashMap<String, FakeNode>,
    pub(in crate::tree) pids: HashMap<String, u32>,
    pub(in crate::tree) web_process: bool,
    pub(in crate::tree) stopped: Option<String>,
    pub(in crate::tree) faults: Faults,
    pub(in crate::tree) reads: Reads,
}

pub(in crate::tree) fn node(role: u32, name: &str, width: i32, height: i32) -> ObservedRead {
    let mut read = read_of(role, name, &[]);
    read.node.extents = Field::Present(Extents {
        x: 0,
        y: 0,
        width,
        height,
    });
    read
}

pub(in crate::tree) fn deadline() -> Deadline {
    Deadline::after(5_000).expect("a five second deadline builds")
}

impl Fake {
    pub(in crate::tree) fn new() -> Self {
        let mut fake = Self {
            nodes: HashMap::new(),
            pids: HashMap::from([(BUS.to_owned(), WINDOW_PID)]),
            web_process: false,
            stopped: None,
            faults: Faults::default(),
            reads: Reads::default(),
        };
        fake.add_on(BUS, None, FRAME_PATH, node(FRAME, "window", 800, 600));
        fake
    }

    pub(in crate::tree) fn add(&mut self, parent: &str, path: &str, read: ObservedRead) {
        self.add_on(BUS, Some(parent), path, read);
    }

    pub(in crate::tree) fn add_on(
        &mut self,
        bus: &str,
        parent: Option<&str>,
        path: &str,
        read: ObservedRead,
    ) {
        self.nodes.insert(
            path.to_owned(),
            FakeNode {
                bus: bus.to_owned(),
                read,
                children: Vec::new(),
                children_unread: false,
            },
        );
        if let Some(parent) = parent {
            self.nodes
                .get_mut(parent)
                .expect("the parent was added first")
                .children
                .push(path.to_owned());
        }
    }

    pub(in crate::tree) fn frame(&self) -> AtspiElement {
        let mut frame = AtspiElement::new(BUS, FRAME_PATH, WINDOW_PID);
        frame.set_ancestry(ancestry::of_root(&frame));
        frame
    }

    fn raw(&self, element: &AtspiElement) -> RawNode {
        let stored = &self.nodes[element.path()];
        let mut raw = stored.read.node.clone();
        raw.element = element.clone();
        raw.children = if stored.children_unread {
            Field::Failed("children unavailable".to_owned())
        } else {
            Field::Present(
                stored
                    .children
                    .iter()
                    .map(|path| (self.nodes[path].bus.clone(), path.clone()))
                    .collect(),
            )
        };
        raw
    }

    pub(in crate::tree) fn walk(&self) -> Walk<ObservedRead> {
        walk_levels(
            self.frame(),
            &WalkLimits::default(),
            deadline(),
            |level| {
                Ok(level
                    .iter()
                    .map(|element| {
                        if element.pid() == UNKNOWN_PID {
                            return Expansion {
                                payload: ObservedRead::unreadable(element.clone(), "unidentified"),
                                children: Vec::new(),
                                children_unread: false,
                                gone: true,
                            };
                        }
                        let raw = self.raw(element);
                        let unread = raw.children.is_failed();
                        let children = level_of(&raw, &self.pids, self.web_process).children;
                        let mut read = self.nodes[element.path()].read.clone();
                        read.node = raw;
                        Expansion {
                            payload: read,
                            children,
                            children_unread: unread,
                            gone: false,
                        }
                    })
                    .collect())
            },
            classify,
        )
        .expect("an in-memory walk cannot fail")
    }

    fn find<'a>(
        node: &'a WalkedNode<ObservedRead>,
        path: &str,
    ) -> Option<(&'a WalkedNode<ObservedRead>, Vec<usize>)> {
        if node.payload.node.element.path() == path {
            return Some((node, Vec::new()));
        }
        for child in &node.children {
            if let Some((found, mut trail)) = Self::find(child, path) {
                trail.insert(0, child.source_index);
                return Some((found, trail));
            }
        }
        None
    }

    /// The ref a snapshot would have stored for the node at `path`.
    pub(in crate::tree) fn entry_of(&self, path: &str, keep_rect: bool) -> RefEntry {
        let walk = self.walk();
        let (node, trail) = Self::find(&walk.root, path).expect("the node is walked");
        let evidence = project_node(&node.payload, node.in_web_document, &WalkLimits::default());
        let mut entry = ref_entry(evidence.role.known().expect("a role was read"));
        entry.identity.name = evidence.name.known().filter(|n| !n.is_empty()).cloned();
        entry.identity.native_id = evidence.identifiers.preferred_identifier().cloned();
        if keep_rect {
            let window = evidence.ref_evidence.window_bounds.known().copied();
            entry.geometry.bounds =
                window.or_else(|| evidence.ref_evidence.bounds.known().copied());
            entry.geometry.bounds_hash = entry.geometry.bounds.and_then(|b| b.bounds_hash());
            entry.geometry.bounds_space = window.map(|_| agent_desktop_core::BoundsSpace::Window);
        }
        entry.process.pid = WINDOW_PID.into();
        entry.process.process_instance = Some("inst".to_owned());
        entry.source.source_window_id = window_id::encode(BUS, FRAME_PATH);
        entry.scope.path = trail.into_iter().collect();
        entry
    }

    pub(in crate::tree) fn shift_every_position(&mut self, dx: i32, dy: i32) {
        for stored in self.nodes.values_mut() {
            if let Field::Present(extents) = &mut stored.read.node.extents {
                extents.x += dx;
                extents.y += dy;
            }
        }
    }
}

impl Source for Fake {
    fn open_window(&mut self, _entry: &RefEntry) -> Result<AtspiElement, AdapterError> {
        self.reads.gate += 1;
        if self.reads.gate > 1
            && let Some(error) = &self.faults.recheck_error
        {
            return Err(error.clone());
        }
        match self.faults.gate_error.clone() {
            Some(error) => Err(error),
            None => Ok(self.frame()),
        }
    }

    fn level(&mut self, element: &AtspiElement) -> Result<Level<AtspiElement>, AdapterError> {
        self.reads.levels += 1;
        if let Some(error) = self.faults.level_errors.get(element.path()) {
            return Err(error.clone());
        }
        if element.pid() == UNKNOWN_PID {
            return Err(AdapterError::new(
                agent_desktop_core::ErrorCode::ElementNotFound,
                "unidentified",
            ));
        }
        Ok(level_of(&self.raw(element), &self.pids, self.web_process))
    }

    fn evidence(&mut self, element: &AtspiElement) -> Result<LocatorEvidence, AdapterError> {
        self.reads.evidence += 1;
        if let Some(error) = self.faults.evidence_errors.get(element.path()) {
            return Err(error.clone());
        }
        let mut read = self.nodes[element.path()].read.clone();
        read.node = self.raw(element);
        Ok(evidence_for(&read, element))
    }

    fn search(
        &mut self,
        _frame: &AtspiElement,
        entry: &RefEntry,
    ) -> Result<Searched, AdapterError> {
        self.reads.searches += 1;
        if let Some(error) = self.faults.search_error.clone() {
            return Err(error);
        }
        Ok(evaluate(&self.walk(), entry, self.web_process))
    }

    fn stopped_app(&mut self, _pid: u32) -> Option<String> {
        self.stopped.clone()
    }
}
