use std::time::{Duration, Instant};

use agent_desktop_core::Deadline;

use crate::system::x11::control::activate::active_window_within;
use crate::system::x11::stacking::stacking_source::StackingSource;
use crate::system::x11::{DisplayReader, X11Client, X11State};

const POLL: Duration = Duration::from_millis(100);
const READ_BUDGET_MS: u64 = 3_000;

fn read_deadline() -> Deadline {
    Deadline::after(READ_BUDGET_MS).expect("the deadline builds")
}

pub(in crate::tree) fn client_of(pid: u32) -> Option<X11Client> {
    match DisplayReader.clients_within(read_deadline()) {
        X11State::Ready { clients, .. } => {
            clients.into_iter().find(|client| client.pid == Some(pid))
        }
        _ => None,
    }
}

fn viewable(client: &X11Client) -> bool {
    !client.hidden
        && client
            .bounds
            .is_some_and(|bounds| bounds.width > 0 && bounds.height > 0)
}

pub(in crate::tree) fn wait_until(what: &str, budget: Duration, mut ready: impl FnMut() -> bool) {
    let started = Instant::now();
    while !ready() {
        assert!(
            started.elapsed() < budget,
            "{what} did not happen within {budget:?}"
        );
        std::thread::sleep(POLL);
    }
}

pub(in crate::tree) fn wait_for_viewable_client(pid: u32, budget: Duration) -> X11Client {
    wait_until("the window listed, mapped and viewable", budget, || {
        client_of(pid).is_some_and(|client| viewable(&client))
    });
    client_of(pid).expect("the client stays listed")
}

pub(in crate::tree) fn active_window() -> Option<u32> {
    active_window_within(Duration::from_millis(READ_BUDGET_MS))
}

pub(in crate::tree) fn activate(client: u32) {
    let X11State::Ready { clients, .. } = DisplayReader.clients_within(read_deadline()) else {
        panic!("the private display answers");
    };
    let pid = clients
        .iter()
        .find(|window| window.id == client)
        .and_then(|window| window.pid)
        .expect("the client owner");
    let facts = crate::system::process::process_facts::read(pid).expect("the process instance");
    let owner = agent_desktop_core::ProcessIdentity::new(pid, facts.instance);
    crate::system::x11::control::control_send::activate_window(
        client,
        &owner,
        read_deadline(),
        true,
    )
    .expect("the activation request is sent");
}
