use super::*;
use agent_desktop_core::ErrorCode;
use std::ffi::CString;

fn test_ref_entry() -> AdRefEntry {
    let mut entry: AdRefEntry = unsafe { std::mem::zeroed() };
    entry.process.pid = 42;
    entry
}

fn decode(entry: AdRefEntry) -> Result<CoreRefEntry, AdapterError> {
    let exact = AdExactRefEntry {
        version: crate::types::exact_ref_entry::AD_EXACT_REF_ENTRY_VERSION,
        size: crate::types::exact_ref_entry::AD_EXACT_REF_ENTRY_SIZE as u32,
        entry,
        process_instance: c"42:100".as_ptr(),
        identifier_kind: AdIdentifierKind::AxIdentifier as i32,
    };
    unsafe { core_ref_entry_from_exact(&exact) }
}

#[test]
fn exact_ref_geometry_accepts_only_the_platform_native_frame() {
    let (native_space, other_space, expected_space) = if cfg!(target_os = "linux") {
        (
            crate::AD_BOUNDS_SPACE_WINDOW,
            crate::AD_BOUNDS_SPACE_SCREEN,
            agent_desktop_core::BoundsSpace::Window,
        )
    } else {
        (
            crate::AD_BOUNDS_SPACE_SCREEN,
            crate::AD_BOUNDS_SPACE_WINDOW,
            agent_desktop_core::BoundsSpace::Screen,
        )
    };
    for (space, has_bounds, has_hash, expected) in [
        (native_space, true, false, Some(expected_space)),
        (native_space, false, false, Some(expected_space)),
        (native_space, false, true, Some(expected_space)),
        (other_space, true, false, None),
        (other_space, false, true, None),
        (crate::AD_BOUNDS_SPACE_UNKNOWN, true, false, None),
        (crate::AD_BOUNDS_SPACE_UNKNOWN, false, true, None),
        (99, true, false, None),
    ] {
        let mut entry = test_ref_entry();
        entry.identity.role = c"button".as_ptr();
        entry.identity.name = c"target".as_ptr();
        entry.geometry.bounds = crate::AdRect {
            x: 12.0,
            y: 24.0,
            width: 80.0,
            height: 30.0,
        };
        entry.geometry.has_bounds = has_bounds;
        entry.geometry.has_bounds_hash = has_hash;
        entry.geometry.bounds_hash = 7;
        entry.geometry.bounds_space = space;
        match expected {
            Some(expected) => {
                let decoded = decode(entry).unwrap();
                assert_eq!(decoded.geometry.bounds_space, Some(expected));
            }
            None => assert_eq!(decode(entry).unwrap_err().code, ErrorCode::InvalidArgs),
        }
    }
}

#[test]
fn ffi_ref_entry_preserves_description_identity() {
    let role = CString::new("button").unwrap();
    let name = CString::new("Primary").unwrap();
    let value = CString::new("On").unwrap();
    let description = CString::new("Insert Shape").unwrap();
    let state = CString::new("focused").unwrap();
    let action = CString::new("Click").unwrap();
    let source_app = CString::new("Finder").unwrap();
    let window_id = CString::new("w-1").unwrap();
    let window_title = CString::new("Documents").unwrap();
    let root_ref = CString::new("@e1").unwrap();
    let states = [state.as_ptr()];
    let actions = [action.as_ptr()];
    let path = [1_u32, 2, 3];
    let mut entry = test_ref_entry();
    entry.process.pid = 42;
    entry.identity.role = role.as_ptr();
    entry.identity.name = name.as_ptr();
    entry.identity.value = value.as_ptr();
    entry.identity.description = description.as_ptr();
    entry.capabilities.states.items = states.as_ptr();
    entry.capabilities.states.count = states.len();
    entry.capabilities.available_actions.items = actions.as_ptr();
    entry.capabilities.available_actions.count = actions.len();
    entry.geometry.bounds = crate::types::AdRect {
        x: 1.0,
        y: 2.0,
        width: 3.0,
        height: 4.0,
    };
    entry.geometry.has_bounds = true;
    entry.geometry.bounds_space = if cfg!(target_os = "linux") {
        crate::AD_BOUNDS_SPACE_WINDOW
    } else {
        crate::AD_BOUNDS_SPACE_SCREEN
    };
    entry.geometry.bounds_hash = Rect {
        x: 1.0,
        y: 2.0,
        width: 3.0,
        height: 4.0,
    }
    .bounds_hash()
    .unwrap();
    entry.geometry.has_bounds_hash = true;
    entry.source.app = source_app.as_ptr();
    entry.source.window_id = window_id.as_ptr();
    entry.source.window_title = window_title.as_ptr();
    entry.source.window_bounds_hash = 777;
    entry.source.has_window_bounds_hash = true;
    entry.source.surface = 5;
    entry.scope.root_ref = root_ref.as_ptr();
    entry.scope.path_is_absolute = true;
    entry.scope.path = path.as_ptr();
    entry.scope.path_count = path.len();

    let core_entry = decode(entry).unwrap();

    assert_eq!(core_entry.process.pid, 42);
    assert_eq!(core_entry.identity.role, "button");
    assert_eq!(core_entry.identity.name.as_deref(), Some("Primary"));
    assert_eq!(core_entry.identity.value.as_deref(), Some("On"));
    assert_eq!(
        core_entry.identity.description.as_deref(),
        Some("Insert Shape")
    );
    assert_eq!(core_entry.capabilities.states, ["focused"]);
    assert_eq!(core_entry.capabilities.available_actions, ["Click"]);
    assert_eq!(core_entry.geometry.bounds.unwrap().width, 3.0);
    assert_eq!(
        core_entry.geometry.bounds_space,
        Some(if cfg!(target_os = "linux") {
            agent_desktop_core::BoundsSpace::Window
        } else {
            agent_desktop_core::BoundsSpace::Screen
        })
    );
    assert_eq!(
        core_entry.geometry.bounds_hash,
        core_entry.geometry.bounds.unwrap().bounds_hash()
    );
    assert_eq!(core_entry.source.source_app.as_deref(), Some("Finder"));
    assert_eq!(core_entry.source.source_window_id.as_deref(), Some("w-1"));
    assert_eq!(
        core_entry.source.source_window_title.as_deref(),
        Some("Documents")
    );
    assert_eq!(core_entry.source.source_window_bounds_hash, Some(777));
    assert_eq!(
        core_entry.source.source_surface,
        agent_desktop_core::SnapshotSurface::Popover
    );
    assert_eq!(core_entry.scope.root_ref.as_deref(), Some("@e1"));
    assert!(core_entry.scope.path_is_absolute);
    assert_eq!(core_entry.scope.path.as_slice(), &[1, 2, 3]);
}

#[test]
fn ffi_ref_entry_derives_bounds_hash_when_caller_omits_it() {
    let role = CString::new("button").unwrap();
    let mut entry = test_ref_entry();
    entry.identity.role = role.as_ptr();
    entry.identity.name = c"target".as_ptr();
    entry.geometry.bounds = crate::types::AdRect {
        x: 1.0,
        y: 2.0,
        width: 3.0,
        height: 4.0,
    };
    entry.geometry.has_bounds = true;
    entry.geometry.bounds_space = if cfg!(target_os = "linux") {
        crate::AD_BOUNDS_SPACE_WINDOW
    } else {
        crate::AD_BOUNDS_SPACE_SCREEN
    };

    let core_entry = decode(entry).unwrap();

    assert_eq!(
        core_entry.geometry.bounds_hash,
        core_entry
            .geometry
            .bounds
            .and_then(|bounds| bounds.bounds_hash())
    );
}

#[test]
fn ffi_ref_entry_rejects_invalid_description_identity() {
    let role = CString::new("button").unwrap();
    let bad_description: [u8; 2] = [0xC3, 0x00];
    let mut entry = test_ref_entry();
    entry.process.pid = 42;
    entry.identity.role = role.as_ptr();
    entry.identity.description = bad_description.as_ptr().cast();

    let err = decode(entry).unwrap_err();

    assert_eq!(err.code, ErrorCode::InvalidArgs);
    assert_eq!(err.message, "identity.description is not valid UTF-8");
}

#[test]
fn ffi_ref_entry_rejects_invalid_array_pointer() {
    let role = CString::new("button").unwrap();
    let mut entry = test_ref_entry();
    entry.identity.role = role.as_ptr();
    entry.capabilities.states.count = 1;

    let err = decode(entry).unwrap_err();

    assert_eq!(err.code, ErrorCode::InvalidArgs);
    assert_eq!(err.message, "states count is nonzero but pointer is null");
}

#[test]
fn ffi_ref_entry_rejects_unknown_surface() {
    let role = CString::new("button").unwrap();
    let mut entry = test_ref_entry();
    entry.identity.role = role.as_ptr();
    entry.source.surface = 99;

    let err = decode(entry).unwrap_err();

    assert_eq!(err.code, ErrorCode::InvalidArgs);
    assert_eq!(err.message, "invalid source.surface discriminant");
}

fn string_array_of(len: usize) -> (Vec<CString>, Vec<*const std::os::raw::c_char>) {
    let owned: Vec<CString> = (0..len)
        .map(|i| CString::new(format!("item-{i}")).unwrap())
        .collect();
    let ptrs = owned.iter().map(|s| s.as_ptr()).collect();
    (owned, ptrs)
}

#[test]
fn ffi_ref_entry_rejects_oversized_state_count() {
    let role = CString::new("button").unwrap();
    let (_owned, ptrs) = string_array_of(crate::types::ref_entry::AD_MAX_REF_STATES + 1);
    let mut entry = test_ref_entry();
    entry.identity.role = role.as_ptr();
    entry.capabilities.states.items = ptrs.as_ptr();
    entry.capabilities.states.count = ptrs.len();

    let err = decode(entry).unwrap_err();

    assert_eq!(err.code, ErrorCode::InvalidArgs);
    assert!(err.message.contains("AD_MAX_REF_STATES"));
}

#[test]
fn ffi_ref_entry_rejects_oversized_action_count() {
    let role = CString::new("button").unwrap();
    let (_owned, ptrs) = string_array_of(crate::types::ref_entry::AD_MAX_REF_ACTIONS + 1);
    let mut entry = test_ref_entry();
    entry.identity.role = role.as_ptr();
    entry.capabilities.available_actions.items = ptrs.as_ptr();
    entry.capabilities.available_actions.count = ptrs.len();

    let err = decode(entry).unwrap_err();

    assert_eq!(err.code, ErrorCode::InvalidArgs);
    assert!(err.message.contains("AD_MAX_REF_ACTIONS"));
}

#[test]
fn ffi_ref_entry_rejects_oversized_path_count() {
    let role = CString::new("button").unwrap();
    let path: Vec<u32> = (0..(crate::types::ref_entry::AD_MAX_REF_PATH_DEPTH as u32 + 1)).collect();
    let mut entry = test_ref_entry();
    entry.identity.role = role.as_ptr();
    entry.scope.path = path.as_ptr();
    entry.scope.path_count = path.len();

    let err = decode(entry).unwrap_err();

    assert_eq!(err.code, ErrorCode::InvalidArgs);
    assert!(err.message.contains("AD_MAX_REF_PATH_DEPTH"));
}

#[test]
fn ffi_ref_entry_rejects_unterminated_name_within_byte_cap() {
    let role = CString::new("button").unwrap();
    let unterminated = vec![b'a'; crate::convert::string::AD_MAX_STRING_BYTES + 1];
    let mut entry = test_ref_entry();
    entry.identity.role = role.as_ptr();
    entry.identity.name = unterminated.as_ptr().cast();

    let err = decode(entry).unwrap_err();

    assert_eq!(err.code, ErrorCode::InvalidArgs);
    assert!(err.message.contains("name exceeds AD_MAX_STRING_BYTES"));
}

#[test]
fn exact_ref_entry_preserves_typed_identifier_atomically() {
    let role = CString::new("button").unwrap();
    let native_id = CString::new("checkout").unwrap();
    let mut entry = test_ref_entry();
    entry.process.pid = 42;
    entry.identity.role = role.as_ptr();
    entry.identity.native_id = native_id.as_ptr();
    let exact = AdExactRefEntry {
        version: crate::types::exact_ref_entry::AD_EXACT_REF_ENTRY_VERSION,
        size: crate::types::exact_ref_entry::AD_EXACT_REF_ENTRY_SIZE as u32,
        entry,
        process_instance: c"42:100".as_ptr(),
        identifier_kind: AdIdentifierKind::AxDomIdentifier as i32,
    };

    let decoded = unsafe { core_ref_entry_from_exact(&exact) }.unwrap();

    assert_eq!(decoded.process.process_instance.as_deref(), Some("42:100"));
    assert_eq!(
        decoded.identity.native_id,
        Some(ElementIdentifier {
            kind: agent_desktop_core::IdentifierKind::AxDomIdentifier,
            value: "checkout".into(),
        })
    );
}

const EXACT_REF_ENTRY_VERSION_WITHOUT_GEOMETRY_FRAME: u32 = 1;

fn exact_with_version(version: u32) -> AdExactRefEntry {
    let mut entry = test_ref_entry();
    entry.identity.role = c"button".as_ptr();
    entry.identity.name = c"target".as_ptr();
    AdExactRefEntry {
        version,
        size: crate::types::exact_ref_entry::AD_EXACT_REF_ENTRY_SIZE as u32,
        entry,
        process_instance: c"42:100".as_ptr(),
        identifier_kind: AdIdentifierKind::AxIdentifier as i32,
    }
}

#[test]
fn exact_ref_entry_refuses_the_version_that_predates_the_geometry_frame() {
    let current = exact_with_version(crate::types::exact_ref_entry::AD_EXACT_REF_ENTRY_VERSION);
    assert!(unsafe { core_ref_entry_from_exact(&current) }.is_ok());

    let stale = exact_with_version(EXACT_REF_ENTRY_VERSION_WITHOUT_GEOMETRY_FRAME);
    let error = unsafe { core_ref_entry_from_exact(&stale) }.unwrap_err();

    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert!(error.message.contains("version or size"));
}
