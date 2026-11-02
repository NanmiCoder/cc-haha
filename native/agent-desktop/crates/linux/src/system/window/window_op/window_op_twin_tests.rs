use super::*;

fn twin_world(active: u32, twins: Twins) -> World {
    let world = World::showing(state(10, 10, 400, 300)).then_showing(state(10, 10, 520, 380));
    world.clients.replace(
        [ControlRead::Ready(vec![
            client(CLIENT, "Doc"),
            client(CLIENT + 1, "Doc"),
        ])]
        .into(),
    );
    World {
        twins: Some(twins),
        active: Some(active),
        ..world
    }
}

fn written_client(world: &World) -> u32 {
    world.writes.borrow().first().expect("one write").0
}

#[test]
fn an_operation_on_the_inactive_twin_acts_on_the_other_client() {
    let world = twin_world(
        CLIENT + 1,
        Twins {
            active: vec![false, true],
            me: 0,
        },
    );
    run(&world, &window(), &resize(520.0, 380.0), budget())
        .expect("the other client is this window");
    assert_eq!(written_client(&world), CLIENT);
}

#[test]
fn an_operation_on_the_active_twin_acts_on_the_active_client() {
    let world = twin_world(
        CLIENT + 1,
        Twins {
            active: vec![true, false],
            me: 0,
        },
    );
    run(&world, &window(), &resize(520.0, 380.0), budget())
        .expect("the active client is this window");
    assert_eq!(written_client(&world), CLIENT + 1);
}

#[test]
fn twins_the_manager_does_not_separate_stay_a_refusal_before_any_write() {
    let twins = Twins {
        active: vec![false, true],
        me: 0,
    };
    let mut elsewhere = twin_world(CLIENT + 7, twins.clone());
    elsewhere.twins = Some(twins);
    let error = run(&elsewhere, &window(), &WindowOp::Minimize, budget()).expect_err("a tie");
    assert_eq!(error.code, ErrorCode::AmbiguousTarget);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert_eq!(elsewhere.writes(), 0);
}
