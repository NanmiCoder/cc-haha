use std::process::Command;
use std::time::{Duration, Instant};

use agent_desktop_core::Deadline;

use super::live_launch::Launched;
use super::live_tree::pid_frame;
use super::walker_live_tests::settle_watching;
use crate::system::SharedBus;
use crate::tree::walk::walker::walk_levels;
use crate::tree::walk::walker_expand::LevelReader;
use crate::tree::{WalkLimits, WalkedNode};

const DEADLINE_MS: u64 = 3_000;
const LEVELS_READ_BEFORE_STOP: usize = 3;
const SLACK: Duration = Duration::from_millis(1_500);

fn signal(name: &str, pid: u32) {
    let _ = Command::new("kill").args([name, &pid.to_string()]).status();
}

fn truncated_count<P>(node: &WalkedNode<P>) -> usize {
    usize::from(node.truncated) + node.children.iter().map(truncated_count).sum::<usize>()
}

fn count<P>(node: &WalkedNode<P>) -> usize {
    1 + node.children.iter().map(count).sum::<usize>()
}

/// Walks a real application that is stopped with SIGSTOP after the root level
/// was read. The next level can never be answered, so the walk has to hand
/// back the tree read so far at the deadline, not at the per-call timeout.
#[test]
#[ignore = "drives a real desktop application; run through scripts/linux-live-gate.sh"]
fn walker_live_stopped_app_returns_a_partial_walk_at_the_deadline() {
    let bus = SharedBus::default();
    let connection = bus
        .get(Deadline::standard().expect("a standard deadline builds"))
        .expect("the accessibility bus must be reachable");
    let mut launched = Launched::new();
    let pid = launched.spawn("gnome-calculator", &[]);
    let settled = settle_watching(&bus, 30, Some(pid), || pid_frame(&connection, pid))
        .unwrap_or_else(|error| panic!("calculator did not settle: {error}"));
    let full_nodes = settled.walk.node_count;

    let deadline = Deadline::after(DEADLINE_MS).expect("the deadline builds");
    let started = Instant::now();
    let mut reader = LevelReader::new(
        connection.inner(),
        &settled.frame,
        &WalkLimits::default(),
        deadline,
    );
    let mut levels_read = 0;
    let outcome = walk_levels(
        settled.frame.clone(),
        &WalkLimits::default(),
        deadline,
        |level| {
            let reads = reader.expand(level);
            levels_read += 1;
            if levels_read == LEVELS_READ_BEFORE_STOP {
                signal("-STOP", pid);
            }
            reads
        },
        crate::tree::walk::wrapper::classify,
    );
    let elapsed = started.elapsed();
    signal("-CONT", pid);

    let walk = outcome.expect("a timeout after its first levels were read keeps the partial tree");
    println!(
        "walker_live timeout: deadline={DEADLINE_MS}ms elapsed={}ms nodes={} (full walk {full_nodes}) complete={} truncated_nodes={}",
        elapsed.as_millis(),
        walk.node_count,
        walk.complete,
        truncated_count(&walk.root)
    );
    assert!(
        !walk.complete,
        "a stopped application cannot give a complete walk"
    );
    assert!(
        truncated_count(&walk.root) > 0,
        "the parents of the unread level must be marked"
    );
    assert!(
        walk.node_count > 1,
        "the levels read before the stop are kept"
    );
    assert_eq!(count(&walk.root), walk.node_count);
    assert!(walk.node_count < full_nodes);
    assert!(
        elapsed >= Duration::from_millis(DEADLINE_MS) - Duration::from_millis(200),
        "returned long before the deadline: {elapsed:?}"
    );
    assert!(
        elapsed <= Duration::from_millis(DEADLINE_MS) + SLACK,
        "overran the deadline: {elapsed:?}"
    );

    let resumed = Deadline::standard().expect("a standard deadline builds");
    let again =
        crate::tree::walk::walker::walk_tree(&bus, &settled.frame, &WalkLimits::default(), resumed)
            .expect("a resumed application is walkable again");
    println!(
        "walker_live timeout resumed: nodes={} complete={}",
        again.node_count, again.complete
    );
    assert!(again.complete);
}
