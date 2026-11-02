use super::*;
use crate::actions::native_menu::native_menu_search::strip_mnemonic;
use std::sync::{Arc, Mutex};
use zbus::zvariant::Value;

fn item(entries: &[(&str, Value<'_>)]) -> Item {
    entries
        .iter()
        .map(|(key, value)| ((*key).to_owned(), value.try_to_owned().unwrap()))
        .collect()
}

#[test]
fn resolves_exact_labels_through_sections_and_preserves_submenu_identity() {
    let menus = Menus::from([
        (
            (0, 0),
            vec![item(&[
                ("label", Value::from("_File")),
                (":submenu", Value::from((1u32, 0u32))),
            ])],
        ),
        (
            (1, 0),
            vec![item(&[(":section", Value::from((1u32, 3u32)))])],
        ),
        (
            (1, 3),
            vec![item(&[
                ("label", Value::from("_Save")),
                ("action", Value::from("win.file.save")),
                ("target", Value::from(7u32)),
            ])],
        ),
    ]);
    let groups = HashSet::from([0, 1]);
    assert!(matches!(
        find(&menus, &groups, (0, 0), 0, "File"),
        Search::Found((0, 0), 0, 0)
    ));
    assert_eq!(link(&menus[&(0, 0)][0][":submenu"]), Some((1, 0)));
    assert!(matches!(
        find(&menus, &groups, (1, 0), 1, "Save      "),
        Search::Found((1, 3), 0, 2)
    ));
    let resolved = resolve_action(&menus[&(1, 3)][0]).unwrap();
    assert_eq!(resolved.name, "win.file.save");
    assert_eq!(u32::try_from(resolved.target.as_ref().unwrap()).unwrap(), 7);
    assert!(resolve_action(&menus[&(0, 0)][0]).is_none());
    assert!(matches!(
        find(&menus, &groups, (1, 0), 1, "save"),
        Search::Invalid
    ));
}

#[test]
fn rejects_ambiguous_labels_cycles_malformed_links_and_depth_exhaustion() {
    let save = || {
        item(&[
            ("label", Value::from("_Save")),
            ("action", Value::from("win.save")),
        ])
    };
    let groups = HashSet::from([0]);
    for items in [
        vec![save(), save()],
        vec![
            save(),
            item(&[
                ("label", Value::from("Save      ")),
                ("action", Value::from("win.other")),
            ]),
        ],
        vec![save(), item(&[(":section", Value::from((0u32, 0u32)))])],
        vec![save(), item(&[(":section", Value::from("bad"))])],
        vec![
            save(),
            item(&[(":submenu", Value::from((0u32, 0u32, 0u32)))]),
        ],
    ] {
        assert!(matches!(
            find(&Menus::from([((0, 0), items)]), &groups, (0, 0), 0, "Save"),
            Search::Invalid
        ));
    }
    let menus = Menus::from([((0, 0), vec![save()])]);
    assert!(matches!(
        find(&menus, &groups, (0, 0), 16, "Save"),
        Search::Invalid
    ));
    assert!(matches!(
        find(&menus, &HashSet::new(), (0, 0), 0, "Save"),
        Search::Load(0)
    ));
    assert_eq!(strip_mnemonic("Save __as _copy"), "Save _as copy");
}

type MenuCalls = Arc<Mutex<Vec<(String, Vec<u32>)>>>;

struct ExportedMenus {
    wrong_group: bool,
    calls: MenuCalls,
}

#[zbus::interface(name = "org.gtk.Menus")]
impl ExportedMenus {
    fn start(&self, groups: Vec<u32>) -> Layout {
        self.calls
            .lock()
            .unwrap()
            .push(("Start".into(), groups.clone()));
        match groups.as_slice() {
            [0] => vec![(
                0,
                0,
                vec![item(&[
                    ("label", Value::from("_File")),
                    (":submenu", Value::from((1u32, 0u32))),
                ])],
            )],
            [1] => vec![(
                if self.wrong_group { 2 } else { 1 },
                0,
                vec![item(&[
                    ("label", Value::from("_Save")),
                    ("action", Value::from("win.save")),
                ])],
            )],
            _ => panic!("unexpected subscription {groups:?}"),
        }
    }

    fn end(&self, groups: Vec<u32>) {
        self.calls.lock().unwrap().push(("End".into(), groups));
    }
}

#[test]
fn exported_menu_transport_follows_groups_and_ends_them_on_success_or_invalid_data() {
    use zbus::connection::Builder;

    for wrong_group in [false, true] {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let (client, server) = std::os::unix::net::UnixStream::pair().unwrap();
        let (client, server) = zbus::block_on(futures_lite::future::zip(
            Builder::async_io_unix_stream(client).p2p().build(),
            Builder::async_io_unix_stream(server)
                .server(zbus::Guid::generate())
                .unwrap()
                .p2p()
                .serve_at(
                    "/menus",
                    ExportedMenus {
                        wrong_group,
                        calls: calls.clone(),
                    },
                )
                .unwrap()
                .build(),
        ));
        let _server = server.unwrap();
        let result =
            crate::system::within(agent_desktop_core::Deadline::after(2_000).unwrap(), async {
                resolve(
                    &client.unwrap(),
                    ":1.1",
                    "/menus",
                    &["File".into(), "Save      ".into()],
                )
                .await
                .map_err(crate::actions::native_menu::read_error)
            })
            .unwrap();
        assert_eq!(
            result.map(|action| action.name),
            (!wrong_group).then(|| "win.save".into())
        );
        assert_eq!(
            *calls.lock().unwrap(),
            [
                ("Start".into(), vec![0]),
                ("Start".into(), vec![1]),
                ("End".into(), vec![0, 1]),
            ]
        );
    }
}
