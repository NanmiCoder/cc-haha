use agent_desktop_core::{MouseEvent, MouseEventKind, OperationReport};

pub(crate) fn pointer_report(event: &MouseEvent) -> OperationReport {
    OperationReport::pointer_dispatched(event, matches!(event.kind, MouseEventKind::Move))
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_desktop_core::{DeliverySemantics, MouseButton, Point};

    fn event(kind: MouseEventKind) -> MouseEvent {
        MouseEvent {
            kind,
            point: Point { x: 1.0, y: 1.0 },
            button: MouseButton::Left,
            modifiers: Vec::new(),
        }
    }

    #[test]
    fn only_a_move_is_verified_because_only_it_reads_the_cursor_back() {
        assert_eq!(
            pointer_report(&event(MouseEventKind::Move)).disposition(),
            DeliverySemantics::delivered_verified()
        );
        for kind in [
            MouseEventKind::Click { count: 1 },
            MouseEventKind::Wheel {
                delta_x: 0.0,
                delta_y: 1.0,
            },
        ] {
            assert_eq!(
                pointer_report(&event(kind)).disposition(),
                DeliverySemantics::delivered_unverified()
            );
        }
    }
}
