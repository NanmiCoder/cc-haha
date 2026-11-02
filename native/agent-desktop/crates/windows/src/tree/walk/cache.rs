use agent_desktop_core::LocatorField;

use crate::tree::properties::PropertyOutcome;

/// The module every client-side proxy provider is served from.
///
/// A tree whose providers all name this library is served **inside the client
/// process**, so an uncached property read costs no cross-process RPC and a
/// cache request is pure setup.
const CLIENT_SIDE_PROVIDER_MODULE: &str = "uiautomationcore.dll";

/// Whether a subtree's reads are worth batching.
///
/// The decision is by provider class, never by node count. A node-count
/// threshold is not implementable here: the cache request must be built
/// *before* the walk, and the count is known only *after* it, so the arm would
/// have no input at decision time. A6-2 also measured the only available
/// candidate threshold on the managed stack, where A2-4 measured the same
/// window as 3 nodes against 26 on the COM stack the adapter uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CachePolicy {
    /// Prefetch the walk property set with each element.
    Batch,
    /// Read live. A6-2 measured unconditional batching against an in-process
    /// client-side provider at 0.5763x overall and 0.436x on the find phase.
    Skip,
}

impl CachePolicy {
    pub fn batches(self) -> bool {
        matches!(self, CachePolicy::Batch)
    }
}

/// Chooses the policy from a root-level `ProviderDescription` read and the
/// target element's own process id.
///
/// A description that cannot be read leaves the policy at `Batch`: a wrong
/// `Skip` costs a cross-process round trip per property on exactly the trees
/// where batching pays, while a wrong `Batch` costs request setup on a tree
/// whose reads were already local.
pub fn policy_for(provider_description: &PropertyOutcome, target_pid: u32) -> CachePolicy {
    match provider_description.text() {
        LocatorField::Known(description)
            if served_only_by_client_side_providers(&description, target_pid) =>
        {
            CachePolicy::Skip
        }
        _ => CachePolicy::Batch,
    }
}

/// Reports whether every module named in a provider description is the
/// client-side proxy library, and no provider layer is delegated into the
/// target's own process.
///
/// The module-name check alone is not sufficient: a WinForms/MSAA-bridged
/// control commonly reports a provider description whose every named module
/// is `uiautomationcore.dll` (`Main:Nested [pid:<target>,... MSAA Proxy
/// (unmanaged:UIAutomationCore.dll)]`) with that "Main" layer's `pid:`
/// naming the *target application's own process* - the standard library
/// name is loaded and running there, not in this client, so every read
/// still marshals across the same process boundary a foreign module name
/// would signal. `A24-17` measured a 176-node WinForms broad-search walk at
/// ~840ms live against ~310ms forced-batched on exactly this shape, which is
/// why the target's own pid is now checked, not just the module names.
fn served_only_by_client_side_providers(description: &str, target_pid: u32) -> bool {
    if names_the_process(description, target_pid) {
        return false;
    }
    let lowered = description.to_ascii_lowercase();
    let mut named_a_module = false;
    for token in lowered.split(|character: char| {
        !(character.is_ascii_alphanumeric()
            || character == '.'
            || character == '_'
            || character == '-')
    }) {
        if !(token.ends_with(".dll") || token.ends_with(".exe")) {
            continue;
        }
        named_a_module = true;
        if token != CLIENT_SIDE_PROVIDER_MODULE {
            return false;
        }
    }
    named_a_module
}

/// Whether a `pid:<n>` marker anywhere in the description names `target_pid`
/// exactly - not merely as a numeric prefix (`pid:6252` must not match a
/// description naming `pid:62520`).
fn names_the_process(description: &str, target_pid: u32) -> bool {
    let lowered = description.to_ascii_lowercase();
    let mut rest = lowered.as_str();
    while let Some(index) = rest.find("pid:") {
        let after = &rest[index + "pid:".len()..];
        let digits: String = after.chars().take_while(char::is_ascii_digit).collect();
        if digits.parse::<u32>() == Ok(target_pid) {
            return true;
        }
        rest = after;
    }
    false
}

#[cfg(target_os = "windows")]
mod imp {
    use super::{CachePolicy, policy_for};
    use crate::tree::automation::{failure_of, uia_failure_error};
    use crate::tree::element::UIAElement;
    use crate::tree::properties::property_ids::{TreeProperty, uia_property};
    use crate::tree::properties::read_one;
    use agent_desktop_core::AdapterError;
    use uiautomation::UIAutomation;
    use uiautomation::core::UICacheRequest;
    use uiautomation::types::{ElementMode, TreeScope};

    /// Builds the request the walk uses.
    ///
    /// `ElementMode::Full` always: with `AutomationElementMode_None` a client
    /// has no access to uncached properties or control patterns and cannot
    /// invoke an action, which would break every command that acts on the
    /// element afterward.
    ///
    /// The scope includes `TreeScope::Element`, because the scope is relative
    /// to the element the call returns and omitting `Element` silently fails
    /// to cache that element's own properties. `TreeScope` is a plain enum
    /// with no bitwise operators, so a combined scope has to come from a
    /// pre-combined variant or `try_from`; the walk needs only `Element`,
    /// since it retrieves each node itself.
    ///
    /// Only the properties the walk will read are requested, `IsPassword`
    /// among them, so the secure-field gate has its input in the same batch
    /// as the properties it gates and costs no second round trip.
    pub fn build_walk_cache_request(client: &UIAutomation) -> Result<UICacheRequest, AdapterError> {
        let request = client
            .create_cache_request()
            .map_err(|error| uia_failure_error(failure_of(&error), "create a cache request"))?;
        request
            .set_element_mode(ElementMode::Full)
            .map_err(|error| uia_failure_error(failure_of(&error), "set the cache element mode"))?;
        request
            .set_tree_scope(TreeScope::Element)
            .map_err(|error| uia_failure_error(failure_of(&error), "set the cache tree scope"))?;
        for property in TreeProperty::WALK_SET {
            request
                .add_property(uia_property(property))
                .map_err(|error| {
                    uia_failure_error(failure_of(&error), "add a property to the cache request")
                })?;
        }
        Ok(request)
    }

    /// Reads the root's `ProviderDescription` and its own process id, and
    /// picks the policy.
    ///
    /// The description itself never leaves this function. It names modules,
    /// process ids and provider ids, and `ref_action.rs` clones adapter error
    /// text into session trace segments, so it must not reach an error or a
    /// log line. A root whose own process id cannot be read falls back to
    /// `Batch` for the same reason an unreadable description does: nothing
    /// here can rule out a provider delegated into that process, so guessing
    /// `Skip` risks the exact per-property RPC cost this policy exists to
    /// avoid.
    pub fn policy_for_root(root: &UIAElement) -> CachePolicy {
        match root.0.get_process_id() {
            Ok(target_pid) => policy_for(
                &read_one(root, TreeProperty::ProviderDescription),
                target_pid,
            ),
            Err(_) => CachePolicy::Batch,
        }
    }
}

#[cfg(target_os = "windows")]
pub use imp::{build_walk_cache_request, policy_for_root};

#[cfg(test)]
#[path = "cache_tests.rs"]
mod tests;
