use super::*;

fn isolated(test: &str) -> bool {
    const CHILD: &str = "AD_CLIPBOARD_REAPER_TEST_CHILD";
    if std::env::var(CHILD).as_deref() == Ok(test) {
        return false;
    }
    let output = Command::new(std::env::current_exe().expect("test image"))
        .args(["--exact", test, "--include-ignored", "--nocapture"])
        .env(CHILD, test)
        .output()
        .expect("isolated test process");
    assert!(
        output.status.success(),
        "isolated reaper regression failed: {output:?}"
    );
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("1 passed; 0 failed"),
        "{test} must execute exactly one test: {output:?}"
    );
    true
}

fn refuse_threads() {
    use libc::{sock_filter, sock_fprog};

    fn instruction(code: u32, jt: u8, jf: u8, k: u32) -> sock_filter {
        sock_filter {
            code: code as u16,
            jt,
            jf,
            k,
        }
    }

    let mut filter = [
        instruction(libc::BPF_LD | libc::BPF_W | libc::BPF_ABS, 0, 0, 0),
        instruction(libc::BPF_JMP | libc::BPF_JEQ, 0, 1, libc::SYS_clone3 as u32),
        instruction(
            libc::BPF_RET,
            0,
            0,
            libc::SECCOMP_RET_ERRNO | libc::ENOSYS as u32,
        ),
        instruction(libc::BPF_JMP | libc::BPF_JEQ, 0, 3, libc::SYS_clone as u32),
        instruction(libc::BPF_LD | libc::BPF_W | libc::BPF_ABS, 0, 0, 16),
        instruction(
            libc::BPF_JMP | libc::BPF_JSET,
            0,
            1,
            libc::CLONE_THREAD as u32,
        ),
        instruction(
            libc::BPF_RET,
            0,
            0,
            libc::SECCOMP_RET_ERRNO | libc::EAGAIN as u32,
        ),
        instruction(libc::BPF_RET, 0, 0, libc::SECCOMP_RET_ALLOW),
    ];
    let program = sock_fprog {
        len: filter.len() as u16,
        filter: filter.as_mut_ptr(),
    };
    assert_eq!(
        unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) },
        0
    );
    assert_eq!(
        unsafe { libc::prctl(libc::PR_SET_SECCOMP, libc::SECCOMP_MODE_FILTER, &program) },
        0
    );
}

struct RefuseAfterOwner<'a> {
    server: &'a dyn SelectionServer,
    refused: Cell<bool>,
}

impl SelectionServer for RefuseAfterOwner<'_> {
    fn owner(&self, display: &str, deadline: Deadline) -> Result<Option<u32>, Fault> {
        let owner = self.server.owner(display, deadline)?;
        if !self.refused.replace(true) {
            refuse_threads();
        }
        Ok(owner)
    }

    fn targets(&self, display: &str, deadline: Deadline) -> Result<Vec<String>, Fault> {
        self.server.targets(display, deadline)
    }

    fn release(&self, display: &str, deadline: Deadline) -> Result<(), Fault> {
        self.server.release(display, deadline)
    }
}

fn check_failure(world: &World, helper: &Path, display: &str, server: &dyn SelectionServer) {
    let server = RefuseAfterOwner {
        server,
        refused: Cell::new(false),
    };
    let parent = |name: &str| world.env_var(name);
    let result = set_with(
        &Env {
            helper,
            record_dir: &world.records,
            server: &server,
            parent_env: &parent,
            nonce: &world.nonce,
        },
        display,
        &text("reaper failure"),
        &lease(10_000),
    );
    let pid = world.pid().expect("the helper started and wrote its pid");
    let reaped = !Path::new(&format!("/proc/{pid}")).exists();
    let records = world.record_names();
    let mut status = 0;
    if unsafe { libc::waitpid(pid as i32, &mut status, libc::WNOHANG) } == 0 {
        terminate(Some(pid));
        assert_eq!(
            unsafe { libc::waitpid(pid as i32, &mut status, 0) },
            pid as i32
        );
    }
    fs::remove_dir_all(&world.root).expect("remove this test's scratch");
    assert!(
        reaped,
        "startup failure must terminate and reap the helper before returning"
    );
    let error = result.expect_err("reaper startup failure must not report success");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert!(
        error.message.contains("reaper could not start"),
        "{error:?}"
    );
    assert_eq!(error.disposition, DeliverySemantics::uncertain());
    assert!(
        records.is_empty(),
        "the failed owner's record must be discarded"
    );
}

#[test]
fn reaper_startup_failure_reaps_the_owner_and_refuses_success() {
    if isolated(
        concat!(
            module_path!(),
            "::reaper_startup_failure_reaps_the_owner_and_refuses_success"
        )
        .trim_start_matches("agent_desktop_linux::"),
    ) {
        return;
    }
    for (name, owners) in [
        ("reaper-failure", vec![None, Some(WINDOW)]),
        ("reaper-failure-restored", vec![Some(7)]),
    ] {
        let world = World::new(name);
        let helper = world.helper(CLAIMS);
        let server = FakeServer::new(&owners, &text_targets());
        check_failure(&world, &helper, DISPLAY, &server);
    }
}

#[test]
#[ignore = "needs a private X11 session and the built clipboard owner"]
fn live_reaper_startup_failure_reaps_the_claimed_owner_and_refuses_success() {
    if isolated(
        concat!(
            module_path!(),
            "::live_reaper_startup_failure_reaps_the_claimed_owner_and_refuses_success"
        )
        .trim_start_matches("agent_desktop_linux::"),
    ) {
        return;
    }
    let private = std::env::var("AGENT_DESKTOP_PRIVATE_SESSION").expect("private session required");
    assert_eq!(
        std::env::var("XDG_RUNTIME_DIR").as_deref(),
        Ok(private.as_str())
    );
    let display = std::env::var("DISPLAY").expect("private display");
    assert!(
        display
            .strip_prefix(':')
            .and_then(|n| n.parse::<u32>().ok())
            .is_some_and(|n| n >= 100)
    );
    let image = std::env::current_exe().expect("test image");
    let owner = image
        .parent()
        .and_then(Path::parent)
        .expect("profile directory")
        .join("agent-desktop-linux-clipboard-owner");
    assert!(
        owner.is_file(),
        "build the clipboard owner before this test"
    );
    let world = World::new("reaper-failure-live");
    let helper = world.helper(&format!(
        "echo $$ > \"$AGENT_DESKTOP_HOME/pid\"\nexec '{}'",
        owner.display()
    ));
    check_failure(&world, &helper, &display, &X11Server);
}
