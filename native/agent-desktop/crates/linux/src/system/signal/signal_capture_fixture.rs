use std::cell::RefCell;

use crate::system::process::process_facts::ProcessFacts;
use crate::system::process::toolkit_id::ToolkitId;
use crate::system::registry::registry_app::{RegistryApp, assemble};
use crate::tree::AtspiElement;

pub(super) fn app(index: u32, name: &str, answered: bool) -> RegistryApp {
    assemble(
        AtspiElement::new(
            format!(":1.{index}"),
            "/org/a11y/atspi/accessible/root",
            100 + index,
        ),
        ProcessFacts {
            executable: None,
            comm: name.to_owned(),
            exe_basename: Some(name.to_owned()),
            instance: format!("boot:{index}"),
        },
        answered.then(|| Some(name.to_owned())),
        ToolkitId::default(),
    )
}

#[derive(Clone, Default)]
pub(super) struct Scripted {
    pub(super) owner: usize,
    pub(super) id: &'static str,
    pub(super) active: bool,
    pub(super) sheet: bool,
}

pub(super) fn window(owner: usize, id: &'static str) -> Scripted {
    Scripted {
        owner,
        id,
        ..Scripted::default()
    }
}

#[derive(Default)]
pub(super) struct Reads {
    pub(super) registry_asks: RefCell<Vec<Option<u32>>>,
    pub(super) roots_read: RefCell<Vec<usize>>,
}
