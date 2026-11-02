use agent_desktop_core::{AdapterError, DeliverySemantics, ErrorCode};

use crate::actions::context::Target;
use crate::actions::write::mutation::{Fault, WriteKind, WriteReply, fault_of};
use crate::actions::write::write_call::{Call, invoke};
use crate::system::{ACCESSIBLE_INTERFACE, within};
use crate::tree::properties::toolkit_trust::{ToolkitKind, is_gecko, kind};
use crate::tree::{AtspiElement, list_children};

pub(in crate::actions) const UNPROVEN_INDEX_KIND: &str = "selection_index_unproven";

fn supports_indices(toolkit: &crate::system::process::toolkit_id::ToolkitId) -> bool {
    match kind(toolkit) {
        ToolkitKind::Gtk4 => false,
        ToolkitKind::Other => is_gecko(toolkit),
        _ => true,
    }
}

pub(crate) trait IndexLookup {
    fn accessible_indices(&self) -> bool;
    fn counted_indices(&self) -> Result<bool, AdapterError>;
    fn index(&self, item: &AtspiElement) -> Result<i32, AdapterError>;
    fn child(&self, index: i32) -> Result<(String, String), AdapterError>;
    fn select(&self, index: i32) -> Result<WriteReply, AdapterError>;
}

impl Target<'_> {
    fn native_child_exists(&self, index: i32) -> Result<bool, AdapterError> {
        let connection = self.bus.get(self.deadline)?;
        let element = self.element;
        within(self.deadline, async {
            let reply = connection
                .inner()
                .call_method(
                    Some(element.bus_name()),
                    element.path(),
                    Some(super::select_exclusive::SELECTION_INTERFACE),
                    "IsChildSelected",
                    &(index,),
                )
                .await;
            match reply {
                Ok(_) => Ok(true),
                Err(error) if fault_of(&error) == Fault::InvalidArgs => Ok(false),
                Err(error) => Err(crate::system::classify(&error)),
            }
        })
    }
}

impl IndexLookup for Target<'_> {
    fn select(&self, index: i32) -> Result<WriteReply, AdapterError> {
        invoke(
            self,
            Call {
                interface: super::select_exclusive::SELECTION_INTERFACE,
                method: "SelectChild",
                body: &(index,),
                kind: WriteKind::SelectChild,
            },
        )
    }

    fn accessible_indices(&self) -> bool {
        let toolkit = crate::tree::live_read::live_offscreen::toolkit_of(
            self.bus,
            self.element,
            self.deadline,
        );
        supports_indices(&toolkit)
    }

    fn counted_indices(&self) -> Result<bool, AdapterError> {
        let connection = self.bus.get(self.deadline)?;
        let element = self.element;
        let presented = within(self.deadline, async {
            list_children(connection.inner(), element).await
        })?
        .len();
        match i32::try_from(presented) {
            Ok(count) if count > 0 => {
                Ok(self.native_child_exists(count - 1)? && !self.native_child_exists(count)?)
            }
            _ => Ok(false),
        }
    }

    fn index(&self, item: &AtspiElement) -> Result<i32, AdapterError> {
        let connection = self.bus.get(self.deadline)?;
        within(self.deadline, async {
            let reply = connection
                .inner()
                .call_method(
                    Some(item.bus_name()),
                    item.path(),
                    Some(ACCESSIBLE_INTERFACE),
                    "GetIndexInParent",
                    &(),
                )
                .await
                .map_err(|error| crate::system::classify(&error))?;
            reply
                .body()
                .deserialize()
                .map_err(|error| AdapterError::internal(error.to_string()))
        })
    }

    fn child(&self, index: i32) -> Result<(String, String), AdapterError> {
        let connection = self.bus.get(self.deadline)?;
        within(self.deadline, async {
            let reply = connection
                .inner()
                .call_method(
                    Some(self.element.bus_name()),
                    self.element.path(),
                    Some(ACCESSIBLE_INTERFACE),
                    "GetChildAtIndex",
                    &(index,),
                )
                .await
                .map_err(|error| crate::system::classify(&error))?;
            let (bus, path): (String, zbus::zvariant::OwnedObjectPath) = reply
                .body()
                .deserialize()
                .map_err(|error| AdapterError::internal(error.to_string()))?;
            Ok((bus, path.to_string()))
        })
    }
}

pub(crate) fn write(
    lookup: &impl IndexLookup,
    item: &AtspiElement,
) -> Result<WriteReply, AdapterError> {
    lookup.select(resolve(lookup, item)?)
}

fn unproven() -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionNotSupported,
        "The container's selection indices cannot be mapped to accessible rows safely",
    )
    .with_suggestion("On X11, run select again with --headed: the pointer clicks the row and the result is checked against the row's selected state. A headless select cannot establish a safe index mapping, so refreshing or retrying it does not help.")
    .with_details(serde_json::json!({ "kind": UNPROVEN_INDEX_KIND, "retryable": false }))
    .with_disposition(DeliverySemantics::not_delivered())
}

pub(crate) fn resolve(lookup: &impl IndexLookup, item: &AtspiElement) -> Result<i32, AdapterError> {
    if !lookup.accessible_indices() {
        return Err(unproven());
    }
    revalidated(lookup, item)
}

/// The index of `item` in a list whose popup commits the choice. On GTK 4 the
/// accessible children of a list view are the item widgets it presents, while
/// `SelectChild` indexes all of its item widgets, so the two index spaces are
/// the same exactly when no item widget goes unpresented. That holds when the
/// call about the last presented child is answered and the call about the
/// index past it is refused: the widget count is then the presented count.
pub(crate) fn resolve_counted(
    lookup: &impl IndexLookup,
    item: &AtspiElement,
) -> Result<i32, AdapterError> {
    if !lookup.accessible_indices() && !lookup.counted_indices()? {
        return Err(unproven());
    }
    revalidated(lookup, item)
}

pub(crate) fn write_counted(
    lookup: &impl IndexLookup,
    item: &AtspiElement,
) -> Result<WriteReply, AdapterError> {
    lookup.select(resolve_counted(lookup, item)?)
}

fn revalidated(lookup: &impl IndexLookup, item: &AtspiElement) -> Result<i32, AdapterError> {
    let index = lookup.index(item)?;
    if index >= 0 {
        let child = lookup.child(index)?;
        if child.0 == item.bus_name() && child.1 == item.path() {
            return Ok(index);
        }
    }
    Err(AdapterError::new(
        ErrorCode::StaleRef,
        "The selection index no longer names the intended row",
    )
    .with_disposition(DeliverySemantics::not_delivered()))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Rows {
        index: i32,
        occupant: &'static str,
        toolkit: &'static str,
        counted: bool,
        writes: std::cell::Cell<usize>,
    }

    impl IndexLookup for Rows {
        fn select(&self, index: i32) -> Result<WriteReply, AdapterError> {
            assert_eq!(index, self.index);
            self.writes.set(self.writes.get() + 1);
            Ok(WriteReply::Done)
        }
        fn accessible_indices(&self) -> bool {
            supports_indices(&crate::system::process::toolkit_id::ToolkitId {
                name: Some(self.toolkit.into()),
                version: Some("4.14.5".into()),
            })
        }

        fn counted_indices(&self) -> Result<bool, AdapterError> {
            Ok(self.counted)
        }

        fn index(&self, _: &AtspiElement) -> Result<i32, AdapterError> {
            assert!(self.accessible_indices() || self.counted);
            Ok(self.index)
        }
        fn child(&self, index: i32) -> Result<(String, String), AdapterError> {
            assert_eq!(index, self.index);
            Ok((":1.2".into(), self.occupant.into()))
        }
    }

    #[test]
    fn selection_writes_only_the_revalidated_row_and_refuses_gtk4_indices() {
        let item = AtspiElement::new(":1.2", "/mouse", 7);
        let valid = Rows {
            index: 2,
            occupant: "/mouse",
            toolkit: "Qt",
            counted: false,
            writes: Default::default(),
        };
        assert_eq!(write(&valid, &item).unwrap(), WriteReply::Done);
        assert_eq!(valid.writes.get(), 1);
        let replaced = Rows {
            index: 2,
            occupant: "/appearance",
            toolkit: "Qt",
            counted: false,
            writes: Default::default(),
        };
        let error = write(&replaced, &item).unwrap_err();
        assert_eq!(error.code, ErrorCode::StaleRef);
        assert_eq!(error.disposition, DeliverySemantics::not_delivered());
        assert_eq!(replaced.writes.get(), 0);
        let gtk = Rows {
            index: 2,
            occupant: "/mouse",
            toolkit: "GTK",
            counted: false,
            writes: Default::default(),
        };
        let error = write(&gtk, &item).unwrap_err();
        assert_eq!(error.code, ErrorCode::ActionNotSupported);
        let details = error.details.unwrap();
        assert_eq!(details["kind"], "selection_index_unproven");
        assert_eq!(details["retryable"], false);
        assert_eq!(gtk.writes.get(), 0);
    }

    fn gtk_rows(counted: bool, occupant: &'static str) -> Rows {
        Rows {
            index: 2,
            occupant,
            toolkit: "GTK",
            counted,
            writes: Default::default(),
        }
    }

    #[test]
    fn a_gtk4_list_whose_counts_agree_takes_a_counted_write_on_the_revalidated_row() {
        let item = AtspiElement::new(":1.2", "/mouse", 7);
        let agreed = gtk_rows(true, "/mouse");
        assert_eq!(write_counted(&agreed, &item).unwrap(), WriteReply::Done);
        assert_eq!(agreed.writes.get(), 1);
        let hidden_rows = gtk_rows(false, "/mouse");
        let error = write_counted(&hidden_rows, &item).unwrap_err();
        assert_eq!(error.code, ErrorCode::ActionNotSupported);
        assert_eq!(error.details.unwrap()["kind"], UNPROVEN_INDEX_KIND);
        assert_eq!(hidden_rows.writes.get(), 0);
        let replaced = gtk_rows(true, "/appearance");
        let error = write_counted(&replaced, &item).unwrap_err();
        assert_eq!(error.code, ErrorCode::StaleRef);
        assert_eq!(replaced.writes.get(), 0);
    }

    #[test]
    fn a_counted_write_never_widens_the_plain_gtk4_refusal() {
        let item = AtspiElement::new(":1.2", "/mouse", 7);
        let agreed = gtk_rows(true, "/mouse");
        let error = write(&agreed, &item).unwrap_err();
        assert_eq!(error.details.unwrap()["kind"], UNPROVEN_INDEX_KIND);
        assert_eq!(agreed.writes.get(), 0);
    }
}
