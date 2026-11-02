use serde_json::{Value, json};

use crate::system::app::app_name::{aliases_of, app_name, name_matches};
use crate::system::process::process_facts::ProcessFacts;
use crate::system::process::toolkit_id::ToolkitId;
use crate::tree::AtspiElement;

/// One application on the accessibility registry. `answered` is false when
/// the application's own root did not reply in time; it is still an
/// application, named from `/proc` like every other. `registry_name` is the
/// root's own `Name` while it answered, retained as diagnostic evidence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RegistryApp {
    pub(crate) root: AtspiElement,
    pub(crate) name: String,
    pub(crate) registry_name: Option<String>,
    pub(crate) answered: bool,
    pub(crate) facts: ProcessFacts,
    pub(crate) toolkit: ToolkitId,
    pub(crate) aliases: Vec<String>,
}

/// Builds the entry for an application from what its bus name, its process
/// and its root said. `root_name` is `None` when the root did not answer.
/// Nothing the root failed to say removes the application from the list.
pub(crate) fn assemble(
    root: AtspiElement,
    facts: ProcessFacts,
    root_name: Option<Option<String>>,
    toolkit: ToolkitId,
) -> RegistryApp {
    let mut app = RegistryApp::from_process(root, facts);
    app.answered = root_name.is_some();
    app.registry_name = root_name.flatten().filter(|text| !text.trim().is_empty());
    app.toolkit = toolkit;
    app.aliases = aliases_of(&app.facts);
    app
}

impl RegistryApp {
    pub(crate) fn from_process(root: AtspiElement, facts: ProcessFacts) -> Self {
        Self {
            name: app_name(&facts),
            root,
            facts,
            registry_name: None,
            answered: false,
            toolkit: ToolkitId::default(),
            aliases: Vec::new(),
        }
    }

    /// Whether `query` names this application.
    pub(crate) fn matches(&self, query: &str) -> bool {
        name_matches(query, &self.name, &self.aliases)
    }
}

pub(crate) fn skipped(bus: &str, pid: Option<u32>, reason: &str, confirmed_gone: bool) -> Value {
    let mut record = json!({ "bus": bus, "reason": reason });
    if let Some(pid) = pid {
        record["pid"] = json!(pid);
    }
    if confirmed_gone {
        record["confirmed_gone"] = json!(true);
    }
    record
}

#[cfg(test)]
#[path = "registry_app_tests.rs"]
mod tests;
