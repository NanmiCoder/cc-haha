use std::collections::HashMap;

use agent_desktop_core::{AdapterError, Deadline};
use zbus::Connection;
use zbus::zvariant::{OwnedValue, Value};

use super::call;

const MENU_INTERFACE: &str = "com.canonical.dbusmenu";
const MAX_DEPTH: usize = 16;
const MAX_ENTRIES: usize = 2_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LayoutEntry {
    pub(crate) id: i32,
    pub(crate) label: String,
    pub(crate) enabled: bool,
    pub(crate) separator: bool,
    pub(crate) submenu: bool,
    pub(crate) checked: Option<bool>,
    pub(crate) children: Vec<LayoutEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Layout {
    pub(crate) root: LayoutEntry,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Prop {
    Text(String),
    Flag(bool),
    Number(i32),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RawEntry {
    pub(crate) id: i32,
    pub(crate) props: HashMap<String, Prop>,
    pub(crate) children: Vec<RawEntry>,
}

/// A dbusmenu label marks its mnemonic with an underscore, and writes a
/// literal underscore as two.
pub(crate) fn strip_mnemonic(label: &str) -> String {
    let mut out = String::with_capacity(label.len());
    let mut chars = label.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '_' {
            out.push(ch);
        } else if chars.peek() == Some(&'_') {
            chars.next();
            out.push('_');
        }
    }
    out
}

fn text(entry: &RawEntry, key: &str) -> Option<String> {
    match entry.props.get(key) {
        Some(Prop::Text(value)) => Some(value.clone()),
        _ => None,
    }
}

fn flag(entry: &RawEntry, key: &str, default: bool) -> bool {
    match entry.props.get(key) {
        Some(Prop::Flag(value)) => *value,
        _ => default,
    }
}

fn entry_of(raw: &RawEntry) -> LayoutEntry {
    let children: Vec<LayoutEntry> = raw
        .children
        .iter()
        .filter(|child| flag(child, "visible", true))
        .map(entry_of)
        .collect();
    let checkable = matches!(
        text(raw, "toggle-type").as_deref(),
        Some("checkmark" | "radio")
    );
    let state = match raw.props.get("toggle-state") {
        Some(Prop::Number(value)) => *value,
        _ => 0,
    };
    LayoutEntry {
        id: raw.id,
        label: strip_mnemonic(&text(raw, "label").unwrap_or_default()),
        enabled: flag(raw, "enabled", true),
        separator: text(raw, "type").as_deref() == Some("separator"),
        submenu: text(raw, "children-display").as_deref() == Some("submenu")
            || !children.is_empty(),
        checked: checkable.then_some(state == 1),
        children,
    }
}

pub(crate) fn parse(root: &RawEntry) -> Layout {
    Layout {
        root: entry_of(root),
    }
}

fn peel<'a, 'b>(value: &'a Value<'b>) -> &'a Value<'b> {
    match value {
        Value::Value(inner) => peel(inner),
        other => other,
    }
}

fn prop_of(value: &Value<'_>) -> Option<Prop> {
    match peel(value) {
        Value::Str(text) => Some(Prop::Text(text.as_str().to_owned())),
        Value::Bool(flag) => Some(Prop::Flag(*flag)),
        Value::I32(number) => Some(Prop::Number(*number)),
        Value::U32(number) => i32::try_from(*number).ok().map(Prop::Number),
        _ => None,
    }
}

fn raw_of_structure(value: &Value<'_>, depth: usize, budget: &mut usize) -> Option<RawEntry> {
    if depth > MAX_DEPTH || *budget == 0 {
        return None;
    }
    *budget -= 1;
    let Value::Structure(structure) = peel(value) else {
        return None;
    };
    let [id, props, children] = structure.fields() else {
        return None;
    };
    let (Value::I32(id), Value::Dict(dict), Value::Array(children)) =
        (peel(id), peel(props), peel(children))
    else {
        return None;
    };
    let mut parsed = HashMap::new();
    for (key, value) in dict.iter() {
        if let (Value::Str(key), Some(prop)) = (key, prop_of(value)) {
            parsed.insert(key.as_str().to_owned(), prop);
        }
    }
    let mut nested = Vec::new();
    for child in children.iter() {
        nested.push(raw_of_structure(child, depth + 1, budget)?);
    }
    Some(RawEntry {
        id: *id,
        props: parsed,
        children: nested,
    })
}

pub(crate) fn raw_from_parts(
    id: i32,
    props: &HashMap<String, OwnedValue>,
    children: &[OwnedValue],
) -> Option<RawEntry> {
    let mut budget = MAX_ENTRIES;
    let mut parsed = HashMap::new();
    for (key, value) in props {
        if let Some(prop) = prop_of(value) {
            parsed.insert(key.clone(), prop);
        }
    }
    let mut nested = Vec::new();
    for child in children {
        nested.push(raw_of_structure(child, 1, &mut budget)?);
    }
    Some(RawEntry {
        id,
        props: parsed,
        children: nested,
    })
}

type Body = (u32, (i32, HashMap<String, OwnedValue>, Vec<OwnedValue>));

pub(crate) fn read(
    connection: &Connection,
    owner: &str,
    menu_path: &str,
    deadline: Deadline,
) -> Result<Layout, AdapterError> {
    let reply = call::call(
        connection,
        call::Endpoint {
            destination: owner,
            path: menu_path,
            interface: MENU_INTERFACE,
        },
        "GetLayout",
        &(0i32, -1i32, Vec::<String>::new()),
        deadline,
    )?;
    let (_revision, (id, props, children)): Body = reply
        .body()
        .deserialize()
        .map_err(|error| call::fault(&error))?;
    let raw = raw_from_parts(id, &props, &children).ok_or_else(|| {
        AdapterError::internal("The tray item's menu layout could not be read")
            .with_platform_detail("dbusmenu GetLayout returned a tree that did not parse")
    })?;
    Ok(parse(&raw))
}

#[cfg(test)]
#[path = "menu_layout_tests.rs"]
mod tests;
