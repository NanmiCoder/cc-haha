use std::path::PathBuf;

use agent_desktop_core::{Deadline, IdentifierKind, LocatorField};
use zbus::Connection as AsyncConnection;
use zbus::blocking::Connection;

use super::live_launch::{Launched, nonce, program_of, run_leg, vscode_arguments};
use super::live_qt;
use super::live_tree::{frames_where, pid_frame};
use super::vocabulary_live_analysis::{
    Analysis, is_disabled, name_is_blank, root_is_window, token, walk,
};
use crate::system::SharedBus;
use crate::tree::vocabulary::label_read::first_label_target;
use crate::tree::vocabulary::role_numbers::TEXT;
use crate::tree::{AtspiElement, LabelOutcome, read_label, resolve_vocabulary};

const TERMINAL_SERVER: &str = "gnome-terminal-server";
const NOTIFICATION: u32 = 101;

fn files(bus: &SharedBus, connection: &Connection) -> Result<(), String> {
    let mut launched = Launched::new();
    let pid = launched.try_spawn("nautilus", &["--new-window"])?;
    let (_, analysis) = walk(bus, "files", 30, Some(pid), || pid_frame(connection, pid))?;
    root_is_window(&analysis)?;
    blank_labelled_nodes("files", &analysis)?;
    let enabled_buttons = analysis
        .entries
        .iter()
        .filter(|entry| token(&entry.vocabulary.role) == "button" && !is_disabled(entry))
        .count();
    if enabled_buttons == 0 {
        return Err("files: no button resolved enabled".to_owned());
    }
    Ok(())
}

fn terminal(bus: &SharedBus, connection: &Connection) -> Result<(), String> {
    let is_server = |pid: u32| program_of(pid).as_deref() == Some(TERMINAL_SERVER);
    let known: Vec<AtspiElement> = frames_where(connection, is_server);
    let mut launched = Launched::new();
    let guard = std::env::temp_dir().join(nonce("vocabulary-terminal"));
    std::fs::create_dir_all(&guard).map_err(|error| error.to_string())?;
    launched.scratch.push(guard.clone());
    let script = format!(
        "while [ -d '{}' ] && kill -0 {} 2>/dev/null; do sleep 0.5; done",
        guard.display(),
        std::process::id()
    );
    let client = launched.try_spawn("gnome-terminal", &["--wait", "--", "bash", "-c", &script])?;
    walk(bus, "terminal", 20, Some(client), || {
        frames_where(connection, is_server)
            .into_iter()
            .find(|frame| {
                !known
                    .iter()
                    .any(|old| old.path() == frame.path() && old.bus_name() == frame.bus_name())
            })
    })
    .map(|_| ())
}

async fn has_label_target(connection: &AsyncConnection, element: &AtspiElement) -> bool {
    first_label_target(connection, element)
        .await
        .is_ok_and(|target| target.is_some())
}

fn blank_labelled_nodes(app: &str, analysis: &Analysis) -> Result<usize, String> {
    let mut found = 0;
    for entry in &analysis.entries {
        if let LabelOutcome::Text(text) = &entry.label {
            found += 1;
            if entry.vocabulary.name != LocatorField::Known(text.clone()) {
                return Err(format!(
                    "{app}: blank-name node read label {text:?} and resolved {:?}",
                    entry.vocabulary.name
                ));
            }
        }
    }
    println!("vocabulary_live {app} blank-name nodes resolved from a LabelledBy target: {found}");
    Ok(found)
}

fn firefox(bus: &SharedBus, connection: &Connection) -> Result<(), String> {
    let program = "/snap/firefox/current/usr/lib/firefox/firefox";
    if !std::path::Path::new(program).exists() {
        return Err(format!(
            "firefox is required and was not found at {program}"
        ));
    }
    let mut launched = Launched::new();
    let root = std::env::var("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    let profile = root.join(nonce("vocabulary-firefox"));
    std::fs::create_dir_all(&profile).map_err(|error| error.to_string())?;
    launched.scratch.push(profile.clone());
    let snap = "/snap/firefox/current";
    let library_path = format!(
        "{snap}/usr/lib/firefox:{snap}/usr/lib/x86_64-linux-gnu:{snap}/gnome-platform/usr/lib/x86_64-linux-gnu"
    );
    let profile_arg = profile.to_string_lossy().into_owned();
    let pid = launched.try_spawn_with_env(
        program,
        &[
            "--no-remote",
            "--profile",
            &profile_arg,
            "--new-window",
            "about:blank",
        ],
        &[
            ("LD_LIBRARY_PATH", library_path),
            ("GTK_A11Y", "atspi".to_owned()),
            ("MOZ_ENABLE_WAYLAND", "0".to_owned()),
        ],
    )?;
    let (_, analysis) = walk(bus, "firefox", 100, Some(pid), || {
        pid_frame(connection, pid)
    })?;
    if blank_labelled_nodes("firefox", &analysis)? == 0 {
        return Err("firefox: no blank-name node resolved from a LabelledBy target".to_owned());
    }
    Ok(())
}

fn calculator(bus: &SharedBus, connection: &Connection) -> Result<(), String> {
    let mut launched = Launched::new();
    let pid = launched.try_spawn("gnome-calculator", &[])?;
    let (_, analysis) = walk(bus, "calculator", 30, Some(pid), || {
        pid_frame(connection, pid)
    })?;
    root_is_window(&analysis)?;
    blank_labelled_nodes("calculator", &analysis)?;
    let enabled = analysis
        .entries
        .iter()
        .filter(|entry| token(&entry.vocabulary.role) == "button" && !is_disabled(entry))
        .count();
    let disabled: Vec<String> = analysis
        .entries
        .iter()
        .filter(|entry| token(&entry.vocabulary.role) == "button" && is_disabled(entry))
        .map(|entry| token(&entry.vocabulary.name))
        .collect();
    if enabled < 20 || disabled != ["Undo"] {
        return Err(format!(
            "calculator: {enabled} enabled buttons, disabled buttons {disabled:?}"
        ));
    }
    let deadline = Deadline::standard().map_err(|error| error.message)?;
    let async_connection = bus.get(deadline).map_err(|error| error.message)?;
    let labelled = analysis.entries.iter().find(|entry| {
        !name_is_blank(&entry.node)
            && zbus::block_on(has_label_target(
                async_connection.inner(),
                &entry.node.element,
            ))
    });
    let entry = labelled.ok_or("calculator: no named node with a LabelledBy target")?;
    let label = zbus::block_on(read_label(async_connection.inner(), &entry.node.element))
        .expect("label read");
    let LabelOutcome::Text(label_text) = &label else {
        return Err(format!("calculator: the label read returned {label:?}"));
    };
    println!("vocabulary_live calculator label read: {label_text:?}");
    let resolved = resolve_vocabulary(&entry.node, &label, false);
    let own = entry
        .node
        .properties
        .name
        .present()
        .cloned()
        .unwrap_or_default();
    if resolved.name != LocatorField::Known(own.clone()) {
        return Err(format!(
            "calculator: labelled node resolved {:?}, not its Name {own:?}",
            resolved.name
        ));
    }
    Ok(())
}

fn qt(bus: &SharedBus, connection: &Connection) -> Result<(), String> {
    let mut launched = Launched::new();
    let pid = live_qt::launch(&mut launched)?;
    let (_, analysis) = walk(bus, "qt", 15, Some(pid), || pid_frame(connection, pid))?;
    blank_labelled_nodes("qt", &analysis)?;
    let button = analysis
        .entries
        .iter()
        .find(|entry| {
            entry.node.properties.name.present().map(String::as_str) == Some(live_qt::BUTTON_LABEL)
        })
        .ok_or("qt: no button named Press")?;
    let identifiers = button.vocabulary.identifiers.identifiers();
    let native = identifiers
        .iter()
        .find(|identifier| identifier.kind == IdentifierKind::AxIdentifier)
        .ok_or_else(|| format!("qt: button identifiers are {identifiers:?}"))?;
    if !native.value.ends_with("okButton") {
        return Err(format!("qt: button id {:?}", native.value));
    }
    let edit = analysis
        .entries
        .iter()
        .find(|entry| entry.node.traits.role.present() == Some(&TEXT))
        .ok_or("qt: no line edit")?;
    let vocabulary = &edit.vocabulary;
    let placeholder = Some("Type name".to_owned());
    if vocabulary.name != LocatorField::Known("Type name".to_owned())
        || vocabulary.descriptor.placeholder != placeholder
        || vocabulary.description != LocatorField::Absent
    {
        return Err(format!("qt: line edit resolved {vocabulary:?}"));
    }
    Ok(())
}

fn vscode_attribute_checks(analysis: &Analysis) -> Result<(), String> {
    let (mut inside_ids, mut outside_ids) = (0, 0);
    let mut problems = Vec::new();
    for entry in &analysis.entries {
        let has_id = entry
            .node
            .attributes
            .present()
            .is_some_and(|attributes| attributes.contains_key("id"));
        let dom = entry
            .vocabulary
            .identifiers
            .identifiers()
            .iter()
            .any(|identifier| identifier.kind == IdentifierKind::AxDomIdentifier);
        let classes = !entry.vocabulary.descriptor.dom_classes.is_empty();
        if entry.in_web {
            inside_ids += usize::from(has_id);
            if has_id && !dom {
                problems.push("a web node with an id has no DOM identifier");
            }
        } else {
            outside_ids += usize::from(has_id);
            if dom || classes {
                problems.push("a node outside a web document produced DOM evidence");
            }
        }
        if entry.node.traits.role.present() == Some(&NOTIFICATION) {
            let xml_role = entry
                .node
                .attributes
                .present()
                .and_then(|attributes| attributes.get("xml-roles"));
            if token(&entry.vocabulary.role) != "alert"
                || xml_role.map(String::as_str) != Some("alert")
            {
                problems.push("a notification node disagrees with its xml-roles");
            }
        }
    }
    println!("vocabulary_live vscode ids inside_web={inside_ids} outside_web={outside_ids}");
    if inside_ids == 0 {
        problems.push("no web node carried an id, so the web rule was not exercised");
    }
    problems.dedup();
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems.join("; "))
    }
}

fn vscode(bus: &SharedBus, connection: &Connection) -> Result<(), String> {
    let program = "code".to_owned();
    let mut launched = Launched::new();
    let data = std::env::temp_dir().join(nonce("vocabulary-vscode"));
    launched.scratch.push(data.clone());
    let data_arg = data.to_string_lossy().into_owned();
    let pid = launched.try_spawn(&program, &vscode_arguments(&data_arg))?;
    let (settled, analysis) = walk(bus, "vscode", 200, Some(pid), || pid_frame(connection, pid))?;
    if !settled.walk.complete {
        return Err("vscode: walk incomplete".to_owned());
    }
    blank_labelled_nodes("vscode", &analysis)?;
    vscode_attribute_checks(&analysis)
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/linux-live-gate.sh"]
fn vocabulary_live_real_apps() {
    let bus = SharedBus::default();
    let connection = bus
        .get(Deadline::standard().expect("a standard deadline builds"))
        .expect("the accessibility bus must be reachable");
    let outcomes = [
        ("files", run_leg(|| files(&bus, &connection))),
        ("terminal", run_leg(|| terminal(&bus, &connection))),
        ("calculator", run_leg(|| calculator(&bus, &connection))),
        ("qt", run_leg(|| qt(&bus, &connection))),
        ("vscode", run_leg(|| vscode(&bus, &connection))),
        ("firefox", run_leg(|| firefox(&bus, &connection))),
    ];
    let failures: Vec<String> = outcomes
        .into_iter()
        .filter_map(|(label, outcome)| outcome.err().map(|error| format!("[{label}] {error}")))
        .collect();
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}
