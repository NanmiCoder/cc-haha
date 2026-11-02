use std::time::Duration;

use agent_desktop_core::{AdapterError, Deadline};
use futures_util::future::join;
use futures_util::stream::{self, StreamExt, TryStreamExt};
use serde_json::Value;
use zbus::Connection;
use zbus::zvariant::OwnedValue;

use super::{
    ACCESSIBLE_INTERFACE, PROPERTIES_INTERFACE, REGISTRY_ROOT_PATH, REGISTRY_SERVICE, SharedBus,
    owner_process_id, within,
};
use crate::system::app::app_names::AppNames;
use crate::system::bus::bus_slice::within_slice;
use crate::system::context::read_view::ReadView;
use crate::system::process::proc_stat;
use crate::system::process::process_facts;
use crate::system::process::process_lookup::Lookup;
use crate::system::process::toolkit_id::ToolkitId;
use crate::system::registry::app_read::AppRead;
use crate::system::registry::registry_app::{RegistryApp, assemble, skipped};
use crate::tree::AtspiElement;
use crate::tree::properties::toolkit_trust::read_toolkit;

pub(crate) const ROOT_SLICE: Duration = Duration::from_millis(300);
const APPS_IN_FLIGHT: usize = 32;

/// Every application on the registry, and those that could not be read.
pub(crate) struct Registry {
    pub(crate) apps: Vec<RegistryApp>,
    pub(crate) skipped: Vec<Value>,
}

async fn root_name(connection: &Connection, root: &AtspiElement) -> Option<Option<String>> {
    let reply = connection
        .call_method(
            Some(root.bus_name()),
            root.path(),
            Some(PROPERTIES_INTERFACE),
            "Get",
            &(ACCESSIBLE_INTERFACE, "Name"),
        )
        .await
        .ok()?;
    let value = reply.body().deserialize::<OwnedValue>().ok()?;
    Some(value.downcast_ref::<&str>().ok().map(str::to_owned))
}

pub(crate) async fn toolkit(connection: &Connection, root: &AtspiElement) -> ToolkitId {
    read_toolkit(connection, root).await.unwrap_or_default()
}

trait AppReads {
    fn facts(&self, pid: u32) -> Lookup;
    fn is_stopped(&self, pid: u32) -> bool;
    async fn name(&self, root: &AtspiElement) -> Option<Option<String>>;
    async fn toolkit(&self, root: &AtspiElement) -> ToolkitId;
    /// The name this root answered to before its process stopped.
    fn remembered_name(&self, root: &AtspiElement, instance: &str) -> Option<String>;
    /// Keeps the name this root answered to, against the process instance, so
    /// the application still resolves by it after the process stops.
    fn remember_name(&self, root: &AtspiElement, instance: &str, name: &str);
}

struct BusReads<'a>(&'a Connection);

impl AppReads for BusReads<'_> {
    fn facts(&self, pid: u32) -> Lookup {
        process_facts::lookup(pid)
    }

    fn is_stopped(&self, pid: u32) -> bool {
        proc_stat::is_stopped(pid)
    }

    async fn name(&self, root: &AtspiElement) -> Option<Option<String>> {
        within_slice(ROOT_SLICE, root_name(self.0, root))
            .await
            .flatten()
    }

    async fn toolkit(&self, root: &AtspiElement) -> ToolkitId {
        within_slice(ROOT_SLICE, toolkit(self.0, root))
            .await
            .unwrap_or_default()
    }

    fn remembered_name(&self, root: &AtspiElement, instance: &str) -> Option<String> {
        AppNames::in_runtime_dir()?.recall(root.bus_name(), instance)
    }

    fn remember_name(&self, root: &AtspiElement, instance: &str, name: &str) {
        if let Some(names) = AppNames::in_runtime_dir() {
            names.remember(root.bus_name(), instance, name);
        }
    }
}

async fn read_known(
    reads: &impl AppReads,
    root: AtspiElement,
    query: &app_query::AppQuery<'_>,
) -> AppRead {
    let pid = root.pid();
    if query.pid.is_some_and(|wanted| wanted != pid) {
        return AppRead::Excluded;
    }
    let facts = match reads.facts(pid) {
        Lookup::Found(facts) => facts,
        result => {
            return AppRead::Skipped(skipped(
                root.bus_name(),
                Some(pid),
                "the process identity could not be read",
                result == Lookup::Gone,
            ));
        }
    };
    let mut candidate = if query.enrich {
        assemble(root.clone(), facts, None, ToolkitId::default())
    } else {
        RegistryApp::from_process(root.clone(), facts)
    };
    if !(query.select)(&candidate) {
        return AppRead::Excluded;
    }
    if query.enrich && !reads.is_stopped(pid) {
        let (name, toolkit) = join(reads.name(&root), reads.toolkit(&root)).await;
        candidate.answered = name.is_some();
        candidate.registry_name = name.flatten().filter(|text| !text.trim().is_empty());
        candidate.toolkit = toolkit;
    } else if query.enrich {
        candidate.registry_name = reads.remembered_name(&root, &candidate.facts.instance);
    }
    let current = reads.facts(pid);
    if !matches!(&current, Lookup::Found(current) if current.instance == candidate.facts.instance) {
        return AppRead::Skipped(skipped(
            root.bus_name(),
            Some(pid),
            "the process changed during the read",
            current == Lookup::Gone,
        ));
    }
    if let Some(answered) = candidate.registry_name.as_deref()
        && candidate.answered
    {
        reads.remember_name(&root, &candidate.facts.instance, answered);
    }
    AppRead::Listed(Box::new(candidate))
}

async fn read_app(
    shared: &SharedBus,
    connection: &zbus::blocking::Connection,
    address: (String, String),
    query: &app_query::AppQuery<'_>,
) -> Result<AppRead, AdapterError> {
    let (bus_name, path) = address;
    let pid = match owner_process_id(connection.inner(), &bus_name).await {
        Ok(pid) => pid,
        Err(zbus::Error::MethodError(name, _, _)) if name.as_str() == super::NAME_HAS_NO_OWNER => {
            return Ok(AppRead::Skipped(skipped(
                &bus_name,
                None,
                "the bus name has no owner",
                true,
            )));
        }
        Err(error) => {
            if super::bus::is_connection_failure(&error) {
                shared.forget(connection);
            }
            return Err(super::bus::classify(&error));
        }
    };
    Ok(read_known(
        &BusReads(connection.inner()),
        AtspiElement::new(bus_name, path, pid),
        query,
    )
    .await)
}

/// One pass over the registry. An application whose bus name or process is
/// gone is reported as skipped; one that does not answer its own calls is
/// still listed, with its process id from the bus daemon and its name from
/// `/proc`.
pub(crate) fn read_registry(bus: &SharedBus, deadline: Deadline) -> Result<Registry, AdapterError> {
    read_registry_for(bus, None, deadline)
}

pub(crate) fn read_processes(
    bus: &SharedBus,
    deadline: Deadline,
) -> Result<Registry, AdapterError> {
    read_registry_query(
        bus,
        &app_query::AppQuery {
            pid: None,
            select: &|_| true,
            enrich: false,
        },
        deadline,
    )
}

/// One pass over the registry for one process, or for every process when
/// `pid` is `None`. Another process's application is left out of the result
/// and its facts, name and toolkit are never read.
pub(crate) fn read_registry_for(
    bus: &SharedBus,
    pid: Option<u32>,
    deadline: Deadline,
) -> Result<Registry, AdapterError> {
    read_registry_query(
        bus,
        &app_query::AppQuery {
            pid,
            select: &|_| true,
            enrich: true,
        },
        deadline,
    )
}

pub(crate) fn read_registry_query(
    bus: &SharedBus,
    query: &app_query::AppQuery<'_>,
    deadline: Deadline,
) -> Result<Registry, AdapterError> {
    let view = ReadView::begin(bus, deadline)?;
    let connection = &view.connection;
    let listed = within(deadline, async {
        let reply = connection
            .inner()
            .call_method(
                Some(REGISTRY_SERVICE),
                REGISTRY_ROOT_PATH,
                Some(ACCESSIBLE_INTERFACE),
                "GetChildren",
                &(),
            )
            .await
            .map_err(|error| {
                if super::bus::is_connection_failure(&error) {
                    bus.forget(connection);
                }
                super::bus::classify(&error)
            })?;
        let children = reply
            .body()
            .deserialize::<Vec<(String, zbus::zvariant::OwnedObjectPath)>>()
            .map_err(|error| super::bus::classify(&error))?;
        let reads: Vec<AppRead> = stream::iter(
            children
                .into_iter()
                .filter(|(bus, path)| !bus.is_empty() && path.as_str() != "/org/a11y/atspi/null")
                .map(|(name, path)| read_app(bus, connection, (name, path.to_string()), query)),
        )
        .buffered(APPS_IN_FLIGHT)
        .try_collect()
        .await?;
        let mut listed = Registry {
            apps: Vec::new(),
            skipped: Vec::new(),
        };
        for read in reads {
            match read {
                AppRead::Listed(app) => listed.apps.push(*app),
                AppRead::Skipped(record) => listed.skipped.push(record),
                AppRead::Excluded => {}
            }
        }
        Ok(listed)
    })?;
    view.finish(deadline)?;
    Ok(listed)
}

#[cfg(test)]
#[path = "registry_tests.rs"]
mod tests;

pub(crate) mod app_outcome;
pub(super) mod app_read;
pub(crate) mod frame_read;
pub(super) mod listed_window;
pub(super) mod registry_app;
pub(super) mod registry_frames;
#[cfg(test)]
pub(super) mod registry_live_tests;

pub(crate) mod app_query;
