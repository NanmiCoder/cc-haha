mod common;

use agent_desktop_ffi::{
    AdDeliverySemantics, AdExactRefEntry, AdExactSurfaceInfo, AdExactWindowInfo, AdFindControl,
    AdFindFilter, AdFindIdentity, AdFindQuery, AdFindSelection, AdFindStatePredicate,
    AdFindStateSlice, AdNode, AdNodeContent, AdNodePresentation, AdNodeRelation, AdOptionalU64,
    AdOptionalUsize, AdRefCapabilities, AdRefGeometry, AdRefIdentity, AdRefProcess, AdRefScope,
    AdRefSource, AdScreenshotTarget, AdStringSlice, AdWaitMode, AdWaitPredicate, AdWaitScope,
    AdWaitSurfaceModes,
};
use common::{
    AdAction, AdActionResult, AdActionStep, AdElementState, AdPoint, AdRect, AdRefEntry, AdWaitArgs,
};
use std::mem::{MaybeUninit, align_of, offset_of, size_of};

#[test]
fn screenshot_target_layout_is_guarded_for_c_consumers() {
    assert_eq!(size_of::<AdScreenshotTarget>(), 16);
    assert_eq!(align_of::<AdScreenshotTarget>(), 8);
    assert_eq!(offset_of!(AdScreenshotTarget, kind), 0);
    assert_eq!(offset_of!(AdScreenshotTarget, screen_index), 8);
}

#[test]
fn action_layout_is_guarded_for_c_consumers() {
    assert_eq!(agent_desktop_ffi::AD_ACTION_SIZE, 96);
    assert_eq!(
        unsafe { common::ad_action_size() },
        agent_desktop_ffi::AD_ACTION_SIZE
    );
    assert_eq!(size_of::<AdAction>(), 96);
    assert_eq!(align_of::<AdAction>(), align_of::<usize>());

    let offsets = [
        offset_of!(AdAction, kind),
        offset_of!(AdAction, text),
        offset_of!(AdAction, scroll),
        offset_of!(AdAction, key),
        offset_of!(AdAction, drag),
    ];
    assert_eq!(offsets[0], 0);
    assert!(offsets.windows(2).all(|pair| pair[0] < pair[1]));

    let copied = unsafe {
        let action = MaybeUninit::<AdAction>::zeroed().assume_init();
        std::ptr::read(&action as *const AdAction)
    };
    assert_eq!(copied.kind, 0);
    assert_eq!(copied.drag.drop_delay_ms, 0);
}

#[test]
fn action_result_layout_is_guarded_for_c_consumers() {
    assert_eq!(agent_desktop_ffi::AD_ACTION_RESULT_SIZE, 56);
    assert_eq!(
        unsafe { common::ad_action_result_size() },
        agent_desktop_ffi::AD_ACTION_RESULT_SIZE
    );
    assert_eq!(agent_desktop_ffi::AD_ACTION_STEP_SIZE, 32);
    assert_eq!(
        unsafe { common::ad_action_step_size() },
        agent_desktop_ffi::AD_ACTION_STEP_SIZE
    );
    assert_eq!(
        size_of::<AdActionStep>(),
        agent_desktop_ffi::AD_ACTION_STEP_SIZE
    );
    assert_eq!(align_of::<AdActionStep>(), align_of::<usize>());
    assert_eq!(size_of::<AdActionResult>(), 56);
    assert_eq!(align_of::<AdActionResult>(), align_of::<usize>());
    assert_eq!(offset_of!(AdActionResult, action), 0);
    assert_eq!(offset_of!(AdActionResult, ref_id), 8);
    assert_eq!(offset_of!(AdActionResult, post_state), 16);
    assert_eq!(offset_of!(AdActionResult, steps), 24);
    assert_eq!(offset_of!(AdActionResult, step_count), 32);
    assert_eq!(offset_of!(AdActionResult, details_json), 40);
    assert_eq!(offset_of!(AdActionResult, disposition), 48);
    assert_eq!(size_of::<AdDeliverySemantics>(), 8);
    assert_eq!(offset_of!(AdDeliverySemantics, delivery), 0);
    assert_eq!(offset_of!(AdDeliverySemantics, retry), 4);
    assert_eq!(offset_of!(AdActionStep, label), 0);
    assert_eq!(offset_of!(AdActionStep, outcome), 8);
    assert_eq!(offset_of!(AdActionStep, mechanism), 16);
    assert_eq!(offset_of!(AdActionStep, has_mechanism), 20);
    assert_eq!(offset_of!(AdActionStep, verified), 21);
    assert_eq!(offset_of!(AdActionStep, has_verified), 22);
    assert_eq!(offset_of!(AdActionStep, _reserved), 24);

    let copied = unsafe {
        let step = MaybeUninit::<AdActionStep>::zeroed().assume_init();
        std::ptr::read(&step as *const AdActionStep)
    };
    assert!(copied.label.is_null());
    assert!(copied.outcome.is_null());
    assert_eq!(copied.mechanism, 0);
    assert!(!copied.has_mechanism);
    assert!(!copied.verified);
    assert!(!copied.has_verified);
    assert_eq!(copied._reserved, 0);
}

#[test]
fn element_state_layout_is_guarded_for_c_consumers() {
    assert_eq!(agent_desktop_ffi::AD_ELEMENT_STATE_SIZE, 32);
    assert_eq!(
        unsafe { common::ad_element_state_size() },
        agent_desktop_ffi::AD_ELEMENT_STATE_SIZE
    );
    assert_eq!(size_of::<AdElementState>(), 32);
    assert_eq!(align_of::<AdElementState>(), align_of::<usize>());
    assert_eq!(offset_of!(AdElementState, role), 0);
}

#[test]
fn rect_and_point_layouts_are_memcpyable() {
    let rect = AdRect {
        x: 1.25,
        y: -2.5,
        width: 640.0,
        height: 480.0,
    };
    let copied = unsafe { std::ptr::read(&rect as *const AdRect) };
    assert_eq!(copied.x, 1.25);
    assert_eq!(copied.y, -2.5);
    assert_eq!(copied.width, 640.0);
    assert_eq!(copied.height, 480.0);

    let point = AdPoint { x: 3.0, y: 4.0 };
    let copied = unsafe { std::ptr::read(&point as *const AdPoint) };
    assert_eq!(copied.x, 3.0);
    assert_eq!(copied.y, 4.0);
}

#[test]
fn find_query_layout_is_guarded_for_c_consumers() {
    assert_eq!(agent_desktop_ffi::AD_FIND_SELECTION_SIZE, 8);
    assert_eq!(size_of::<AdFindSelection>(), 8);
    assert_eq!(offset_of!(AdFindSelection, kind), 0);
    assert_eq!(offset_of!(AdFindSelection, nth), 4);
    assert_eq!(agent_desktop_ffi::AD_FIND_CONTROL_SIZE, 24);
    assert_eq!(size_of::<AdFindControl>(), 24);
    assert_eq!(offset_of!(AdFindControl, version), 0);
    assert_eq!(offset_of!(AdFindControl, selection), 4);
    assert_eq!(offset_of!(AdFindControl, timeout_ms), 16);
    assert_eq!(agent_desktop_ffi::AD_FIND_IDENTITY_SIZE, 40);
    assert_eq!(size_of::<AdFindIdentity>(), 40);
    assert_eq!(offset_of!(AdFindIdentity, role), 0);
    assert_eq!(offset_of!(AdFindIdentity, value), 32);
    assert_eq!(agent_desktop_ffi::AD_FIND_STATE_PREDICATE_SIZE, 16);
    assert_eq!(size_of::<AdFindStatePredicate>(), 16);
    assert_eq!(offset_of!(AdFindStatePredicate, token), 0);
    assert_eq!(offset_of!(AdFindStatePredicate, expected), 8);
    assert_eq!(agent_desktop_ffi::AD_FIND_STATE_SLICE_SIZE, 16);
    assert_eq!(size_of::<AdFindStateSlice>(), 16);
    assert_eq!(offset_of!(AdFindStateSlice, items), 0);
    assert_eq!(offset_of!(AdFindStateSlice, count), 8);
    assert_eq!(agent_desktop_ffi::AD_FIND_FILTER_SIZE, 88);
    assert_eq!(size_of::<AdFindFilter>(), 88);
    assert_eq!(offset_of!(AdFindFilter, identity), 0);
    assert_eq!(offset_of!(AdFindFilter, has_text), 40);
    assert_eq!(offset_of!(AdFindFilter, states), 48);
    assert_eq!(offset_of!(AdFindFilter, has), 64);
    assert_eq!(offset_of!(AdFindFilter, has_not), 72);
    assert_eq!(offset_of!(AdFindFilter, exact), 80);
    assert_eq!(agent_desktop_ffi::AD_FIND_QUERY_VERSION, 1);
    assert_eq!(agent_desktop_ffi::AD_FIND_QUERY_SIZE, 112);
    assert_eq!(size_of::<AdFindQuery>(), 112);
    assert_eq!(align_of::<AdFindQuery>(), align_of::<usize>());
    assert_eq!(offset_of!(AdFindQuery, control), 0);
    assert_eq!(offset_of!(AdFindQuery, filter), 24);
}

#[test]
fn ref_entry_input_caps_match_the_published_header_values() {
    assert_eq!(agent_desktop_ffi::AD_MAX_REF_STATES, 64);
    assert_eq!(agent_desktop_ffi::AD_MAX_REF_ACTIONS, 32);
    assert_eq!(agent_desktop_ffi::AD_MAX_REF_PATH_DEPTH, 128);
}

#[test]
fn ref_entry_layout_is_guarded_for_c_consumers() {
    assert_eq!(agent_desktop_ffi::AD_REF_ENTRY_SIZE, 200);
    assert_eq!(
        unsafe { common::ad_ref_entry_size() },
        agent_desktop_ffi::AD_REF_ENTRY_SIZE
    );
    assert_eq!(size_of::<AdRefEntry>(), 200);
    assert_eq!(align_of::<AdRefEntry>(), align_of::<usize>());

    assert_eq!(offset_of!(AdRefEntry, process), 0);
    assert_eq!(offset_of!(AdRefEntry, identity), 8);
    assert_eq!(offset_of!(AdRefEntry, geometry), 48);
    assert_eq!(offset_of!(AdRefEntry, capabilities), 96);
    assert_eq!(offset_of!(AdRefEntry, source), 128);
    assert_eq!(offset_of!(AdRefEntry, scope), 168);
    assert_eq!(size_of::<AdRefProcess>(), 4);
    assert_eq!(size_of::<AdRefIdentity>(), 40);
    assert_eq!(offset_of!(AdRefIdentity, name), 8);
    assert_eq!(offset_of!(AdRefIdentity, native_id), 32);
    assert_eq!(size_of::<AdStringSlice>(), 16);
    assert_eq!(offset_of!(AdStringSlice, count), 8);
    assert_eq!(size_of::<AdRefCapabilities>(), 32);
    assert_eq!(offset_of!(AdRefCapabilities, available_actions), 16);
    assert_eq!(size_of::<AdRefGeometry>(), 48);
    assert_eq!(offset_of!(AdRefGeometry, bounds_hash), 32);
    assert_eq!(offset_of!(AdRefGeometry, has_bounds), 40);
    assert_eq!(offset_of!(AdRefGeometry, has_bounds_hash), 41);
    assert_eq!(offset_of!(AdRefGeometry, bounds_space), 44);
    assert_eq!(size_of::<AdRefSource>(), 40);
    assert_eq!(offset_of!(AdRefSource, window_bounds_hash), 24);
    assert_eq!(offset_of!(AdRefSource, surface), 32);
    assert_eq!(offset_of!(AdRefSource, has_window_bounds_hash), 36);
    assert_eq!(size_of::<AdRefScope>(), 32);
    assert_eq!(offset_of!(AdRefScope, path), 8);
    assert_eq!(offset_of!(AdRefScope, path_count), 16);
    assert_eq!(offset_of!(AdRefScope, path_is_absolute), 24);

    let copied = unsafe {
        let entry = MaybeUninit::<AdRefEntry>::zeroed().assume_init();
        std::ptr::read(&entry as *const AdRefEntry)
    };
    assert_eq!(copied.process.pid, 0);
    assert_eq!(copied.scope.path_count, 0);
    assert!(copied.identity.native_id.is_null());
}

#[test]
fn exact_ref_entry_is_additive_versioned_and_layout_pinned() {
    assert_eq!(agent_desktop_ffi::AD_EXACT_REF_ENTRY_VERSION, 2);
    assert_eq!(agent_desktop_ffi::AD_EXACT_REF_ENTRY_SIZE, 224);
    assert_eq!(unsafe { common::ad_exact_ref_entry_size() }, 224);
    assert_eq!(size_of::<AdExactRefEntry>(), 224);
    assert_eq!(align_of::<AdExactRefEntry>(), align_of::<usize>());
    assert_eq!(offset_of!(AdExactRefEntry, version), 0);
    assert_eq!(offset_of!(AdExactRefEntry, size), 4);
    assert_eq!(offset_of!(AdExactRefEntry, entry), 8);
    assert_eq!(offset_of!(AdExactRefEntry, process_instance), 208);
    assert_eq!(offset_of!(AdExactRefEntry, identifier_kind), 216);
}

#[test]
fn exact_window_info_is_additive_versioned_and_layout_pinned() {
    assert_eq!(agent_desktop_ffi::AD_EXACT_WINDOW_INFO_VERSION, 2);
    assert_eq!(agent_desktop_ffi::AD_EXACT_WINDOW_INFO_SIZE, 96);
    assert_eq!(unsafe { common::ad_exact_window_info_size() }, 96);
    assert_eq!(size_of::<AdExactWindowInfo>(), 96);
    assert_eq!(align_of::<AdExactWindowInfo>(), align_of::<usize>());
    assert_eq!(offset_of!(AdExactWindowInfo, version), 0);
    assert_eq!(offset_of!(AdExactWindowInfo, size), 4);
    assert_eq!(offset_of!(AdExactWindowInfo, window), 8);
    assert_eq!(offset_of!(AdExactWindowInfo, process_instance), 80);
    assert_eq!(offset_of!(AdExactWindowInfo, accessible), 88);
}

#[test]
fn exact_surface_info_is_additive_versioned_and_layout_pinned() {
    assert_eq!(agent_desktop_ffi::AD_EXACT_SURFACE_INFO_VERSION, 2);
    assert_eq!(agent_desktop_ffi::AD_EXACT_SURFACE_INFO_SIZE, 48);
    assert_eq!(unsafe { common::ad_exact_surface_info_size() }, 48);
    assert_eq!(size_of::<AdExactSurfaceInfo>(), 48);
    assert_eq!(align_of::<AdExactSurfaceInfo>(), align_of::<usize>());
    assert_eq!(offset_of!(AdExactSurfaceInfo, version), 0);
    assert_eq!(offset_of!(AdExactSurfaceInfo, size), 4);
    assert_eq!(offset_of!(AdExactSurfaceInfo, id), 8);
    assert_eq!(offset_of!(AdExactSurfaceInfo, surface), 16);
    assert_eq!(offset_of!(AdExactSurfaceInfo, unclassified), 40);
}

#[test]
fn wait_args_layout_is_guarded_for_c_consumers() {
    assert_eq!(agent_desktop_ffi::AD_WAIT_ARGS_SIZE, 104);
    assert_eq!(
        unsafe { common::ad_wait_args_size() },
        agent_desktop_ffi::AD_WAIT_ARGS_SIZE
    );
    assert_eq!(size_of::<AdWaitArgs>(), 104);
    assert_eq!(align_of::<AdWaitArgs>(), align_of::<usize>());

    assert_eq!(offset_of!(AdWaitArgs, mode), 0);
    assert_eq!(offset_of!(AdWaitArgs, predicate), 48);
    assert_eq!(offset_of!(AdWaitArgs, scope), 88);
    assert_eq!(size_of::<AdOptionalU64>(), 16);
    assert_eq!(offset_of!(AdOptionalU64, present), 8);
    assert_eq!(size_of::<AdWaitSurfaceModes>(), 3);
    assert_eq!(size_of::<AdWaitMode>(), 48);
    assert_eq!(offset_of!(AdWaitMode, element), 16);
    assert_eq!(offset_of!(AdWaitMode, surfaces), 40);
    assert_eq!(size_of::<AdOptionalUsize>(), 16);
    assert_eq!(offset_of!(AdOptionalUsize, present), 8);
    assert_eq!(size_of::<AdWaitPredicate>(), 40);
    assert_eq!(offset_of!(AdWaitPredicate, count), 24);
    assert_eq!(size_of::<AdWaitScope>(), 16);
    assert_eq!(offset_of!(AdWaitScope, app), 8);

    let zeroed = unsafe { MaybeUninit::<AdWaitArgs>::zeroed().assume_init() };
    assert_eq!(zeroed.mode.pause.value, 0);
    assert!(!zeroed.mode.pause.present);
    assert!(zeroed.mode.element.is_null());
    assert!(!zeroed.mode.surfaces.menu);
    assert_eq!(zeroed.scope.timeout_ms, 0);
}

#[test]
fn node_layout_is_grouped_and_pinned() {
    assert_eq!(size_of::<AdNode>(), 112);
    assert_eq!(offset_of!(AdNode, content), 0);
    assert_eq!(offset_of!(AdNode, presentation), 48);
    assert_eq!(offset_of!(AdNode, relation), 96);
    assert_eq!(size_of::<AdNodeContent>(), 48);
    assert_eq!(offset_of!(AdNodeContent, hint), 40);
    assert_eq!(size_of::<AdNodePresentation>(), 48);
    assert_eq!(offset_of!(AdNodePresentation, bounds), 8);
    assert_eq!(offset_of!(AdNodePresentation, state_count), 40);
    assert_eq!(offset_of!(AdNodePresentation, has_bounds), 44);
    assert_eq!(size_of::<AdNodeRelation>(), 12);
    assert_eq!(offset_of!(AdNodeRelation, child_count), 8);
}
