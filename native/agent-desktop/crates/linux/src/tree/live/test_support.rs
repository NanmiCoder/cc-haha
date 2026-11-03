use std::collections::BTreeMap;

use agent_desktop_core::{
    ElementIdentifier, IdentifierEvidence, IdentifierKind, LocatorEvidence, LocatorField,
    LocatorRefEvidence, NodeDescriptor, ProcessId, Rect, RefEntry,
};

use crate::tree::{
    AtspiElement, Extents, Field, NodeProperties, NodeTraits, ObservedRead, RawNode,
};

pub(crate) const BLOCKING_ARGS: [&str; 2] = ["-c", "while :; do sleep 1; done"];

/// Unlike multicall coreutils, a standalone shell keeps working under a fixture's name.
/// Run with BLOCKING_ARGS: the copy stays alive under that name until killed, in the
/// foreground or in the background, and needs no input.
pub(crate) fn copy_blocking_program(directory: &std::path::Path, name: &str) -> std::path::PathBuf {
    let program = directory.join(name);
    let shell = std::fs::canonicalize("/bin/sh").expect("the system shell");
    std::fs::copy(shell, &program).expect("a copy of the standalone shell");
    program
}

pub(crate) fn closed_connection() -> zbus::Connection {
    use zbus::connection::Builder;
    let (near, far) = std::os::unix::net::UnixStream::pair().unwrap();
    let (client, server) = zbus::block_on(futures_lite::future::zip(
        Builder::async_io_unix_stream(near).p2p().build(),
        Builder::async_io_unix_stream(far)
            .server(zbus::Guid::generate())
            .unwrap()
            .p2p()
            .build(),
    ));
    let client = client.unwrap();
    zbus::block_on(client.clone().close()).unwrap();
    drop(server.unwrap());
    client
}

pub(crate) fn attributes(pairs: &[(&str, &str)]) -> Field<BTreeMap<String, String>> {
    Field::Present(
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect(),
    )
}

pub(crate) fn words(bits: &[u32]) -> Vec<u32> {
    let mut words = vec![0u32; 2];
    for bit in bits {
        words[(*bit / 32) as usize] |= 1 << (*bit % 32);
    }
    words
}

/// A fully read node: every field present, so a test changes only what it
/// is about.
pub(crate) fn read_of(role: u32, name: &str, actions: &[&str]) -> ObservedRead {
    let node = RawNode {
        element: AtspiElement::new(":1.1", "/p", 1),
        properties: NodeProperties {
            name: Field::Present(name.to_owned()),
            description: Field::Present(String::new()),
            child_count: Field::Present(0),
            accessible_id: Field::Present(String::new()),
        },
        traits: NodeTraits {
            role: Field::Present(role),
            role_name: Field::Present("role".to_owned()),
            states: Field::Present(words(&[8, 25])),
            interfaces: Field::Present(Vec::new()),
        },
        attributes: attributes(&[]),
        extents: Field::Present(Extents {
            x: 0,
            y: 0,
            width: 10,
            height: 10,
        }),
        actions: Field::Present(actions.iter().map(|name| (*name).to_owned()).collect()),
        children: Field::Present(Vec::new()),
    };
    ObservedRead::plain(node)
}

pub(crate) fn method_error(name: &str) -> zbus::Error {
    let call = zbus::Message::method_call("/probe", "Probe")
        .and_then(|builder| builder.build(&()))
        .expect("a method call message must build");
    let reply = zbus::Message::error(&call.header(), name)
        .and_then(|builder| builder.build(&()))
        .expect("an error reply must build");
    zbus::Error::MethodError(name.try_into().expect("a valid error name"), None, reply)
}

pub(crate) fn client_timeout() -> zbus::Error {
    zbus::Error::InputOutput(std::sync::Arc::new(std::io::Error::from(
        std::io::ErrorKind::TimedOut,
    )))
}

pub(crate) fn ref_entry(role: &str) -> RefEntry {
    RefEntry {
        process: agent_desktop_core::RefProcess {
            pid: ProcessId::new(1),
            process_instance: None,
        },
        identity: agent_desktop_core::RefEntryIdentity {
            retained_object: None,
            role: role.to_owned(),
            name: None,
            value: None,
            description: None,
            native_id: None,
        },
        geometry: agent_desktop_core::RefGeometry {
            bounds_space: None,
            bounds: None,
            bounds_hash: None,
        },
        capabilities: agent_desktop_core::RefCapabilities {
            states: Vec::new(),
            available_actions: Vec::new(),
        },
        source: agent_desktop_core::RefSource {
            source_app: None,
            source_window_id: None,
            source_window_title: None,
            source_window_bounds_hash: None,
            source_surface: agent_desktop_core::SnapshotSurface::Window,
        },
        scope: agent_desktop_core::RefScope {
            root_ref: None,
            path_is_absolute: false,
            path: agent_desktop_core::refs::RefPath::default(),
        },
    }
}

pub(crate) fn with_identifier(mut entry: RefEntry, value: &str) -> RefEntry {
    entry.identity.native_id = Some(ElementIdentifier {
        kind: IdentifierKind::AxIdentifier,
        value: value.to_owned(),
    });
    entry
}

pub(crate) fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
    Rect {
        x,
        y,
        width,
        height,
    }
}

/// Evidence for a node with the given role, name, identifier and rectangle;
/// a missing name or rectangle is known absent and the identifiers are
/// complete.
pub(crate) fn evidence(
    role: &str,
    name: Option<&str>,
    identifier: Option<&str>,
    bounds: Option<Rect>,
) -> LocatorEvidence {
    LocatorEvidence {
        role: LocatorField::Known(role.to_owned()),
        name: name.map_or(LocatorField::Absent, |text| {
            LocatorField::Known(text.to_owned())
        }),
        description: LocatorField::Absent,
        value: LocatorField::Absent,
        identifiers: IdentifierEvidence::typed(
            identifier.map(|value| ElementIdentifier {
                kind: IdentifierKind::AxIdentifier,
                value: value.to_owned(),
            }),
            None,
            true,
        ),
        states: LocatorField::Absent,
        ref_evidence: LocatorRefEvidence {
            window_bounds: LocatorField::Absent,
            bounds: bounds.map_or(LocatorField::Absent, LocatorField::Known),
            available_actions: LocatorField::Absent,
            descriptors: NodeDescriptor::default(),
        },
    }
}

/// A successful `GetChildren` reply listing the given bus name and path pairs.
pub(crate) fn children_reply(entries: &[(&str, &str)]) -> Result<zbus::Message, zbus::Error> {
    let call = zbus::Message::method_call("/probe", "GetChildren")?.build(&())?;
    let body: Vec<(String, zbus::zvariant::OwnedObjectPath)> = entries
        .iter()
        .map(|(bus, path)| {
            Ok((
                (*bus).to_owned(),
                zbus::zvariant::OwnedObjectPath::try_from(*path)?,
            ))
        })
        .collect::<Result<_, zbus::zvariant::Error>>()?;
    zbus::Message::method_return(&call.header())?.build(&body)
}
