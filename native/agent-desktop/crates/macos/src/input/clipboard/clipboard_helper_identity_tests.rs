use super::*;
use std::os::unix::fs::PermissionsExt;

#[test]
fn helper_identity_rejects_replaced_ancestor_after_discovery() {
    let root = fixture_root();
    let bin = root.join("bin");
    std::fs::create_dir(&bin).unwrap();
    let helper = bin.join(protocol::HELPER_BASENAME);
    create_helper(&helper);
    let identity = HelperIdentity::read(helper).unwrap();

    std::fs::rename(&bin, root.join("old-bin")).unwrap();
    std::fs::create_dir(&bin).unwrap();
    let replacement = bin.join(protocol::HELPER_BASENAME);
    create_helper(&replacement);

    assert!(identity.revalidate().is_err());
    std::fs::remove_file(replacement).unwrap();
    std::fs::remove_dir(bin).unwrap();
    let old_bin = root.join("old-bin");
    std::fs::remove_file(old_bin.join(protocol::HELPER_BASENAME)).unwrap();
    std::fs::remove_dir(old_bin).unwrap();
    std::fs::remove_dir(root).unwrap();
}

#[test]
fn helper_identity_rejects_acl_write_access_on_ancestor() {
    let root = fixture_root();
    let bin = root.join("bin");
    std::fs::create_dir(&bin).unwrap();
    set_acl(
        &bin,
        "!#acl 1\ngroup:ABCDEFAB-CDEF-ABCD-EFAB-CDEF0000000C:everyone:12:allow:write,delete_child\n",
    );
    let helper = bin.join(protocol::HELPER_BASENAME);
    create_helper(&helper);

    assert!(HelperIdentity::read(helper.clone()).is_err());
    std::fs::remove_file(helper).unwrap();
    std::fs::remove_dir(bin).unwrap();
    std::fs::remove_dir(root).unwrap();
}

#[test]
fn helper_identity_rejects_acl_write_access_on_helper() {
    let root = fixture_root();
    let bin = root.join("bin");
    std::fs::create_dir(&bin).unwrap();
    let helper = bin.join(protocol::HELPER_BASENAME);
    create_helper(&helper);
    set_acl(
        &helper,
        "!#acl 1\ngroup:ABCDEFAB-CDEF-ABCD-EFAB-CDEF0000000C:everyone:12:allow:write\n",
    );

    assert!(HelperIdentity::read(helper.clone()).is_err());
    std::fs::remove_file(helper).unwrap();
    std::fs::remove_dir(bin).unwrap();
    std::fs::remove_dir(root).unwrap();
}

fn fixture_root() -> std::path::PathBuf {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let root = std::env::temp_dir().join(format!(
        "clipboard-helper-identity-{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir(&root).unwrap();
    root
}

fn create_helper(path: &std::path::Path) {
    std::fs::write(path, b"controlled helper fixture").unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
}

fn set_acl(path: &std::path::Path, text: &str) {
    unsafe extern "C" {
        fn acl_from_text(text: *const std::ffi::c_char) -> Acl;
        fn acl_set_file(path: *const std::ffi::c_char, kind: c_int, acl: Acl) -> c_int;
    }
    let path = CString::new(path.as_os_str().as_bytes()).unwrap();
    let text = CString::new(text).unwrap();
    let acl = unsafe { acl_from_text(text.as_ptr()) };
    assert!(
        !acl.is_null(),
        "acl_from_text failed: {}",
        std::io::Error::last_os_error()
    );
    assert_eq!(
        unsafe { acl_set_file(path.as_ptr(), ACL_TYPE_EXTENDED, acl) },
        0
    );
    unsafe { acl_free(acl) };
}

#[test]
fn helper_identity_accepts_current_user_acl_on_helper_and_ancestor() {
    let root = fixture_root();
    let helper = root.join(protocol::HELPER_BASENAME);
    create_helper(&helper);
    let username = std::process::Command::new("id")
        .arg("-un")
        .output()
        .unwrap();
    assert!(username.status.success());
    let username = String::from_utf8(username.stdout).unwrap();
    for path in [&root, &helper] {
        let status = std::process::Command::new("chmod")
            .args([
                "+a",
                &format!(
                    "user:{} allow write,append,writeattr,writeextattr,writesecurity",
                    username.trim()
                ),
            ])
            .arg(path)
            .status()
            .unwrap();
        assert!(status.success());
    }
    let identity = HelperIdentity::read(helper.clone()).unwrap();
    identity.revalidate().unwrap();
    std::fs::remove_file(helper).unwrap();
    std::fs::remove_dir(root).unwrap();
}
