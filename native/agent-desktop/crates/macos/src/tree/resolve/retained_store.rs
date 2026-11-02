use crate::tree::AXElement;
use crate::tree::resolve::retained::element_hash;
use agent_desktop_core::AdapterError;
use std::collections::{HashMap, HashSet};

const MAX_OBJECTS: usize = 65_536;

pub(in crate::tree) struct RetainedStore {
    generation: String,
    buckets: HashMap<u64, Vec<(String, AXElement)>>,
    count: usize,
    tokens: HashSet<String>,
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    fn app(pid: i32) -> AXElement {
        AXElement(unsafe { accessibility_sys::AXUIElementCreateApplication(pid) })
    }

    #[test]
    fn a_hash_bucket_collision_cannot_alias_another_native_object() {
        let target = app(i32::try_from(std::process::id()).unwrap());
        let mut store = RetainedStore::new("host".into());
        store
            .buckets
            .insert(element_hash(&target), vec![("host:1".into(), app(1))]);
        store.count = 1;
        store.tokens.insert("host:1".into());
        assert!(store.lookup(&target).is_none());
        assert_eq!(store.capture(&target).unwrap(), "host:2");
        assert_eq!(store.lookup(&target), Some("host:2"));
    }

    #[test]
    fn capacity_refuses_new_objects_without_evicting_existing_identity() {
        let target = app(i32::try_from(std::process::id()).unwrap());
        let mut store = RetainedStore::new("host".into());
        let token = store.capture(&target).unwrap();
        store
            .tokens
            .extend((2..=MAX_OBJECTS).map(|index| format!("host:{index}")));
        assert_eq!(store.capture(&target).unwrap(), token);
        assert!(store.capture(&app(1)).is_err());
        assert_eq!(store.tokens.len(), MAX_OBJECTS);
        assert_eq!(store.lookup(&target), Some(token.as_str()));
    }

    #[test]
    fn pruning_releases_unsaved_objects_without_reusing_their_tokens() {
        let target = app(i32::try_from(std::process::id()).unwrap());
        let other = app(1);
        let mut store = RetainedStore::new("host".into());
        let keep = store.capture(&target).unwrap();
        let discard = store.capture(&other).unwrap();
        store.retain(&HashSet::from([keep.clone()]));
        assert!(store.contains_token(&keep));
        assert!(!store.contains_token(&discard));
        assert!(store.lookup(&other).is_none());
        let fresh = store.capture(&other).unwrap();
        assert_ne!(fresh, discard);
        assert_eq!(store.capture_count(), 3);
        assert_eq!(store.tokens.len(), 2);
    }
}

impl RetainedStore {
    pub(in crate::tree) fn new(generation: String) -> Self {
        Self {
            generation,
            buckets: HashMap::new(),
            count: 0,
            tokens: HashSet::new(),
        }
    }

    pub(in crate::tree) fn lookup(&self, element: &AXElement) -> Option<&str> {
        self.buckets
            .get(&element_hash(element))?
            .iter()
            .find(|(_, saved)| crate::tree::same_element(saved, element))
            .map(|(token, _)| token.as_str())
    }

    pub(in crate::tree) fn capture(&mut self, element: &AXElement) -> Result<String, AdapterError> {
        if element.0.is_null() {
            return Err(AdapterError::stale_ref_because(
                "Cannot retain a null native object",
            ));
        }
        if let Some(token) = self.lookup(element) {
            return Ok(token.to_owned());
        }
        if self.tokens.len() >= MAX_OBJECTS {
            return Err(AdapterError::internal("Retained object capacity exhausted")
                .with_suggestion("End this session and take a fresh snapshot in a new session"));
        }
        self.count = self
            .count
            .checked_add(1)
            .ok_or_else(|| AdapterError::internal("Retained token space exhausted"))?;
        let token = format!("{}:{}", self.generation, self.count);
        self.tokens.insert(token.clone());
        self.buckets
            .entry(element_hash(element))
            .or_default()
            .push((token.clone(), element.clone()));
        Ok(token)
    }

    pub(in crate::tree) fn contains_token(&self, token: &str) -> bool {
        self.tokens.contains(token)
    }

    pub(in crate::tree) fn capture_count(&self) -> usize {
        self.count
    }

    pub(in crate::tree) fn retain(&mut self, live: &HashSet<String>) {
        self.buckets.retain(|_, bucket| {
            bucket.retain(|(token, _)| live.contains(token));
            !bucket.is_empty()
        });
        self.tokens.retain(|token| live.contains(token));
    }
}
