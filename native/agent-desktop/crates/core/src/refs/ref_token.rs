use crate::{AccessibilityNode, AppError, refs::validate_snapshot_id};

pub(crate) fn qualify_ref_id(snapshot_id: &str, local_ref: &str) -> String {
    format!(
        "@{snapshot_id}:{}",
        local_ref.strip_prefix('@').unwrap_or(local_ref)
    )
}

pub(crate) fn qualify_tree_refs(tree: &mut AccessibilityNode, snapshot_id: &str) {
    if let Some(local_ref) = tree.ref_id.as_deref() {
        tree.ref_id = Some(qualify_ref_id(snapshot_id, local_ref));
    }
    for child in &mut tree.children {
        qualify_tree_refs(child, snapshot_id);
    }
}

pub(crate) fn resolve_ref_target(ref_id: &str) -> Result<(String, String), AppError> {
    let Some(without_at) = ref_id.strip_prefix('@') else {
        return Err(invalid_ref(ref_id));
    };
    let Some((snapshot_id, element_number)) = without_at.rsplit_once(":e") else {
        return Err(invalid_ref(ref_id));
    };
    validate_snapshot_id(snapshot_id)?;
    let local_ref = format!("@e{element_number}");
    if !is_local_ref(&local_ref) {
        return Err(invalid_ref(ref_id));
    }
    Ok((snapshot_id.to_string(), local_ref))
}

#[cfg(test)]
pub(crate) fn qualify_for_test(ref_id: &str, snapshot_id: Option<&str>) -> String {
    match snapshot_id {
        Some(snapshot_id) if is_local_ref(ref_id) => qualify_ref_id(snapshot_id, ref_id),
        _ => ref_id.to_string(),
    }
}

pub(crate) fn validate_ref_token(ref_id: &str) -> Result<(), AppError> {
    resolve_ref_target(ref_id).map(|_| ())
}

fn is_local_ref(ref_id: &str) -> bool {
    ref_id.strip_prefix("@e").is_some_and(|digits| {
        !digits.is_empty()
            && digits.len() <= 10
            && digits.chars().all(|character| character.is_ascii_digit())
            && digits.parse::<u32>().is_ok_and(|number| number > 0)
    })
}

fn invalid_ref(ref_id: &str) -> AppError {
    AppError::invalid_input_with_suggestion(
        format!("Invalid ref_id '{ref_id}': expected @<snapshot_id>:e<N>"),
        "Use the snapshot-qualified ref that snapshot prints, for example @s8f3k2p9:e1. A bare @eN ref is not accepted.",
    )
}

#[cfg(test)]
#[path = "ref_token_tests.rs"]
mod tests;
