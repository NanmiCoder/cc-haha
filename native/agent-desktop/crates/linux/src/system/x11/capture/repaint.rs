use std::time::{Duration, Instant};

use agent_desktop_core::Deadline;
use x11rb::connection::Connection;
use x11rb::protocol::Event;
use x11rb::protocol::damage::{ConnectionExt as _, Damage, ReportLevel};
use x11rb::protocol::xproto::{ConnectionExt as _, Window};
use x11rb::rust_connection::RustConnection;

use super::damage_bounds::DamageBounds;
use super::grab_rect::GrabRect;

const REDIRECT_WAIT: Duration = Duration::from_millis(100);
const REPAINT_WAIT: Duration = Duration::from_millis(300);
const POLL: Duration = Duration::from_millis(2);

/// Damage reports on one window, created before it is redirected so the
/// server's own first report is not missed.
pub(in crate::system::x11) struct Repaint<'a> {
    connection: &'a RustConnection,
    damage: Damage,
}

impl<'a> Repaint<'a> {
    pub(in crate::system::x11) fn watch(
        connection: &'a RustConnection,
        window: Window,
    ) -> Option<Self> {
        connection.damage_query_version(1, 1).ok()?.reply().ok()?;
        let damage = connection.generate_id().ok()?;
        connection
            .damage_create(damage, window, ReportLevel::BOUNDING_BOX)
            .ok()?
            .check()
            .ok()?;
        Some(Self { connection, damage })
    }

    fn damaged_within(&self, wait: Duration, deadline: Deadline, target: Option<GrabRect>) -> bool {
        let started = Instant::now();
        let limit = wait.min(deadline.remaining());
        let mut seen: Option<DamageBounds> = None;
        loop {
            match self.connection.poll_for_event() {
                Ok(Some(Event::DamageNotify(event))) if event.damage == self.damage => {
                    let area = event.area;
                    let report = DamageBounds::of(area.x, area.y, area.width, area.height);
                    let total = seen.map_or(report, |earlier| earlier.merged(report));
                    seen = Some(total);
                    if target.is_none_or(|rect| total.covers(rect)) {
                        return true;
                    }
                }
                Ok(Some(_)) => continue,
                Ok(None) if started.elapsed() < limit => std::thread::sleep(POLL),
                _ => return false,
            }
        }
    }

    /// Waits for the redirect's own report and then for the client's repaint
    /// after it, and says whether the repaint reports covered the whole
    /// target. Reports that were queued before the subtract belong to the
    /// redirect, so they are dropped. A redirected pixmap read before that repaint can hold what was
    /// on the screen instead of the window's own paint, and a repaint of a
    /// part says nothing about the rest.
    pub(in crate::system::x11) fn settle(&self, deadline: Deadline, target: GrabRect) -> bool {
        let _ = self.connection.flush();
        if !self.damaged_within(REDIRECT_WAIT, deadline, None) {
            return false;
        }
        let _ = self.connection.damage_subtract(self.damage, 0u32, 0u32);
        if let Ok(cookie) = self.connection.get_input_focus() {
            let _ = cookie.reply();
        }
        while let Ok(Some(_)) = self.connection.poll_for_event() {}
        self.damaged_within(REPAINT_WAIT, deadline, Some(target))
    }
}

impl Drop for Repaint<'_> {
    fn drop(&mut self) {
        let _ = self.connection.damage_destroy(self.damage);
        let _ = self.connection.flush();
    }
}
