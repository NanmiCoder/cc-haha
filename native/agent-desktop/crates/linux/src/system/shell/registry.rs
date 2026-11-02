use agent_desktop_core::AdapterError;
use futures_util::stream::{self, StreamExt, TryStreamExt};
use zbus::Connection;

use crate::system::{NAME_HAS_NO_OWNER, REGISTRY_ROOT_PATH, REGISTRY_SERVICE, owner_process_id};
use crate::tree::{AtspiElement, list_children};

pub(super) async fn read(
    accessibility: &Connection,
) -> Result<Vec<(AtspiElement, u32)>, AdapterError> {
    let registry = AtspiElement::new(REGISTRY_SERVICE, REGISTRY_ROOT_PATH, 0);
    let children = list_children(accessibility, &registry).await?;
    let apps: Vec<_> = stream::iter(children.into_iter().map(|(bus, path)| async move {
        match owner_process_id(accessibility, &bus).await {
            Ok(pid) => Ok(Some((AtspiElement::new(bus, path, pid), pid))),
            Err(zbus::Error::MethodError(name, _, _)) if name.as_str() == NAME_HAS_NO_OWNER => {
                Ok(None)
            }
            Err(error) => Err(crate::system::classify(&error)),
        }
    }))
    .buffered(32)
    .try_collect()
    .await?;
    Ok(apps.into_iter().flatten().collect())
}

#[cfg(test)]
#[path = "registry_tests.rs"]
mod tests;
