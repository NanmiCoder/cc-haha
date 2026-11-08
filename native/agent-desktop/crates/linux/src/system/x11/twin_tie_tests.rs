use super::*;

fn twins(active: &[bool], me: usize) -> Twins {
    Twins {
        active: active.to_vec(),
        me,
    }
}

fn client(id: u32, title: &str, hidden: bool) -> X11Client {
    X11Client {
        shadow: (0, 0, 0, 0),
        id,
        hidden,
        pid: Some(10),
        title: title.to_owned(),
        extents: None,
        bounds: None,
    }
}

fn frame(title: &str) -> FrameFacts {
    FrameFacts {
        size_identity: false,
        pid: 10,
        title: title.to_owned(),
        extents: None,
        global_position: false,
    }
}

#[test]
fn the_active_frame_is_the_active_client() {
    assert_eq!(
        broken_tie(&[4, 9], Some(9), &twins(&[false, true], 1)),
        Some(9)
    );
    assert_eq!(
        broken_tie(&[7, 8], Some(8), &twins(&[true, false], 0)),
        Some(8)
    );
}

#[test]
fn with_two_frames_the_inactive_one_is_the_other_client() {
    assert_eq!(
        broken_tie(&[4, 9], Some(9), &twins(&[false, true], 0)),
        Some(4)
    );
    assert_eq!(
        broken_tie(&[4, 9], Some(4), &twins(&[false, true], 0)),
        Some(9)
    );
}

#[test]
fn a_third_window_leaves_the_inactive_frames_tied() {
    let three = twins(&[true, false, false], 1);
    assert_eq!(broken_tie(&[4, 9, 12], Some(4), &three), None);
    let active = twins(&[true, false, false], 0);
    assert_eq!(broken_tie(&[4, 9, 12], Some(4), &active), Some(4));
    let second_client_active = twins(&[true, false, false], 0);
    assert_eq!(
        broken_tie(&[7, 8, 9], Some(8), &second_client_active),
        Some(8)
    );
}

#[test]
fn a_client_or_a_frame_nobody_accounts_for_leaves_a_tie() {
    assert_eq!(broken_tie(&[4, 9], Some(9), &twins(&[true], 0)), None);
    assert_eq!(
        broken_tie(&[4, 9], Some(9), &twins(&[false, true, false], 1)),
        None
    );
    assert_eq!(
        broken_tie(&[7, 8, 9], Some(8), &twins(&[true, false], 1)),
        None
    );
}

#[test]
fn the_manager_must_name_one_of_the_tied_clients() {
    let pair = twins(&[false, true], 0);
    assert_eq!(broken_tie(&[4, 9], None, &pair), None);
    assert_eq!(broken_tie(&[4, 9], Some(77), &pair), None);
}

#[test]
fn exactly_one_frame_must_claim_to_be_active() {
    assert_eq!(
        broken_tie(&[4, 9], Some(9), &twins(&[false, false], 0)),
        None
    );
    assert_eq!(broken_tie(&[4, 9], Some(9), &twins(&[true, true], 0)), None);
}

#[test]
fn a_position_outside_the_frames_is_no_frame() {
    assert_eq!(
        broken_tie(&[4, 9], Some(9), &twins(&[false, true], 2)),
        None
    );
}

#[test]
fn a_unique_match_never_asks_for_the_twins() {
    let clients = [client(4, "Doc", false), client(9, "Other", false)];
    let found = client_among_twins(&frame("Doc"), &clients, Some(4), || {
        panic!("a unique match has no twins to read")
    });
    assert_eq!(found, ClientMatch::One(4));
}

#[test]
fn a_tie_is_broken_by_the_twins_and_otherwise_stays_a_tie() {
    let clients = [client(4, "Doc", false), client(9, "Doc", false)];
    let broken = client_among_twins(&frame("Doc"), &clients, Some(9), || {
        Some(twins(&[false, true], 0))
    });
    assert_eq!(broken, ClientMatch::One(4));
    let unread = client_among_twins(&frame("Doc"), &clients, Some(9), || None);
    assert_eq!(unread, ClientMatch::Several(vec![4, 9]));
    let unmanaged = client_among_twins(&frame("Doc"), &clients, None, || {
        Some(twins(&[false, true], 0))
    });
    assert_eq!(unmanaged, ClientMatch::Several(vec![4, 9]));
}

#[test]
fn tied_clients_agree_on_hidden_or_say_nothing() {
    let shown = [client(4, "Doc", false), client(9, "Doc", false)];
    assert_eq!(
        tied_agree(&shown, &[4, 9], |client| client.hidden),
        Some(false)
    );
    let hidden = [client(4, "Doc", true), client(9, "Doc", true)];
    assert_eq!(
        tied_agree(&hidden, &[4, 9], |client| client.hidden),
        Some(true)
    );
    let mixed = [client(4, "Doc", false), client(9, "Doc", true)];
    assert_eq!(tied_agree(&mixed, &[4, 9], |client| client.hidden), None);
    assert_eq!(
        tied_agree(&mixed, &[4], |client| client.hidden),
        Some(false)
    );
    assert_eq!(tied_agree(&mixed, &[], |client| client.hidden), None);
}
