use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::channel;
use std::sync::{Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, PostThreadMessageW,
    RegisterClassExW, ReplyMessage, SW_SHOWNOACTIVATE, ShowWindow, TranslateMessage,
    UnregisterClassW, WM_NULL, WM_QUIT, WNDCLASSEXW, WS_OVERLAPPEDWINDOW,
};

use super::fixture_window::{self, wide};

const STARTUP_TIMEOUT: Duration = Duration::from_secs(5);
static FIXTURE_LOCK: Mutex<()> = Mutex::new(());

static PROBE_COUNT: AtomicU32 = AtomicU32::new(0);
static HANG_ON_PROBE: AtomicU32 = AtomicU32::new(0);
static HANG_ENTERED: AtomicBool = AtomicBool::new(false);
static RELEASE_HANG: AtomicBool = AtomicBool::new(false);
static RESUME_AFTER_MS: AtomicU32 = AtomicU32::new(0);

unsafe extern "system" fn hostile_proc(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_NULL {
        let probe = PROBE_COUNT.fetch_add(1, Ordering::SeqCst) + 1;
        if probe == HANG_ON_PROBE.load(Ordering::SeqCst) {
            HANG_ENTERED.store(true, Ordering::SeqCst);
            unsafe { ReplyMessage(0) };
            let started = std::time::Instant::now();
            while !RELEASE_HANG.load(Ordering::SeqCst) {
                let resume_after = RESUME_AFTER_MS.load(Ordering::SeqCst);
                if resume_after > 0
                    && started.elapsed() >= Duration::from_millis(u64::from(resume_after))
                {
                    break;
                }
                thread::sleep(Duration::from_millis(1));
            }
        }
        return 0;
    }
    unsafe { DefWindowProcW(window, message, wparam, lparam) }
}

pub(crate) struct HungAfterProbeFixture {
    handle: isize,
    thread_id: u32,
    class_name: String,
    host: Option<JoinHandle<()>>,
    _guard: MutexGuard<'static, ()>,
}

impl HungAfterProbeFixture {
    pub(crate) fn create() -> Result<Self, String> {
        let guard = FIXTURE_LOCK.lock().map_err(|_| "fixture lock poisoned")?;
        PROBE_COUNT.store(0, Ordering::SeqCst);
        HANG_ON_PROBE.store(0, Ordering::SeqCst);
        HANG_ENTERED.store(false, Ordering::SeqCst);
        RELEASE_HANG.store(false, Ordering::SeqCst);
        RESUME_AFTER_MS.store(0, Ordering::SeqCst);
        let class_name = fixture_window::unique_class_name();
        let host_name = class_name.clone();
        let (sender, receiver) = channel();
        let host = thread::spawn(move || host_window(&host_name, sender));
        let (handle, thread_id) = receiver
            .recv_timeout(STARTUP_TIMEOUT)
            .map_err(|_| String::from("hostile window did not become ready"))??;
        Ok(Self {
            handle,
            thread_id,
            class_name,
            host: Some(host),
            _guard: guard,
        })
    }

    pub(crate) fn handle(&self) -> isize {
        self.handle
    }

    pub(crate) fn hang_after_probe(&self, probe: u32) -> Result<(), String> {
        HANG_ON_PROBE.store(0, Ordering::SeqCst);
        if !crate::system::window::window_enum::window_is_responsive(self.handle as HWND) {
            return Err(String::from("fixture did not answer the arming probe"));
        }
        PROBE_COUNT.store(0, Ordering::SeqCst);
        HANG_ON_PROBE.store(probe, Ordering::SeqCst);
        Ok(())
    }

    pub(crate) fn did_hang(&self) -> bool {
        HANG_ENTERED.load(Ordering::SeqCst)
    }

    pub(crate) fn resume_after(&self, milliseconds: u32) {
        RESUME_AFTER_MS.store(milliseconds, Ordering::SeqCst);
    }
}

impl Drop for HungAfterProbeFixture {
    fn drop(&mut self) {
        RELEASE_HANG.store(true, Ordering::SeqCst);
        unsafe { PostThreadMessageW(self.thread_id, WM_QUIT, 0, 0) };
        if let Some(host) = self.host.take() {
            let _ = host.join();
        }
        let class = wide(&self.class_name);
        unsafe { UnregisterClassW(class.as_ptr(), GetModuleHandleW(std::ptr::null())) };
    }
}

fn host_window(class_name: &str, ready: std::sync::mpsc::Sender<Result<(isize, u32), String>>) {
    let class = wide(class_name);
    let descriptor = WNDCLASSEXW {
        cbSize: size_of::<WNDCLASSEXW>() as u32,
        lpfnWndProc: Some(hostile_proc),
        hInstance: unsafe { GetModuleHandleW(std::ptr::null()) },
        lpszClassName: class.as_ptr(),
        ..Default::default()
    };
    if unsafe { RegisterClassExW(&descriptor) } == 0 {
        let _ = ready.send(Err(String::from("RegisterClassExW failed")));
        return;
    }
    let title = wide("agent-desktop hostile async fixture");
    let window = unsafe {
        CreateWindowExW(
            0,
            class.as_ptr(),
            title.as_ptr(),
            WS_OVERLAPPEDWINDOW,
            80,
            80,
            320,
            240,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            GetModuleHandleW(std::ptr::null()),
            std::ptr::null(),
        )
    };
    if window.is_null() {
        let _ = ready.send(Err(String::from("CreateWindowExW failed")));
        return;
    }
    unsafe { ShowWindow(window, SW_SHOWNOACTIVATE) };
    let _ = ready.send(Ok((window as isize, unsafe { GetCurrentThreadId() })));
    let mut message = windows_sys::Win32::UI::WindowsAndMessaging::MSG::default();
    while unsafe { GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) } > 0 {
        unsafe {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
    unsafe { windows_sys::Win32::UI::WindowsAndMessaging::DestroyWindow(window) };
}
