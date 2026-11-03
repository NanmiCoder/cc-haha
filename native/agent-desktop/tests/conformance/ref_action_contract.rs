use agent_desktop_core::{
    PlatformAdapter, RefEntry, RefMap, RefStore,
    commands::{click, helpers::RefArgs, wait},
    context::CommandContext,
};
use std::sync::{Mutex, MutexGuard};

static HOME_LOCK: Mutex<()> = Mutex::new(());

pub fn run_click_command(
    adapter: &dyn PlatformAdapter,
    entry: RefEntry,
) -> Result<serde_json::Value, agent_desktop_core::AppError> {
    let context = CommandContext::default();
    with_saved_entry(entry, &context, |snapshot_id| {
        click::execute(
            RefArgs {
                ref_id: format!("@{}:e1", snapshot_id),
                timeout_ms: None,
            },
            adapter,
            &context,
        )
    })
}

pub fn run_wait_element_command(
    adapter: &dyn PlatformAdapter,
    entry: RefEntry,
    context: &CommandContext,
) -> Result<serde_json::Value, agent_desktop_core::AppError> {
    run_wait_element_command_with_predicate(adapter, entry, context, WaitPredicate::new("exists"))
}

pub fn run_wait_element_command_with_predicate(
    adapter: &dyn PlatformAdapter,
    entry: RefEntry,
    context: &CommandContext,
    predicate: WaitPredicate<'_>,
) -> Result<serde_json::Value, agent_desktop_core::AppError> {
    with_saved_entry(entry, context, |snapshot_id| {
        wait::execute(
            wait::WaitArgs {
                mode: wait::WaitModeArgs {
                    ms: None,
                    element: Some(format!("@{snapshot_id}:e1")),
                    window: None,
                    text: None,
                    surface: None,
                    event: None,
                    window_id: None,
                },
                predicate: wait::WaitPredicateArgs {
                    predicate: Some(predicate.name.into()),
                    value: predicate.value.map(String::from),
                    action: predicate.action.map(String::from),
                    count: None,
                },
                timeout_ms: 250,
                app: None,
            },
            adapter,
            context,
        )
    })
}

pub struct WaitPredicate<'a> {
    name: &'a str,
    value: Option<&'a str>,
    action: Option<&'a str>,
}

impl<'a> WaitPredicate<'a> {
    pub fn new(name: &'a str) -> Self {
        Self {
            name,
            value: None,
            action: None,
        }
    }

    pub fn with_value(mut self, value: &'a str) -> Self {
        self.value = Some(value);
        self
    }

    pub fn with_action(mut self, action: &'a str) -> Self {
        self.action = Some(action);
        self
    }
}

fn with_saved_entry<T>(
    entry: RefEntry,
    context: &CommandContext,
    run: impl FnOnce(String) -> Result<T, agent_desktop_core::AppError>,
) -> Result<T, agent_desktop_core::AppError> {
    let _home = TestHome::new();
    let mut refmap = RefMap::new();
    refmap.try_allocate(entry)?;
    let snapshot_id = RefStore::for_session(context.session_id())?.save_new_snapshot(&refmap)?;
    run(snapshot_id)
}

struct TestHome {
    _lock: MutexGuard<'static, ()>,
    dir: std::path::PathBuf,
    prev: Option<std::ffi::OsString>,
}

impl TestHome {
    fn new() -> Self {
        let lock = HOME_LOCK.lock().unwrap();
        let dir = temp_path("home");
        std::fs::create_dir_all(&dir).unwrap();
        let prev = std::env::var_os("HOME");
        unsafe { std::env::set_var("HOME", &dir) };
        Self {
            _lock: lock,
            dir,
            prev,
        }
    }
}

impl Drop for TestHome {
    fn drop(&mut self) {
        match self.prev.as_ref() {
            Some(prev) => unsafe { std::env::set_var("HOME", prev) },
            None => unsafe { std::env::remove_var("HOME") },
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn temp_path(label: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "agent-desktop-conformance-{label}-{}",
        unique_suffix()
    ))
}

fn unique_suffix() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos()
}
