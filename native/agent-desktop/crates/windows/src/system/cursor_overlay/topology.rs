//! The desktop the overlay draws onto: which monitors exist, and how fast
//! they refresh.
//!
//! The two are read together and invalidated together — a resolution change,
//! a scale change or a monitor hot-plug makes both stale at once — so they
//! are held as a pair rather than as two fields a caller has to remember to
//! refresh in step.

#[cfg(target_os = "windows")]
pub(crate) use imp::DisplayTopology;

#[cfg(target_os = "windows")]
mod imp {
    use crate::system::cursor_overlay::{display_probe, monitors::OverlayMonitor};

    pub(crate) struct DisplayTopology {
        pub(super) monitors: Vec<OverlayMonitor>,
        pub(super) refresh_hz: u32,
    }

    impl DisplayTopology {
        pub(crate) fn probe() -> Self {
            Self {
                monitors: display_probe::monitors(),
                refresh_hz: display_probe::refresh_hz(),
            }
        }

        pub(crate) fn monitors(&self) -> &[OverlayMonitor] {
            &self.monitors
        }

        pub(crate) fn refresh_hz(&self) -> u32 {
            self.refresh_hz
        }

        /// Re-reads the desktop, keeping the monitors already known when the
        /// enumeration answers none.
        ///
        /// An enumeration that fails is reported as an empty list, which is
        /// indistinguishable from a desktop with no monitors and is what the
        /// paint path falls back to a hardcoded 1920x1080 screen for. Adopting
        /// that would relocate every later frame onto a desktop that does not
        /// exist, and it would survive the fault: nothing restores the real
        /// list except another probe that happens to succeed. Absence of
        /// evidence is not a monitor being unplugged, so the last list that
        /// was actually observed stands.
        pub(crate) fn reprobe(&mut self) {
            self.adopt(Self::probe());
        }

        pub(super) fn adopt(&mut self, probed: Self) {
            self.refresh_hz = probed.refresh_hz;
            if !probed.monitors.is_empty() {
                self.monitors = probed.monitors;
            }
        }
    }
}

#[cfg(all(test, target_os = "windows"))]
#[path = "topology_tests.rs"]
mod tests;
