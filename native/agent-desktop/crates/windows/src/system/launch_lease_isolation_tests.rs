use std::collections::BTreeMap;

use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
use windows_sys::Win32::System::Threading::{
    CREATE_UNICODE_ENVIRONMENT, CreateProcessW, PROCESS_INFORMATION, STARTUPINFOW,
    WaitForSingleObject,
};

use crate::system::fixture::test_support::with_interaction_lease_test_lock;
use crate::system::interaction_lease::INTERACTION_LEASE_HANDLE_ENV;
use crate::system::launch_path::{child_environment_block, resolve_executable};

/// End-to-end proof that a process this crate launches never inherits the
/// adopted-lease handoff variable: builds the exact block `create_process`
/// would hand to `CreateProcessW` and feeds it to the real API, then reads
/// the spawned process's own `set` dump back rather than inspecting the
/// block's bytes - a check confined to the block's contents could still pass
/// while some other path (a null environment pointer, say) let the real API
/// inherit this process's environment wholesale regardless of what the
/// block contained.
#[test]
fn a_launched_process_never_inherits_the_lease_handoff_key() {
    with_interaction_lease_test_lock(|| {
        unsafe { std::env::set_var(INTERACTION_LEASE_HANDLE_ENV, "424242") };
        let overrides = BTreeMap::new();
        let block = child_environment_block(&overrides, INTERACTION_LEASE_HANDLE_ENV)
            .expect("decision")
            .expect("an inherited lease handle key forces an explicit block");
        unsafe { std::env::remove_var(INTERACTION_LEASE_HANDLE_ENV) };

        let output_path = std::env::temp_dir().join(format!(
            "agent-desktop-lease-env-isolation-{}.txt",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&output_path);
        let comspec = resolve_executable("cmd.exe").expect("cmd.exe resolves under System32");
        let command_line = super::command_line_for(
            &comspec,
            &[
                "/C".to_string(),
                "set".to_string(),
                ">".to_string(),
                output_path.to_string_lossy().to_string(),
            ],
        )
        .expect("command line");

        let app_wide = super::to_wide(&comspec).expect("app path");
        let mut command_wide = super::to_wide_str(&command_line).expect("command line");
        let mut env_wide = block;

        let startup = STARTUPINFOW {
            cb: std::mem::size_of::<STARTUPINFOW>() as u32,
            ..Default::default()
        };
        let mut information = PROCESS_INFORMATION::default();
        let ok = unsafe {
            CreateProcessW(
                app_wide.as_ptr(),
                command_wide.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                CREATE_UNICODE_ENVIRONMENT,
                env_wide.as_mut_ptr().cast(),
                std::ptr::null(),
                &startup,
                &mut information,
            )
        };
        assert_ne!(
            ok,
            0,
            "cmd.exe should launch with the sanitized environment block: {}",
            std::io::Error::last_os_error()
        );
        let waited = unsafe { WaitForSingleObject(information.hProcess, 5_000) };
        unsafe {
            CloseHandle(information.hThread);
            CloseHandle(information.hProcess);
        }
        assert_eq!(
            waited, WAIT_OBJECT_0,
            "cmd.exe must finish writing its environment dump before it is read"
        );

        let contents = std::fs::read_to_string(&output_path)
            .expect("the child process should have written its environment dump");
        let _ = std::fs::remove_file(&output_path);
        assert!(
            contents.to_ascii_uppercase().contains("SYSTEMROOT="),
            "the dump must carry the inherited environment before its absence check means anything: {contents}"
        );
        let folded_prefix = format!("{}=", INTERACTION_LEASE_HANDLE_ENV.to_ascii_uppercase());
        assert!(
            !contents
                .lines()
                .any(|line| line.to_ascii_uppercase().starts_with(&folded_prefix)),
            "a launched process must never see the lease handoff key: {contents}"
        );
    });
}
