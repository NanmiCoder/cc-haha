use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::thread::JoinHandle;

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    BN_CLICKED, CreateWindowExW, DefWindowProcW, DispatchMessageW, GWLP_USERDATA, GetMessageW,
    GetWindowLongPtrW, HWND_TOPMOST, IDC_ARROW, LoadCursorW, MSG, PostMessageW, PostQuitMessage,
    PostThreadMessageW, RegisterClassExW, SW_SHOWNOACTIVATE, SWP_NOACTIVATE, SWP_NOMOVE,
    SWP_NOSIZE, SetWindowLongPtrW, SetWindowPos, ShowWindow, TranslateMessage, UnregisterClassW,
    WM_CLOSE, WM_COMMAND, WM_DESTROY, WM_QUIT, WNDCLASSEXW, WS_CHILD, WS_OVERLAPPEDWINDOW,
    WS_VISIBLE,
};

const WM_FIXTURE_READY: u32 = 0x0400 + 1;
const BUTTON_ID: usize = 1;

pub struct Win32ClickFixture {
    counter: Arc<AtomicUsize>,
    userdata_ptr: usize,
    class_name: String,
    window: isize,
    pump_thread_id: u32,
    pump: Option<JoinHandle<()>>,
}

struct FixtureReady {
    window: isize,
    thread_id: u32,
    counter: Arc<AtomicUsize>,
    userdata_ptr: usize,
}

pub fn stage_click_fixture(fixture_name: &str) -> Win32ClickFixture {
    let (ready_tx, ready_rx) = channel::<Result<FixtureReady, String>>();
    let class_name = format!(
        "AgentDesktopFfiFixture-{fixture_name}-{}",
        std::process::id()
    );
    let pump_class = class_name.clone();
    let pump = std::thread::spawn(move || run_pump(&pump_class, ready_tx));
    let ready = ready_rx
        .recv_timeout(std::time::Duration::from_secs(10))
        .expect("fixture pump signalled readiness or failure")
        .expect("fixture window staged");
    Win32ClickFixture {
        counter: ready.counter,
        userdata_ptr: ready.userdata_ptr,
        class_name,
        window: ready.window,
        pump_thread_id: ready.thread_id,
        pump: Some(pump),
    }
}

impl Win32ClickFixture {
    pub fn click_count(&self) -> usize {
        self.counter.load(Ordering::SeqCst)
    }

    pub fn app_filter(&self) -> String {
        let exe = std::env::current_exe().expect("current test executable path");
        exe.file_stem()
            .expect("executable has a file stem")
            .to_string_lossy()
            .into_owned()
    }

    pub fn wait_for_clicks(&self, expected: usize, budget_ms: u64) -> Result<(), String> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(budget_ms);
        while self.click_count() < expected {
            if std::time::Instant::now() >= deadline {
                return Err(format!(
                    "fixture click counter reached {} of expected {expected} within {budget_ms}ms",
                    self.click_count()
                ));
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        Ok(())
    }
}

impl Drop for Win32ClickFixture {
    fn drop(&mut self) {
        teardown_window(self.window, self.pump_thread_id);
        if let Some(pump) = self.pump.take() {
            let _ = pump.join();
        }
        unsafe {
            drop(Arc::from_raw(self.userdata_ptr as *const AtomicUsize));
            let name = wide(&self.class_name);
            UnregisterClassW(name.as_ptr(), GetModuleHandleW(std::ptr::null()));
        }
    }
}

fn run_pump(class_name: &str, ready: Sender<Result<FixtureReady, String>>) {
    activate_common_controls_v6();
    let name = wide(class_name);
    let class = WNDCLASSEXW {
        cbSize: size_of::<WNDCLASSEXW>() as u32,
        lpfnWndProc: Some(fixture_window_proc),
        hInstance: unsafe { GetModuleHandleW(std::ptr::null()) },
        hCursor: unsafe { LoadCursorW(std::ptr::null_mut(), IDC_ARROW) },
        lpszClassName: name.as_ptr(),
        ..Default::default()
    };
    if unsafe { RegisterClassExW(&class) } == 0 {
        let _ = ready.send(Err(format!(
            "RegisterClassExW rejected the fixture class {class_name}"
        )));
        return;
    }
    let counter = Arc::new(AtomicUsize::new(0));
    let userdata_ptr = Arc::into_raw(counter.clone()) as usize;
    create_and_pump(class_name, counter, userdata_ptr, ready);
}

fn create_and_pump(
    class_name: &str,
    counter: Arc<AtomicUsize>,
    userdata_ptr: usize,
    ready: Sender<Result<FixtureReady, String>>,
) {
    let name = wide(class_name);
    let title = wide("agent-desktop ffi fixture");
    let window = unsafe {
        CreateWindowExW(
            0,
            name.as_ptr(),
            title.as_ptr(),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            50,
            50,
            320,
            220,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            GetModuleHandleW(std::ptr::null()),
            std::ptr::null(),
        )
    };
    if window.is_null() {
        let _ = ready.send(Err("CreateWindowExW produced no fixture window".into()));
        return;
    }
    create_button(window);
    unsafe {
        SetWindowLongPtrW(window, GWLP_USERDATA, userdata_ptr as isize);
        ShowWindow(window, SW_SHOWNOACTIVATE);
        SetWindowPos(
            window,
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }
    announce_ready_and_pump(window, counter, userdata_ptr, ready);
}

fn announce_ready_and_pump(
    window: HWND,
    counter: Arc<AtomicUsize>,
    userdata_ptr: usize,
    ready: Sender<Result<FixtureReady, String>>,
) {
    let thread_id = unsafe { GetCurrentThreadId() };
    unsafe { PostMessageW(window, WM_FIXTURE_READY, 0, 0) };
    let mut message = MSG::default();
    let mut announced = false;
    while unsafe { GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) } > 0 {
        unsafe {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        if !announced && message.message == WM_FIXTURE_READY {
            announced = true;
            let _ = ready.send(Ok(FixtureReady {
                window: window as isize,
                thread_id,
                counter: counter.clone(),
                userdata_ptr,
            }));
        }
    }
}

fn create_button(parent: HWND) {
    let class = wide("BUTTON");
    let text = wide("ffi-fixture-button");
    unsafe {
        CreateWindowExW(
            0,
            class.as_ptr(),
            text.as_ptr(),
            WS_CHILD | WS_VISIBLE,
            8,
            8,
            160,
            28,
            parent,
            BUTTON_ID as *mut _,
            GetModuleHandleW(std::ptr::null()),
            std::ptr::null(),
        );
    }
}

unsafe extern "system" fn fixture_window_proc(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_COMMAND {
        let notification = (wparam >> 16) & 0xffff;
        let id = wparam & 0xffff;
        if id == BUTTON_ID && notification == BN_CLICKED as usize {
            let counter = unsafe { GetWindowLongPtrW(window, GWLP_USERDATA) } as *const AtomicUsize;
            if !counter.is_null() {
                unsafe { (*counter).fetch_add(1, Ordering::SeqCst) };
            }
            return 0;
        }
        return unsafe { DefWindowProcW(window, message, wparam, lparam) };
    }
    if message == WM_DESTROY {
        unsafe { PostQuitMessage(0) };
        return 0;
    }
    unsafe { DefWindowProcW(window, message, wparam, lparam) }
}

/// `WM_CLOSE` reaches the pump only through the window; a window destroyed out
/// from under the fixture would leave `GetMessageW` blocked forever, so the
/// teardown also posts `WM_QUIT` to the owning thread's queue as a fallback.
fn teardown_window(window: isize, thread_id: u32) {
    unsafe {
        if window != 0 {
            PostMessageW(window as *mut _, WM_CLOSE, 0, 0);
        }
        PostThreadMessageW(thread_id, WM_QUIT, 0, 0);
    }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

const COMCTL32_V6_MANIFEST: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df"
        language="*" />
    </dependentAssembly>
  </dependency>
</assembly>
"#;

fn activate_common_controls_v6() {
    use windows_sys::Win32::System::ApplicationInstallationAndServicing::{
        ACTCTXW, ActivateActCtx, CreateActCtxW,
    };

    static ACTIVATED: std::sync::Once = std::sync::Once::new();
    ACTIVATED.call_once(|| {
        let directory = std::env::temp_dir().join("agent-desktop-ffi-fixture-manifests");
        let _ = std::fs::create_dir_all(&directory);
        let path = directory.join("comctl32-v6-shared.manifest");
        if std::fs::write(&path, COMCTL32_V6_MANIFEST).is_err() {
            return;
        }
        let source = wide(&path.to_string_lossy());
        let context = ACTCTXW {
            cbSize: size_of::<ACTCTXW>() as u32,
            lpSource: source.as_ptr(),
            ..Default::default()
        };
        let handle = unsafe { CreateActCtxW(&context) };
        if !handle.is_null() && handle as isize != -1 {
            let mut cookie = 0usize;
            unsafe { ActivateActCtx(handle, &mut cookie) };
        }
    });
}
