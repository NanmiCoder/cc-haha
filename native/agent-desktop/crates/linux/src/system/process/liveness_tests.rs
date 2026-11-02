use super::{Identity, Liveness, identity_of, verdict};
use crate::system::process::proc_stat::ProcStat;
use crate::system::process::proc_state::ProcState;
use crate::system::process::process_facts::instance_token;

fn stat(state: ProcState, start_time: u64) -> Option<ProcStat> {
    Some(ProcStat {
        state,
        parent: 1,
        start_time,
    })
}

#[test]
fn process_liveness_and_identity_cover_every_proc_stat_verdict() {
    let expected = instance_token(9);
    for (state, start_time, wanted) in [
        (ProcState::Sleeping, 9, Liveness::Alive),
        (ProcState::Running, 9, Liveness::Alive),
        (ProcState::Other, 9, Liveness::Alive),
        (ProcState::Stopped, 9, Liveness::Stopped),
        (ProcState::Zombie, 9, Liveness::Gone),
        (ProcState::Dead, 9, Liveness::Gone),
        (ProcState::Running, 10, Liveness::Gone),
    ] {
        assert_eq!(verdict(stat(state, start_time), &expected), wanted);
    }
    assert_eq!(verdict(None, &expected), Liveness::Gone);

    for (read, wanted) in [
        (Ok(stat(ProcState::Sleeping, 9)), Identity::Same),
        (Ok(stat(ProcState::Sleeping, 10)), Identity::Replaced),
        (Ok(None), Identity::Gone),
        (Ok(stat(ProcState::Zombie, 9)), Identity::Gone),
        (Err(()), Identity::Unreadable),
    ] {
        assert_eq!(identity_of(read, &expected), wanted);
    }
}

#[cfg(target_os = "linux")]
mod live {
    use std::process::{Child, Command, Stdio};
    use std::time::{Duration, Instant};

    use super::super::{Liveness, liveness};
    use crate::system::process::process_facts;

    fn spawn_sleep() -> Child {
        Command::new("sleep")
            .arg("60")
            .stdin(Stdio::null())
            .spawn()
            .expect("sleep spawns")
    }

    fn token_of(pid: u32) -> String {
        process_facts::read(pid)
            .expect("the child is running")
            .instance
    }

    fn wait_for(pid: u32, token: &str, wanted: Liveness) -> Liveness {
        let started = Instant::now();
        loop {
            let seen = liveness(pid, token);
            if seen == wanted || started.elapsed() > Duration::from_secs(5) {
                return seen;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn a_live_process_moves_between_stopped_running_and_gone() {
        let mut child = spawn_sleep();
        let pid = child.id();
        let token = token_of(pid);
        assert_eq!(liveness(pid, &token), Liveness::Alive);
        assert_eq!(liveness(pid, "0000:1"), Liveness::Gone);
        Command::new("kill")
            .args(["-STOP", &pid.to_string()])
            .status()
            .expect("kill runs");
        assert_eq!(wait_for(pid, &token, Liveness::Stopped), Liveness::Stopped);
        Command::new("kill")
            .args(["-CONT", &pid.to_string()])
            .status()
            .expect("kill runs");
        assert_eq!(wait_for(pid, &token, Liveness::Alive), Liveness::Alive);
        Command::new("kill")
            .args(["-KILL", &pid.to_string()])
            .status()
            .expect("kill runs");
        assert_eq!(wait_for(pid, &token, Liveness::Gone), Liveness::Gone);
        assert!(
            std::path::Path::new(&format!("/proc/{pid}")).exists(),
            "the child is a zombie, not yet reaped"
        );
        let _ = child.wait();
    }
}
