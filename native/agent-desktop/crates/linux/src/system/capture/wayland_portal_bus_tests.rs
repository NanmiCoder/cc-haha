use super::*;

#[test]
fn the_close_of_a_request_gets_its_own_time_after_the_command_deadline_expired() {
    let expired = Deadline::detached_after(1).expect("a deadline");
    std::thread::sleep(std::time::Duration::from_millis(5));
    assert!(expired.is_expired());
    let context = agent_desktop_core::CommandContext::new(None, None, false)
        .expect("a context")
        .with_inherited_deadline(expired);
    let _scope = context.command_scope("screenshot").expect("a scope");
    assert!(!close_grace().expect("a grace").is_expired());
}
