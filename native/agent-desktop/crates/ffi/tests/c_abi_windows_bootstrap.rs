#![cfg(target_os = "windows")]

mod common;

use common::{ad_adapter_create, ad_adapter_destroy};

#[test]
fn adapter_create_without_ad_init_establishes_the_process_wide_mta() {
    assert!(
        !agent_desktop_windows::is_mta_established_for_new_threads(),
        "no COM apartment may exist at library load, before the first adapter is created"
    );
    unsafe {
        let adapter = ad_adapter_create();
        assert!(
            !adapter.is_null(),
            "ad_adapter_create must succeed without any prior ad_init call"
        );
        assert!(
            agent_desktop_windows::is_mta_established_for_new_threads(),
            "constructing an adapter through the C ABI must establish the process-wide MTA"
        );
        ad_adapter_destroy(adapter);
    }
    assert!(
        agent_desktop_windows::is_mta_established_for_new_threads(),
        "the MTA usage cookie is retained for process lifetime and survives adapter destruction"
    );
}
