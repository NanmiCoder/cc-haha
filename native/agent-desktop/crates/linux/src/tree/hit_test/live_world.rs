use agent_desktop_core::{AdapterError, Deadline};
use futures_util::future::join4;
use zbus::Connection;

use super::{Facts, HitWorld, Windowing};
use crate::system::shell::container::MENU;
use crate::system::x11::map::ClientMatch;
use crate::system::x11::stacking::stacking_read::StackingRead;
use crate::system::x11::stacking::stacking_source::StackingSource;
use crate::system::x11::twin_tie::client_among_twins;
use crate::system::x11::{DisplayReader, FrameFacts, X11State};
use crate::system::{REGISTRY_ROOT_PATH, within};
use crate::tree::hit_test::hit_descent::{BusNodes, NodeSource};
use crate::tree::properties::node_read::read_node_for;
use crate::tree::properties::read_purpose::ReadPurpose;
use crate::tree::properties::toolkit_trust::{ToolkitKind, kind, read_toolkit};
use crate::tree::resolve::resolve_errors::{stopped_app, stopped_aware};
use crate::tree::surfaces::twin_frames::read_twins;
use crate::tree::surfaces::window_extents::read_window_extents_async;
use crate::tree::vocabulary::state_bits::{ICONIFIED, StateBits};
use crate::tree::{AtspiElement, Extents};

pub(super) fn stopped_aware_for(error: AdapterError, frame: &AtspiElement) -> AdapterError {
    if error.code == agent_desktop_core::ErrorCode::Timeout {
        let stopped = stopped_app(frame.pid());
        stopped_aware(error, stopped.as_deref())
    } else {
        error
    }
}

/// The bus and the display server behind one hit test.
pub(super) struct LiveWorld<'a> {
    nodes: BusNodes<'a>,
    popup: bool,
    popup_rect: Option<Extents>,
    native_popup: Option<crate::system::x11::PopupWindow>,
    frame: Option<AtspiElement>,
    popup_root: Option<AtspiElement>,
}

impl<'a> LiveWorld<'a> {
    pub(super) fn new(connection: &'a Connection, deadline: Deadline) -> Self {
        Self {
            nodes: BusNodes {
                connection,
                deadline,
                screen_origin: None,
            },
            popup: false,
            popup_rect: None,
            native_popup: None,
            frame: None,
            popup_root: None,
        }
    }
}

impl HitWorld for LiveWorld<'_> {
    fn nodes(&mut self) -> &mut impl NodeSource {
        &mut self.nodes
    }

    fn facts(
        &mut self,
        target: &AtspiElement,
        frame: &AtspiElement,
    ) -> Result<Option<Facts>, AdapterError> {
        let root = AtspiElement::new(frame.bus_name(), REGISTRY_ROOT_PATH, frame.pid());
        let connection = self.nodes.connection;
        let deadline = self.nodes.deadline;
        let (screen, window, frame_node, toolkit) = within(deadline, async {
            Ok(join4(
                read_node_for(connection, target, ReadPurpose::Bounds),
                read_window_extents_async(connection, target),
                read_node_for(connection, frame, ReadPurpose::Frame),
                read_toolkit(connection, &root),
            )
            .await)
        })?;
        let (Ok((screen, _)), Some(window), Ok((frame_node, _))) = (screen, window?, frame_node)
        else {
            return Ok(None);
        };
        let (Some(screen), Some(states)) = (
            screen.extents.present().copied(),
            frame_node.traits.states.present(),
        ) else {
            return Ok(None);
        };
        let title = frame_node
            .properties
            .name
            .present()
            .cloned()
            .unwrap_or_default();
        let toolkit = toolkit?;
        self.nodes.screen_origin = if kind(&toolkit) == ToolkitKind::Qt {
            screen
                .x
                .checked_sub(window.x)
                .zip(screen.y.checked_sub(window.y))
        } else {
            None
        };
        self.frame = Some(frame.clone());
        let global_position =
            crate::tree::properties::toolkit_trust::reports_global_position(&toolkit);
        self.native_popup = if target.is_menu_target()
            && frame_node.traits.role.present() == Some(&MENU)
            && kind(&toolkit) == ToolkitKind::Gtk3
        {
            DisplayReader::popup_containing(target.pid(), screen, window, deadline)
        } else if kind(&toolkit) == ToolkitKind::Qt && target.ancestry().combo_owner().is_some() {
            screen
                .x
                .checked_add(screen.width / 2)
                .zip(screen.y.checked_add(screen.height / 2))
                .and_then(|point| DisplayReader::popup_at(target.pid(), point, deadline))
        } else {
            None
        };
        self.popup = frame_node.traits.role.present() == Some(&MENU)
            && (kind(&toolkit) == ToolkitKind::Gtk4
                || (target.is_menu_target() && kind(&toolkit) == ToolkitKind::Gtk3));
        self.popup_rect = if self.popup && kind(&toolkit) == ToolkitKind::Gtk4 {
            within(deadline, async {
                read_window_extents_async(connection, frame).await
            })?
        } else {
            None
        };
        if self.native_popup.is_some()
            && kind(&toolkit) == ToolkitKind::Qt
            && let Some(combo) = target.ancestry().combo_owner()
        {
            let children = within(deadline, crate::tree::list_children(connection, &combo))?;
            if let [(bus, path)] = children.as_slice() {
                self.popup_root = Some(AtspiElement::new(bus, path, target.pid()));
            } else {
                return Ok(None);
            }
        }
        Ok(Some(Facts {
            screen,
            window,
            frame: FrameFacts {
                size_identity: false,
                pid: frame.pid(),
                title,
                extents: frame_node.extents.present().copied(),
                global_position,
            },
            minimized: StateBits::new(states).has(ICONIFIED),
            toolkit,
        }))
    }

    fn windowing(&mut self, frame: &FrameFacts) -> Option<Windowing> {
        let state = DisplayReader.clients_within(self.nodes.deadline);
        let X11State::Ready { active, clients } = state else {
            return None;
        };
        let (client, coordinate_origin) =
            if let Some(popup) = self.native_popup.filter(|_| self.popup) {
                (popup.id, Some((popup.bounds.x, popup.bounds.y)))
            } else if self.popup {
                let rect = self.popup_rect?;
                let popup = DisplayReader::popup_window(
                    frame.pid,
                    (rect.width, rect.height),
                    self.nodes.deadline,
                )?;
                let origin = crate::tree::placement::frame_geometry::popup_origin(
                    (popup.bounds.x, popup.bounds.y),
                    rect,
                )?;
                (popup.id, Some(origin))
            } else {
                let found = client_among_twins(frame, &clients, active, || {
                    let element = self.frame.as_ref()?;
                    within(self.nodes.deadline, async {
                        Ok(read_twins(self.nodes.connection, element, &frame.title).await)
                    })
                    .ok()
                    .flatten()
                });
                let ClientMatch::One(client) = found else {
                    return None;
                };
                if let Some(popup) = self.native_popup {
                    let origin =
                        crate::system::window::window_position::origin_of_client(&clients, client)?;
                    (popup.id, Some(origin))
                } else {
                    (client, None)
                }
            };
        match DisplayReader.read_within(client, self.nodes.deadline) {
            StackingRead::Ready(snapshot) => Some(Windowing {
                descent_root: self.popup_root.clone(),
                coordinate_origin,
                client,
                snapshot,
                clients,
            }),
            StackingRead::NotX11 | StackingRead::NoManager | StackingRead::Unavailable => None,
        }
    }
}
