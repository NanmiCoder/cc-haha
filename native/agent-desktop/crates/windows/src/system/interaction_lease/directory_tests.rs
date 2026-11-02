use std::fs::OpenOptions;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::path::Path;

use windows_sys::Win32::Foundation::{HANDLE, LUID};
use windows_sys::Win32::Security::Authorization::{SE_FILE_OBJECT, SetSecurityInfo};
use windows_sys::Win32::Security::{
    AddAccessAllowedAceEx, CONTAINER_INHERIT_ACE, InitializeAcl, LUID_AND_ATTRIBUTES,
    OWNER_SECURITY_INFORMATION, SE_PRIVILEGE_ENABLED, SE_RESTORE_NAME, TOKEN_PRIVILEGES,
    WinBuiltinGuestsSid, WinBuiltinUsersSid,
};
use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS;

use super::sid::{self, SidBuffer};
use super::{directory, tests::scratch_root};
use crate::system::private_file::tests::create_junction;

fn open_backup_semantics(path: &Path) -> std::fs::File {
    OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .access_mode(
            windows_sys::Win32::Storage::FileSystem::FILE_GENERIC_READ
                | windows_sys::Win32::Storage::FileSystem::READ_CONTROL
                | windows_sys::Win32::Storage::FileSystem::WRITE_DAC
                | windows_sys::Win32::Storage::FileSystem::WRITE_OWNER,
        )
        .open(path)
        .unwrap()
}

fn set_owner(path: &Path, owner: &SidBuffer) {
    let handle = open_backup_semantics(path);
    let raw: HANDLE = handle.as_raw_handle();
    let status = unsafe {
        SetSecurityInfo(
            raw,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            owner.as_psid(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    assert_eq!(status, 0, "SetSecurityInfo(owner) failed: {status}");
}

fn read_owner(path: &Path) -> SidBuffer {
    let handle = open_backup_semantics(path);
    crate::system::runtime::token_sid::read_owner_sid(&handle)
        .expect("GetSecurityInfo(owner) must succeed")
}

/// Enables a privilege already present-but-disabled on this process's token,
/// the way an elevated Administrator's `SeRestorePrivilege` normally sits -
/// needed only for the unrelated-SID owner leg, which sets ownership to a
/// SID outside this process's own token.
fn enable_privilege(name: windows_sys::core::PCWSTR) {
    use windows_sys::Win32::Security::LookupPrivilegeValueW;

    let token = sid::open_process_token_for_adjust().unwrap();
    let mut luid = LUID::default();
    let looked_up = unsafe { LookupPrivilegeValueW(std::ptr::null(), name, &mut luid) };
    assert_ne!(looked_up, 0, "LookupPrivilegeValueW failed");
    let privileges = TOKEN_PRIVILEGES {
        PrivilegeCount: 1,
        Privileges: [LUID_AND_ATTRIBUTES {
            Luid: luid,
            Attributes: SE_PRIVILEGE_ENABLED,
        }],
    };
    let adjusted = unsafe {
        windows_sys::Win32::Security::AdjustTokenPrivileges(
            token,
            0,
            &privileges,
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    assert_ne!(adjusted, 0, "AdjustTokenPrivileges failed");
    unsafe {
        windows_sys::Win32::Foundation::CloseHandle(token);
    }
}

/// A directory whose owner is exactly `TokenOwner` (constructed explicitly,
/// not read off ambient directory-creation behavior): measured on the boxes
/// this suite runs against, this process's `TokenOwner` is the well-known
/// `BUILTIN\Administrators` SID while its `TokenUser` is the distinct
/// machine-local RID-500 account SID - the split-token shape an elevated
/// Administrator process actually carries here, not a single unfiltered
/// token whose owner defaults to itself. `std::fs::create_dir_all` under
/// this token already yields a directory owned by `TokenOwner` (Windows
/// takes a new object's default owner from the token's `Owner` field, not
/// its `User` field) before this test does anything; the owner is still set
/// explicitly here so the assertion pins the `TokenOwner` branch of
/// `validate_owner` regardless of what ambient creation happens to produce
/// on the box the suite runs on.
#[test]
fn a_directory_owned_by_token_owner_is_accepted() {
    let root = scratch_root("owner-token-owner");
    let target = root.join("lockdir");
    std::fs::create_dir(&target).unwrap();
    let token_owner = sid::process_token_owner_sid().unwrap();
    set_owner(&target, token_owner);

    directory::ensure_private(&target)
        .expect("a directory owned by this process's TokenOwner must be accepted");
    assert!(
        read_owner(&target).matches(token_owner),
        "acceptance must not have silently changed the owner it accepted"
    );
    std::fs::remove_dir_all(&root).unwrap();
}

/// A directory owned by `TokenUser` is accepted independently of
/// `TokenOwner`. On the boxes this suite runs against the two SIDs are
/// distinct (see the sibling `TokenOwner` test's doc comment), so this test
/// and that one each pin their own named branch of `validate_owner` against
/// each other rather than sharing one accidental pass;
/// `a_directory_owned_by_an_unrelated_sid_is_refused` is what proves the
/// check refuses a SID that is neither, and the check's own removal
/// (invert-verified separately) proves it is evaluated at all rather than a
/// no-op.
#[test]
fn a_directory_owned_by_token_user_is_accepted() {
    let root = scratch_root("owner-token-user");
    let target = root.join("lockdir");
    std::fs::create_dir(&target).unwrap();
    let token_user = sid::process_token_user_sid().unwrap();
    set_owner(&target, token_user);

    directory::ensure_private(&target)
        .expect("a directory owned by this process's TokenUser must be accepted");
    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn a_directory_owned_by_an_unrelated_sid_is_refused() {
    let root = scratch_root("owner-unrelated");
    let target = root.join("lockdir");
    std::fs::create_dir(&target).unwrap();
    enable_privilege(SE_RESTORE_NAME);
    let guests = SidBuffer::well_known(WinBuiltinGuestsSid).unwrap();
    set_owner(&target, &guests);

    let error = directory::ensure_private(&target).expect_err("an unrelated owner must be refused");
    assert_eq!(error.code, agent_desktop_core::ErrorCode::Internal);
    assert_eq!(
        error.details.as_ref().unwrap()["kind"],
        "lease_directory_untrusted"
    );
    std::fs::remove_dir_all(&root).unwrap();
}

/// **Invert-verified**: relaxing `dacl_grants_only`'s accepted set to also
/// allow `BUILTIN\Users` makes this test fail.
#[test]
fn a_directory_with_an_inherited_users_ace_is_refused() {
    let root = scratch_root("dacl-inherited-users");
    author_container_inherit_users_ace(&root);
    let target = root.join("lockdir");
    std::fs::create_dir(&target).unwrap();

    let error = directory::ensure_private(&target)
        .expect_err("an inherited BUILTIN\\Users ACE must be refused");
    assert_eq!(error.code, agent_desktop_core::ErrorCode::Internal);
    assert_eq!(
        error.details.as_ref().unwrap()["kind"],
        "lease_directory_untrusted"
    );
    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn a_reparse_leaf_inserted_after_parent_creation_is_refused_before_acl_repair() {
    let root = scratch_root("junction-race-root");
    let target_root = scratch_root("junction-race-target");
    author_container_inherit_users_ace(&target_root);
    let requested = root.join("lockdir");

    let raced = directory::with_create_race(&requested, &target_root, || {
        directory::ensure_private(&requested)
    });
    let error = raced.expect_err("the raced junction must fail final-path validation");
    assert_eq!(error.code, agent_desktop_core::ErrorCode::Internal);
    assert_eq!(
        error.details.as_ref().unwrap()["kind"],
        "lease_directory_untrusted"
    );

    assert!(
        directory::ensure_private(&target_root).is_err(),
        "the foreign inherited ACE must remain on the junction target"
    );
    std::fs::remove_dir_all(&root).unwrap();
    std::fs::remove_dir_all(&target_root).unwrap();
}

fn author_container_inherit_users_ace(root: &Path) {
    let users = SidBuffer::well_known(WinBuiltinUsersSid).unwrap();
    let sid_len = unsafe { windows_sys::Win32::Security::GetLengthSid(users.as_psid()) } as usize;
    let acl_len = 8 + 8 + sid_len;
    let mut storage = vec![0_u64; acl_len.div_ceil(8)];
    let acl_ptr = storage
        .as_mut_ptr()
        .cast::<windows_sys::Win32::Security::ACL>();
    unsafe {
        InitializeAcl(
            acl_ptr,
            acl_len as u32,
            windows_sys::Win32::Security::ACL_REVISION,
        )
    };
    let added = unsafe {
        AddAccessAllowedAceEx(
            acl_ptr,
            windows_sys::Win32::Security::ACL_REVISION,
            CONTAINER_INHERIT_ACE,
            windows_sys::Win32::Storage::FileSystem::FILE_GENERIC_WRITE,
            users.as_psid(),
        )
    };
    assert_ne!(added, 0, "AddAccessAllowedAceEx failed");
    let handle = open_backup_semantics(root);
    let raw: HANDLE = handle.as_raw_handle();
    let status = unsafe {
        SetSecurityInfo(
            raw,
            SE_FILE_OBJECT,
            windows_sys::Win32::Security::DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            acl_ptr,
            std::ptr::null_mut(),
        )
    };
    assert_eq!(status, 0, "SetSecurityInfo(inheritable DACL) failed");
}

/// **Invert-verified**: removing the `GetFinalPathNameByHandle` comparison
/// from `validate_final_path` makes this exact test start passing - the
/// junction would resolve transparently and never be caught.
#[test]
fn a_parent_junction_is_refused() {
    let root = scratch_root("junction");
    let real_target = root.join("real-target");
    std::fs::create_dir(&real_target).unwrap();
    let junction = root.join("lockdir");
    create_junction(&junction, &real_target);

    let error = directory::ensure_private(&junction)
        .expect_err("a directory reached only through a junction must be refused");
    assert_eq!(error.code, agent_desktop_core::ErrorCode::Internal);
    assert_eq!(
        error.details.as_ref().unwrap()["kind"],
        "lease_directory_untrusted"
    );
    std::fs::remove_dir_all(&real_target).unwrap();
    let _ = std::fs::remove_dir(&junction);
    std::fs::remove_dir_all(&root).unwrap();
}
