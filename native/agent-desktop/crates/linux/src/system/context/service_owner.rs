use agent_desktop_core::{AdapterError, Deadline, ProcessIdentity};
use zbus::Connection;

use crate::system::process::{proc_stat, process_facts};
use crate::system::{REGISTRY_SERVICE, owner_process_id, within};

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct ServiceOwner {
    connection: String,
    name: String,
    process: ProcessIdentity,
}

impl ServiceOwner {
    pub(crate) fn read(
        connection: &Connection,
        known: Option<&Self>,
        deadline: Deadline,
    ) -> Result<Self, AdapterError> {
        within(deadline, async {
            let reply = connection
                .call_method(
                    Some("org.freedesktop.DBus"),
                    "/org/freedesktop/DBus",
                    Some("org.freedesktop.DBus"),
                    "GetNameOwner",
                    &(REGISTRY_SERVICE,),
                )
                .await
                .map_err(|error| crate::system::classify(&error))?;
            let name = reply
                .body()
                .deserialize::<String>()
                .map_err(|error| crate::system::classify(&error))?;
            let connection_id = format!(
                "{}:{}",
                connection.server_guid(),
                connection.unique_name().map_or("", |name| name.as_str())
            );
            if let Some(known) =
                known.filter(|known| known.connection == connection_id && known.name == name)
            {
                if instance(known.process.pid.get())? != known.process.instance {
                    return Err(AdapterError::internal(
                        "The registry service process changed during the read",
                    ));
                }
                return Ok(known.clone());
            }
            let pid = owner_process_id(connection, &name)
                .await
                .map_err(|error| crate::system::classify(&error))?;
            Ok(Self {
                connection: connection_id,
                name,
                process: ProcessIdentity::new(pid, instance(pid)?),
            })
        })
    }
}

fn instance(pid: u32) -> Result<String, AdapterError> {
    proc_stat::read_stat(pid)
        .ok()
        .flatten()
        .map(|stat| process_facts::instance_token(stat.start_time))
        .ok_or_else(|| {
            AdapterError::internal("The registry service process identity could not be read")
        })
}
