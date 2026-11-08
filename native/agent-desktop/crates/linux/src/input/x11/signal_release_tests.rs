use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc::channel};
use std::thread;
use std::time::{Duration, Instant};

use super::release_before;
use crate::input::x11::fake_sink::deadline;
use crate::input::x11::progress::Progress;
use crate::input::x11::worker_slot::WorkerSlot;

fn worker_that_releases_after_cancel(
    slot: &Arc<WorkerSlot>,
    progress: &Arc<Progress>,
    released: &Arc<AtomicBool>,
) -> thread::JoinHandle<()> {
    let claim = slot.claim(deadline(1_000)).expect("the worker's claim");
    let progress = Arc::clone(progress);
    let released = Arc::clone(released);
    thread::spawn(move || {
        while !progress.is_cancelled() {
            thread::sleep(Duration::from_millis(5));
        }
        thread::sleep(Duration::from_millis(100));
        released.store(true, Ordering::SeqCst);
        drop(claim);
    })
}

#[test]
fn the_signal_waits_for_the_worker_to_release_before_the_default_action_runs() {
    let slot = Arc::new(WorkerSlot::default());
    let progress = Arc::new(Progress::default());
    let released = Arc::new(AtomicBool::new(false));
    let worker = worker_that_releases_after_cancel(&slot, &progress, &released);
    let (seen, observed) = channel();

    release_before(&progress, &slot, Duration::from_secs(5), || {
        seen.send(released.load(Ordering::SeqCst)).expect("send");
    });

    assert!(observed.recv().expect("the follow-up ran"));
    worker.join().expect("the worker ends");
}

#[test]
fn a_worker_that_never_finishes_holds_the_signal_back_only_for_the_wait() {
    let slot = Arc::new(WorkerSlot::default());
    let progress = Arc::new(Progress::default());
    let _stuck = slot
        .claim(deadline(1_000))
        .expect("a claim that is never freed");
    let started = Instant::now();

    release_before(&progress, &slot, Duration::from_millis(200), || {});

    assert!(progress.is_cancelled());
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[test]
fn a_process_that_never_enabled_the_signal_handling_installs_no_handler() {
    let armed = super::arm(
        Arc::new(Progress::default()),
        Arc::new(WorkerSlot::default()),
    );

    assert!(!armed.installed());
    let mut current: libc::sigaction = unsafe { std::mem::zeroed() };
    unsafe { libc::sigaction(libc::SIGTERM, std::ptr::null(), &mut current) };
    assert_eq!(current.sa_sigaction, libc::SIG_DFL);
}

#[test]
fn watcher_startup_failure_preserves_handlers_and_allows_retry() {
    const CHILD: &str = "AD_SIGNAL_STARTUP_CHILD";
    if std::env::var_os(CHILD).is_none() {
        const FILTER: &str = "input::x11::signal_release::tests::watcher_startup_failure_preserves_handlers_and_allows_retry";
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", FILTER, "--nocapture"])
            .env(CHILD, "1")
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        assert!(
            String::from_utf8_lossy(&output.stdout).contains("1 passed; 0 failed"),
            "{FILTER} must execute exactly one test: {output:?}"
        );
        return;
    }
    extern "C" fn previous(_: libc::c_int) {}
    let mut original: libc::sigaction = unsafe { std::mem::zeroed() };
    let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
    action.sa_sigaction = previous as extern "C" fn(libc::c_int) as usize;
    unsafe { libc::sigemptyset(&mut action.sa_mask) };
    assert_eq!(
        unsafe { libc::sigaction(libc::SIGTERM, &action, &mut original) },
        0
    );
    let mut limit: libc::rlimit = unsafe { std::mem::zeroed() };
    assert_eq!(
        unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) },
        0
    );
    let exhausted = libc::rlimit {
        rlim_cur: 0,
        rlim_max: limit.rlim_max,
    };
    assert_eq!(
        unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &exhausted) },
        0
    );
    super::enable();
    let failed = super::arm(Arc::default(), Arc::default());
    assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &limit) }, 0);
    let mut current: libc::sigaction = unsafe { std::mem::zeroed() };
    assert_eq!(
        unsafe { libc::sigaction(libc::SIGTERM, std::ptr::null(), &mut current) },
        0
    );
    assert!(!failed.installed(), "no handlers without a running watcher");
    assert_eq!(current.sa_sigaction, action.sa_sigaction);
    assert_eq!(super::PIPE_WRITE.load(Ordering::Relaxed), -1);
    let retry = super::arm(Arc::default(), Arc::default());
    assert!(retry.installed(), "a startup failure must remain retryable");
    drop(retry);
    assert_eq!(
        unsafe { libc::sigaction(libc::SIGTERM, std::ptr::null(), &mut current) },
        0
    );
    assert_eq!(current.sa_sigaction, action.sa_sigaction);
    assert_eq!(
        unsafe { libc::sigaction(libc::SIGTERM, &original, std::ptr::null_mut()) },
        0
    );
}
