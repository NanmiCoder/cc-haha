use super::*;

#[test]
fn a_timeout_before_the_commit_cancels_the_release_for_good() {
    let gate = ReleaseGate::default();
    assert_eq!(gate.settle(Err(Fault::Timeout)), Err(Fault::Timeout));
    assert!(!gate.commit(), "a late worker must send nothing");
}

#[test]
fn a_timeout_after_the_commit_is_an_unconfirmed_mutation() {
    let gate = ReleaseGate::default();
    assert!(gate.commit());
    assert_eq!(
        gate.settle(Err(Fault::Timeout)),
        Err(Fault::MutationUnconfirmed)
    );
}

#[test]
fn a_protocol_failure_after_the_commit_is_an_unconfirmed_mutation() {
    let gate = ReleaseGate::default();
    assert!(gate.commit());
    assert_eq!(
        gate.settle(Err(Fault::Protocol("lost".into()))),
        Err(Fault::MutationUnconfirmed)
    );
}

#[test]
fn a_finished_release_stays_a_success() {
    let gate = ReleaseGate::default();
    assert!(gate.commit());
    assert_eq!(gate.settle(Ok(())), Ok(()));
}
