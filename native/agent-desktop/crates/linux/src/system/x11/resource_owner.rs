use x11rb::protocol::res::{ClientIdMask, ClientIdSpec, ConnectionExt};
use x11rb::rust_connection::RustConnection;

pub(super) fn pid(connection: &RustConnection, window: u32) -> Option<u32> {
    let reply = connection
        .res_query_client_ids(&[ClientIdSpec {
            client: window,
            mask: ClientIdMask::LOCAL_CLIENT_PID,
        }])
        .ok()?
        .reply()
        .ok()?;
    let ids: Vec<_> = reply
        .ids
        .iter()
        .filter(|id| id.spec.mask == ClientIdMask::LOCAL_CLIENT_PID)
        .flat_map(|id| id.value.iter().copied())
        .collect();
    match ids.as_slice() {
        [pid] if *pid != 0 => Some(*pid),
        _ => None,
    }
}
