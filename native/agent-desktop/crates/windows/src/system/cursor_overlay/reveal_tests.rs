use super::Reveal;

/// A card that has not been asked to appear draws in full. This is the state
/// every frame is in once nothing is changing, so getting it wrong would
/// dim the card for the rest of the session rather than for a moment.
#[test]
fn a_settled_card_is_drawn_in_full() {
    assert_eq!(Reveal::Settled.opacity(), 1.0);
    assert!(!Reveal::Settled.is_playing());
}

/// The pending state is what holds the card back while the cursor travels,
/// so it has to draw nothing at all rather than something faint.
#[test]
fn a_pending_card_is_not_drawn_until_it_begins() {
    let pending = Reveal::for_label(Some("Opening the file menu"));

    assert_eq!(pending.opacity(), 0.0);
    assert!(
        !pending.is_playing(),
        "a card that has not started is not mid-ease, or a caller would spin frames for it"
    );
}

/// A label going away has nothing to reveal, and must not leave the state
/// pending - that would hold the *next* card back behind a reveal nobody
/// started.
#[test]
fn a_label_removed_leaves_nothing_pending() {
    let removed = Reveal::for_label(None);

    assert_eq!(removed.opacity(), 1.0);
    assert!(!removed.is_playing());
}

/// Beginning is what the cursor's arrival does. Before it, the card is
/// invisible; immediately after, it is on its way and not yet complete.
#[test]
fn beginning_moves_a_pending_card_onto_its_curve() {
    let mut reveal = Reveal::for_label(Some("Click Submit"));
    assert_eq!(reveal.opacity(), 0.0);

    reveal.begin();

    assert!(reveal.is_playing(), "the ease is running once it begins");
    assert!(
        reveal.opacity() < 1.0,
        "a card that begins already complete never appears to arrive"
    );
}

/// Beginning twice must not restart the ease. The effect phase begins the
/// reveal and then draws many frames; if each frame restarted it, the card
/// would never finish appearing.
#[test]
fn beginning_again_does_not_restart_a_running_ease() {
    let mut reveal = Reveal::for_label(Some("Click Submit"));
    reveal.begin();
    let first = reveal.opacity();
    std::thread::sleep(std::time::Duration::from_millis(30));

    reveal.begin();

    assert!(
        reveal.opacity() > first,
        "the ease kept advancing across a second begin rather than resetting"
    );
}

/// Beginning a settled state is a no-op: there is no card waiting, and
/// starting one would fade in something already on screen.
#[test]
fn beginning_a_settled_card_changes_nothing() {
    let mut reveal = Reveal::Settled;

    reveal.begin();

    assert_eq!(reveal.opacity(), 1.0);
    assert!(!reveal.is_playing());
}
