use agent_desktop_core::{AdapterError, Deadline, FileLock};
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{ConnectionExt, MapState, Window};
use x11rb::rust_connection::RustConnection;

use super::{connect, error, is_overlay};

struct Hidden {
    connection: RustConnection,
    windows: Vec<Window>,
}

impl Hidden {
    fn hide(display: String) -> Result<Self, AdapterError> {
        let (connection, index) = connect(&display)?;
        let root = connection.setup().roots[index].root;
        let mut hidden = Self {
            connection,
            windows: Vec::new(),
        };
        let connection = &hidden.connection;
        for window in connection
            .query_tree(root)
            .map_err(error)?
            .reply()
            .map_err(error)?
            .children
        {
            let attributes = connection
                .get_window_attributes(window)
                .map_err(error)?
                .reply()
                .map_err(error)?;
            if !attributes.override_redirect || attributes.map_state != MapState::VIEWABLE {
                continue;
            }
            let geometry = connection
                .get_geometry(window)
                .map_err(error)?
                .reply()
                .map_err(error)?;
            if is_overlay(connection, window, &attributes, &geometry)? {
                hidden.windows.push(window);
                connection
                    .unmap_window(window)
                    .map_err(error)?
                    .check()
                    .map_err(error)?;
            }
        }
        Ok(hidden)
    }

    fn restore(&mut self) -> Result<(), AdapterError> {
        for window in &self.windows {
            self.connection
                .map_window(*window)
                .map_err(error)?
                .check()
                .map_err(error)?;
        }
        self.windows.clear();
        Ok(())
    }
}

impl Drop for Hidden {
    fn drop(&mut self) {
        for window in &self.windows {
            let _ = self.connection.map_window(*window);
        }
        let _ = self.connection.flush();
    }
}

pub(crate) fn with_hidden<T>(
    display: &str,
    deadline: Deadline,
    capture: impl FnOnce() -> Result<T, AdapterError>,
) -> Result<T, AdapterError> {
    let root = agent_desktop_core::session::agent_desktop_dir().map_err(error)?;
    let _lock = FileLock::acquire(
        &root.join(".x11-cursor.lock"),
        deadline,
        "cursor overlay capture",
    )?;
    let display = display.to_owned();
    let (ready, readiness) = std::sync::mpsc::channel();
    let (resume, resumed) = std::sync::mpsc::channel::<()>();
    let worker = crate::system::x11::start(move || {
        let mut hidden = match Hidden::hide(display) {
            Ok(hidden) => hidden,
            Err(error) => {
                let _ = ready.send(Err(error));
                return Ok(());
            }
        };
        let _ = ready.send(Ok(()));
        let _ = resumed.recv();
        hidden.restore()
    });
    match readiness.recv_timeout(deadline.remaining()) {
        Ok(Ok(())) => {}
        refused => {
            drop(resume);
            let _ = worker.finish(deadline);
            return Err(match refused {
                Ok(Err(error)) => error,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    AdapterError::internal("The X11 cursor capture worker is unavailable")
                }
                _ => deadline.timeout_error(),
            });
        }
    }
    let result = capture();
    drop(resume);
    let cleanup = Deadline::detached_after(1_500)?;
    worker.finish(cleanup).ok_or_else(|| {
        AdapterError::timeout("The cursor overlay could not be restored after capture")
    })??;
    result
}
