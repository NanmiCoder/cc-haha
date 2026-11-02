use crate::tree::AXElement;

pub(crate) const MAX_LABEL_ELEMENTS: usize = 5;

pub(crate) struct NameEvidenceSinks<'a> {
    pub(crate) stats: &'a mut agent_desktop_core::LocatorStats,
    pub(crate) usage: &'a mut crate::tree::observation_usage::ObservationUsage,
}

pub(crate) fn complete_name_evidence_with_deadline(
    attrs: &crate::tree::NodeAttrs,
    role: &str,
    children: &[AXElement],
    deadline: std::time::Instant,
    mut sinks: NameEvidenceSinks<'_>,
) -> Result<(agent_desktop_core::NameEvidence, bool), agent_desktop_core::AdapterError> {
    let mut evidence = attrs.name_evidence.clone();
    if !should_read_child_label(role, &evidence) {
        return Ok((evidence, true));
    }
    let (label, complete) = label_from_children(children, deadline, &mut sinks)?;
    evidence.child_label = label;
    Ok((evidence, complete))
}

pub(crate) fn should_read_child_label(
    role: &str,
    evidence: &agent_desktop_core::NameEvidence,
) -> bool {
    names_from_child_content(role) && !has_name_without_child_content(evidence)
}

fn names_from_child_content(role: &str) -> bool {
    agent_desktop_core::tree::roles::INTERACTIVE_ROLES.contains(&role) || role == "row"
}

fn has_name_without_child_content(evidence: &agent_desktop_core::NameEvidence) -> bool {
    [
        evidence.explicit_label.as_deref(),
        evidence.labelled_by_text.as_deref(),
        evidence.native_title.as_deref(),
        evidence.static_value.as_deref(),
        evidence.description.as_deref(),
    ]
    .into_iter()
    .any(|value| value.is_some_and(|value| !value.trim().is_empty()))
}

#[cfg(target_os = "macos")]
fn label_from_children(
    children: &[AXElement],
    deadline: std::time::Instant,
    sinks: &mut NameEvidenceSinks<'_>,
) -> Result<(Option<String>, bool), agent_desktop_core::AdapterError> {
    let mut labels = Vec::new();
    note_label_limit(children.len(), sinks.stats);
    let capped = children.len() > MAX_LABEL_ELEMENTS;
    let mut reads_complete = true;
    for child in children.iter().take(MAX_LABEL_ELEMENTS) {
        let (role, role_complete) = timed_string(child, "AXRole", deadline, sinks)?;
        reads_complete &= role_complete;
        match role.as_deref() {
            Some("AXStaticText") => {
                let (subrole, subrole_complete) =
                    timed_string(child, "AXSubrole", deadline, sinks)?;
                reads_complete &= subrole_complete;
                if subrole.as_deref() != Some("AXSecureTextField") {
                    reads_complete &= push_static_text(&mut labels, child, deadline, sinks)?;
                }
            }
            Some("AXCell") | Some("AXGroup") => {
                let (title, title_complete) = timed_string(child, "AXTitle", deadline, sinks)?;
                reads_complete &= title_complete;
                if let Some(title) = title {
                    labels.push(title);
                }
                let grandchildren = crate::tree::query::child_read::read_children(
                    child,
                    role.as_deref(),
                    crate::tree::query::child_read_budget::ChildReadBudget::inferred(
                        MAX_LABEL_ELEMENTS,
                    ),
                    deadline,
                );
                record_child_read(&grandchildren, sinks.stats)?;
                reads_complete &= grandchildren.complete
                    && !grandchildren.truncated()
                    && !grandchildren.status.invalid_element;
                for grandchild in grandchildren.elements {
                    let (role, role_complete) =
                        timed_string(&grandchild, "AXRole", deadline, sinks)?;
                    reads_complete &= role_complete;
                    if role.as_deref() == Some("AXStaticText") {
                        let (subrole, subrole_complete) =
                            timed_string(&grandchild, "AXSubrole", deadline, sinks)?;
                        reads_complete &= subrole_complete;
                        if subrole.as_deref() != Some("AXSecureTextField") {
                            reads_complete &=
                                push_static_text(&mut labels, &grandchild, deadline, sinks)?;
                        }
                    }
                }
            }
            _ => {}
        }
    }
    let (label, join_complete) = join_unique_labels(labels, sinks.usage);
    let complete =
        label_read_completeness(reads_complete && join_complete, capped, label.is_some());
    Ok((label, complete))
}

fn label_read_completeness(reads_complete: bool, capped: bool, label_found: bool) -> bool {
    reads_complete && (!capped || !label_found)
}

#[cfg(not(target_os = "macos"))]
fn label_from_children(
    _children: &[AXElement],
    _deadline: std::time::Instant,
    _sinks: &mut NameEvidenceSinks<'_>,
) -> Result<(Option<String>, bool), agent_desktop_core::AdapterError> {
    Ok((None, true))
}

#[cfg(target_os = "macos")]
fn timed_string(
    element: &AXElement,
    attribute: &str,
    deadline: std::time::Instant,
    sinks: &mut NameEvidenceSinks<'_>,
) -> Result<(Option<String>, bool), agent_desktop_core::AdapterError> {
    sinks.stats.semantic_reads.child_label_reads += 1;
    let read = crate::tree::properties::attributes::copy_string_attr_bounded_result(
        element,
        attribute,
        deadline,
        sinks.usage,
    );
    match read {
        Ok(value) => Ok(complete_text(value, sinks.stats)),
        Err(error) => degrade_transient_read(error, "child_label.text", sinks.stats),
    }
}

#[cfg(target_os = "macos")]
fn push_static_text(
    labels: &mut Vec<String>,
    element: &AXElement,
    deadline: std::time::Instant,
    sinks: &mut NameEvidenceSinks<'_>,
) -> Result<bool, agent_desktop_core::AdapterError> {
    sinks.stats.semantic_reads.child_label_reads += 1;
    let read = crate::tree::properties::attributes::copy_value_typed_bounded_result(
        element,
        deadline,
        sinks.usage,
    );
    let value = match read {
        Ok(value) => value,
        Err(error) => {
            return degrade_transient_read(error, "child_label.value", sinks.stats)
                .map(|(_, complete)| complete);
        }
    };
    let (mut text, mut complete) = complete_text(value, sinks.stats);
    if text.is_none() && complete {
        let (title, title_complete) = timed_string(element, "AXTitle", deadline, sinks)?;
        text = title;
        complete &= title_complete;
    }
    if let Some(text) = text {
        labels.push(text);
    }
    Ok(complete)
}

#[cfg(target_os = "macos")]
fn degrade_transient_read(
    error: i32,
    phase: &str,
    stats: &mut agent_desktop_core::LocatorStats,
) -> Result<(Option<String>, bool), agent_desktop_core::AdapterError> {
    if error == accessibility_sys::kAXErrorAPIDisabled {
        return Err(crate::tree::query::read_error::semantic_read(error, phase));
    }
    stats.reads.health.cannot_complete +=
        u64::from(error == accessibility_sys::kAXErrorCannotComplete);
    stats.reads.health.native_read_failures += u64::from(
        error != accessibility_sys::kAXErrorCannotComplete
            && error != accessibility_sys::kAXErrorInvalidUIElement,
    );
    Ok((None, false))
}

fn complete_text(
    value: Option<crate::tree::properties::bounded_string::BoundedString>,
    stats: &mut agent_desktop_core::LocatorStats,
) -> (Option<String>, bool) {
    match value {
        Some(value) if value.complete => (Some(value.value), true),
        Some(_) => {
            stats.traversal.limits.text_hits += 1;
            (None, false)
        }
        None => (None, true),
    }
}

#[cfg(target_os = "macos")]
fn record_child_read(
    read: &crate::tree::query::child_read::ChildRead,
    stats: &mut agent_desktop_core::LocatorStats,
) -> Result<(), agent_desktop_core::AdapterError> {
    stats.reads.counts.child_reads += read.status.attempts;
    stats.reads.health.cannot_complete += read.status.health.cannot_complete;
    stats.reads.health.native_read_failures += read.status.health.native_read_failures;
    stats.reads.health.deadline_exhausted += read.status.health.deadline_exhausted;
    stats.traversal.limits.child_count_changes += u64::from(read.status.count_changed);
    stats.traversal.limits.child_label_hits += u64::from(read.truncated());
    stats.traversal.limits.child_hits += u64::from(read.status.cursor_stalled);
    if read.status.api_disabled {
        return Err(crate::tree::query::read_error::semantic_read(
            accessibility_sys::kAXErrorAPIDisabled,
            "child_label.children",
        ));
    }
    Ok(())
}

fn note_label_limit(child_count: usize, stats: &mut agent_desktop_core::LocatorStats) {
    stats.traversal.limits.child_label_hits += u64::from(child_count > MAX_LABEL_ELEMENTS);
}

fn join_unique_labels(
    labels: impl IntoIterator<Item = String>,
    usage: &mut crate::tree::observation_usage::ObservationUsage,
) -> (Option<String>, bool) {
    let mut joined = String::new();
    let mut seen = Vec::new();
    let capacity = usage.string_capacity();
    let mut complete = true;
    for label in labels {
        let normalized = label.split_whitespace().collect::<Vec<_>>().join(" ");
        if normalized.is_empty() || seen.iter().any(|value| value == &normalized) {
            continue;
        }
        let separator = usize::from(!joined.is_empty());
        let remaining = capacity.saturating_sub(joined.len().saturating_add(separator));
        if remaining == 0 {
            complete = false;
            break;
        }
        if separator == 1 {
            joined.push(' ');
        }
        let mut end = remaining.min(normalized.len());
        while !normalized.is_char_boundary(end) {
            end = end.saturating_sub(1);
        }
        joined.push_str(&normalized[..end]);
        complete &= end == normalized.len();
        seen.push(normalized);
        if !complete {
            break;
        }
    }
    usage.claim_text(joined.len());
    ((!joined.is_empty()).then_some(joined), complete)
}

#[cfg(test)]
#[path = "child_labels_tests.rs"]
mod tests;
