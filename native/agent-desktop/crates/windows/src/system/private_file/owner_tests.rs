use super::{Scratch, scratch_nonce};
use crate::system::private_file::WindowsPrivateFile;
use crate::system::private_file::owner::forced_foreign_owner::with_forced_foreign_owner;
use crate::system::private_file::owner::{
    file_owner_sid, process_owner_eligible_sids, process_token_owner_sid,
    process_token_user_sid_for_tests, require_owned_by_eligible_principal,
};
use crate::system::runtime::token_sid::SidBuffer;
use agent_desktop_core::PrivateFileOps;
use std::io::ErrorKind;
use std::os::windows::io::AsRawHandle;
use std::path::Path;
use windows_sys::Win32::Security::Authorization::{SE_FILE_OBJECT, SetSecurityInfo};
use windows_sys::Win32::Security::{
    OWNER_SECURITY_INFORMATION, WELL_KNOWN_SID_TYPE, WinBuiltinAdministratorsSid,
    WinBuiltinUsersSid, WinLocalSystemSid, WinWorldSid,
};
use windows_sys::Win32::Storage::FileSystem::WRITE_OWNER;

#[test]
fn a_freshly_created_files_owner_equals_the_process_token_owner() {
    let scratch = Scratch::new("owner-fresh");
    let path = scratch.path().join("fresh.txt");
    let file = std::fs::File::create(&path).unwrap();

    let owner_sid = file_owner_sid(&file).unwrap();
    let token_owner = process_token_owner_sid().unwrap();

    assert!(
        token_owner.matches(&owner_sid),
        "a freshly created file must land owned by the token owner"
    );
    require_owned_by_eligible_principal(&file, "freshly created file").unwrap();
}

#[test]
fn the_token_owner_does_not_match_a_foreign_well_known_principal() {
    let token_owner = process_token_owner_sid().unwrap();
    let foreign = well_known_sid_buffer(WinLocalSystemSid);

    assert!(
        !token_owner.matches(&foreign),
        "the LocalSystem principal must be foreign to this test process's token owner"
    );
}

#[test]
fn require_owned_by_eligible_principal_refuses_a_foreign_owner_via_the_forced_seam() {
    let scratch = Scratch::new("owner-foreign");
    let path = scratch.path().join("fresh.txt");
    let file = std::fs::File::create(&path).unwrap();

    let refused = with_forced_foreign_owner(|| {
        require_owned_by_eligible_principal(&file, "seam target").unwrap_err()
    });

    assert_eq!(refused.kind(), ErrorKind::PermissionDenied);
    assert!(
        refused.to_string().contains("foreign principal"),
        "the refusal must name the foreign principal: {refused}"
    );
}

/// The bug this module exists to fix: on an elevated token, `TokenOwner`
/// reads as `BUILTIN\Administrators` while `TokenUser` is the human's own
/// SID, so a file this same process moves to be owned by its `TokenUser`
/// must still be accepted. A `TokenOwner`-only compare refuses it - that
/// refusal is exactly what shipped as the reported bug.
#[test]
fn require_owned_by_eligible_principal_accepts_a_token_user_owner_even_when_token_owner_differs() {
    let scratch = Scratch::new("owner-token-user");
    let path = scratch.path().join("user-owned.txt");
    let file = open_with_write_owner_access(&path);

    let token_user = process_token_user_sid_for_tests().unwrap();
    force_file_owner(&file, &token_user);

    let observed_owner = file_owner_sid(&file).unwrap();
    assert!(
        token_user.matches(&observed_owner),
        "the file must now be owned by this process's token user SID"
    );

    require_owned_by_eligible_principal(&file, "token-user-owned file").expect(
        "a file owned by the token's own user SID must be accepted even when it differs from \
         TokenOwner",
    );
}

/// Pins the owner-eligible set itself, independent of which SIDs this test
/// box's token happens to expose today: it must contain both TokenUser and
/// TokenOwner, and it must exclude Everyone even though Everyone is a token
/// group present on every token - Everyone never carries `SE_GROUP_OWNER`,
/// so a filter bug that widened to "any group" would make this fail.
#[test]
fn owner_eligible_sids_contains_token_user_and_owner_but_excludes_everyone() {
    let eligible = process_owner_eligible_sids().unwrap();
    let token_user = process_token_user_sid_for_tests().unwrap();
    let token_owner = process_token_owner_sid().unwrap();
    let everyone = well_known_sid_buffer(WinWorldSid);

    assert!(
        eligible.contains(&token_user),
        "the owner-eligible set must contain this process's token user SID"
    );
    assert!(
        eligible.contains(token_owner),
        "the owner-eligible set must contain this process's token owner SID"
    );
    assert!(
        !eligible.contains(&everyone),
        "the owner-eligible set must exclude Everyone: it is present in every token's groups \
         but never carries SE_GROUP_OWNER, so accepting it would defeat the foreign-principal \
         check"
    );
}

fn open_with_write_owner_access(path: &Path) -> std::fs::File {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{FILE_GENERIC_READ, FILE_GENERIC_WRITE};

    std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .access_mode(FILE_GENERIC_READ | FILE_GENERIC_WRITE | WRITE_OWNER)
        .open(path)
        .expect("the test file must open with WRITE_OWNER access")
}

fn force_file_owner(file: &std::fs::File, owner: &SidBuffer) {
    let status = unsafe {
        SetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            owner.as_psid(),
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    assert_eq!(
        status,
        0,
        "SetSecurityInfo must move the test file's owner to the requested SID: {}",
        std::io::Error::from_raw_os_error(status as i32)
    );
}

#[test]
fn write_atomic_refuses_when_the_owner_seam_forces_a_foreign_principal() {
    let scratch = Scratch::new("owner-foreign-write");
    let artifact = scratch.path().join("artifact.json");
    let ops = WindowsPrivateFile::new();

    let refused = with_forced_foreign_owner(|| ops.write_atomic(&artifact, b"secret").unwrap_err());

    assert_eq!(refused.kind(), ErrorKind::PermissionDenied);
    assert!(
        refused.to_string().contains("foreign principal"),
        "the refused write must name the foreign principal: {refused}"
    );
    assert!(
        !artifact.exists(),
        "no artifact may land when ownership validation refuses the write"
    );
}

/// The append surface carries the same ownership gate as the atomic write, on
/// its own leaf check.
///
/// Private trace segments are appended, so a segment path a foreign principal
/// pre-created must be refused. Only `write_atomic` and `read_private_bounded`
/// were driven through the seam before, which left this one deletable with the
/// suite green.
///
/// The append path is the surface where a leaf gate is reachable at all: it
/// validates only that its directory chain is reparse-free, so the refusal here
/// can come from nowhere but the leaf's own ownership check. The lock surface's
/// leaf check cannot be reached the same way - it calls
/// `ensure_private_directory_chain` first, and the forced-owner seam is
/// thread-global, so the parent's ownership check refuses before the leaf is
/// ever opened and any assertion made through this seam would pass for the
/// parent's reason.
#[test]
fn the_append_surface_refuses_a_foreign_principal_at_its_own_leaf_gate() {
    let scratch = Scratch::new("owner-foreign-append");
    let ops = WindowsPrivateFile::new();
    let appended = scratch.path().join("segment.jsonl");

    ops.open_private_append(&appended)
        .expect("the append surface opens for this process's own principal");

    let refused = with_forced_foreign_owner(|| ops.open_private_append(&appended).unwrap_err());

    assert_eq!(
        refused.kind(),
        ErrorKind::PermissionDenied,
        "the append surface must refuse a foreign owner"
    );
    assert!(
        refused.to_string().contains("private append target"),
        "the refusal must be the append leaf's own, not an enclosing check's: {refused}"
    );
    assert!(
        refused.to_string().contains("foreign principal"),
        "the refused append must name the foreign principal: {refused}"
    );
}

#[test]
fn read_private_bounded_refuses_when_the_owner_seam_forces_a_foreign_principal() {
    let scratch = Scratch::new("owner-foreign-read");
    let artifact = scratch.path().join("artifact.json");
    let ops = WindowsPrivateFile::new();
    ops.write_atomic(&artifact, b"payload").unwrap();

    let refused =
        with_forced_foreign_owner(|| ops.read_private_bounded(&artifact, 64).unwrap_err());

    assert_eq!(refused.kind(), ErrorKind::PermissionDenied);
    assert!(
        refused.to_string().contains("foreign principal"),
        "the refused read must name the foreign principal: {refused}"
    );
}

#[test]
fn copied_from_valid_rejects_a_null_and_an_oversized_sid_with_invalid_data() {
    let null_kind = SidBuffer::copied_from_valid(std::ptr::null_mut())
        .err()
        .map(|error| error.kind());
    assert_eq!(null_kind, Some(ErrorKind::InvalidData));

    let mut oversized = [0_u8; 16];
    oversized[0] = 1;
    oversized[1] = 200;
    let oversized_kind = SidBuffer::copied_from_valid(oversized.as_mut_ptr().cast())
        .err()
        .map(|error| error.kind());
    assert_eq!(oversized_kind, Some(ErrorKind::InvalidData));
}

#[test]
fn a_profile_artifact_keeps_system_admins_and_user_and_never_users_across_create_and_replace() {
    let local_app_data =
        std::env::var_os("LOCALAPPDATA").expect("LOCALAPPDATA must exist on Windows");
    let fresh = Scratch::adopt(Path::new(&local_app_data).join("Temp").join(format!(
        ".agent-desktop-acl-pin-{}-{:016x}",
        std::process::id(),
        scratch_nonce()
    )));
    let artifact = fresh.path().join("artifact.json");
    let ops = WindowsPrivateFile::new();

    ops.write_atomic(&artifact, b"{}")
        .expect("the pinned create-path write must succeed under the user profile");
    let created = inherited_ace_entries(&artifact);
    assert_every_ace_is_inherited(&created);
    assert_profile_security_principals(&created);

    assert!(
        artifact.exists(),
        "the create-path write must leave a destination for the replace path to overwrite"
    );
    ops.write_atomic(&artifact, b"{\"v\":2}")
        .expect("the pinned replace-path write must succeed over the pre-existing leaf");
    assert_profile_security_principals(&inherited_ace_entries(&artifact));
}

fn assert_every_ace_is_inherited(entries: &[(String, bool)]) {
    assert!(!entries.is_empty(), "the artifact must report ACL entries");
    for (sid, inherited) in entries {
        assert!(
            *inherited,
            "every entry on a freshly created profile leaf must be inherited; {sid} is explicit"
        );
    }
}

fn assert_profile_security_principals(entries: &[(String, bool)]) {
    assert!(!entries.is_empty(), "the artifact must report ACL entries");
    let sids: Vec<&str> = entries.iter().map(|(sid, _)| sid.as_str()).collect();
    let system_class = well_known_sid_string(WinLocalSystemSid);
    let administrators_class = well_known_sid_string(WinBuiltinAdministratorsSid);
    let users_class = well_known_sid_string(WinBuiltinUsersSid);
    let token_user = sid_string(&process_token_user_sid_for_tests().unwrap());
    let token_owner = sid_string(process_token_owner_sid().unwrap());
    assert!(
        sids.contains(&system_class.as_str()),
        "a SYSTEM-class principal must be present"
    );
    assert!(
        sids.contains(&administrators_class.as_str()),
        "an Administrators-class principal must be present"
    );
    assert!(
        sids.contains(&token_user.as_str()) || sids.contains(&token_owner.as_str()),
        "the current-user principal must be present"
    );
    assert!(
        !sids.contains(&users_class.as_str()),
        "no Users-class principal may appear on a profile leaf"
    );
}

fn inherited_ace_entries(path: &Path) -> Vec<(String, bool)> {
    let script = format!(
        "$rules = [System.IO.FileInfo]::new('{}').GetAccessControl('Access')\
         .GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]); \
         foreach ($rule in $rules) {{ \
         [Console]::WriteLine(($rule.IdentityReference.Value + '|' + $rule.IsInherited)) }}",
        path.display()
    );
    let output = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command"])
        .arg(&script)
        .output()
        .expect("powershell must be spawnable");
    assert!(
        output.status.success(),
        "the module-free acl read must succeed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| {
            let (sid, inherited) = line
                .split_once('|')
                .expect("each line must be sid|inherited");
            (sid.to_string(), inherited.eq_ignore_ascii_case("true"))
        })
        .collect()
}

fn sid_string(sid: &SidBuffer) -> String {
    sid.to_string_form()
        .expect("the SID must convert to its string form")
}

fn well_known_sid_buffer(kind: WELL_KNOWN_SID_TYPE) -> SidBuffer {
    SidBuffer::well_known(kind)
        .unwrap_or_else(|error| panic!("a well-known SID must be valid for kind {kind}: {error}"))
}

fn well_known_sid_string(kind: WELL_KNOWN_SID_TYPE) -> String {
    sid_string(&well_known_sid_buffer(kind))
}
