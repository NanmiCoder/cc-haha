use std::io::Write;
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::Duration;

use agent_desktop_core::{AdapterError, Deadline, SignalFilter, WaitWakeup};
use futures_lite::{future, io::AsyncReadExt};
use futures_util::StreamExt;
use zbus::{AsyncDrop, Connection, MatchRule, MessageStream, connection::Builder};

use super::wake_state::WakeState;
use crate::system::bus::classify;
use crate::system::{SharedBus, within};

type Relevant = Box<dyn Fn(&zbus::Message) -> bool + Send>;

#[derive(Default)]
struct Shared {
    state: WakeState,
    kept: Vec<zbus::Message>,
}

type Wake = Arc<(Mutex<Shared>, Condvar)>;
const QUEUE: usize = 64;
const CLEANUP: Duration = Duration::from_millis(100);

pub(crate) struct Subscription {
    wake: Wake,
    cancel: UnixStream,
    reader: Option<JoinHandle<()>>,
}

fn fault(error: impl std::fmt::Display) -> AdapterError {
    AdapterError::new(
        agent_desktop_core::ErrorCode::Internal,
        "Wait subscription was lost",
    )
    .with_platform_detail(error.to_string())
}

fn notify(wake: &Wake, state: WakeState, message: Option<zbus::Message>, keep: usize) {
    let mut held = wake.0.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(message) = message.filter(|_| held.kept.len() < keep) {
        held.kept.push(message);
    }
    if !matches!(held.state, WakeState::Lost) {
        held.state = state;
    }
    wake.1.notify_all();
}

fn from_application(message: &zbus::Message, senders: &[String]) -> bool {
    let header = message.header();
    let interface = header.interface().map(|name| name.as_str());
    let sender = header.sender().map(|name| name.as_str());
    match interface {
        Some(
            "org.a11y.atspi.Event.Object"
            | "org.a11y.atspi.Event.Window"
            | "org.a11y.atspi.Event.Focus",
        ) => sender.is_some_and(|name| {
            name.starts_with(':')
                && (senders.is_empty() || senders.iter().any(|sender| sender == name))
        }),
        Some("org.freedesktop.DBus") => {
            sender == Some("org.freedesktop.DBus")
                && header
                    .member()
                    .is_some_and(|name| name.as_str() == "NameOwnerChanged")
        }
        _ => false,
    }
}

async fn read(
    mut stream: MessageStream,
    mut cancel: async_io::Async<UnixStream>,
    wake: Wake,
    relevant: Relevant,
    keep: usize,
) {
    future::race(
        async {
            while let Some(message) = stream.next().await {
                match message {
                    Ok(message) if relevant(&message) => {
                        notify(&wake, WakeState::Pending, Some(message), keep)
                    }
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
            notify(&wake, WakeState::Lost, None, keep);
        },
        async {
            let mut byte = [0];
            let _ = cancel.read_exact(&mut byte).await;
        },
    )
    .await;
    future::race(stream.async_drop(), async {
        async_io::Timer::after(CLEANUP).await;
    })
    .await;
}

fn session(deadline: Deadline) -> Result<Connection, AdapterError> {
    within(deadline, async {
        Builder::session()
            .map_err(|error| classify(&error))?
            .build()
            .await
            .map_err(|error| classify(&error))
    })
}

impl Subscription {
    /// The one transport: a reader thread over the signals `rule` selects on
    /// `connection`, which it closes when it ends. Every signal `relevant`
    /// accepts wakes a waiter and, up to `keep` of them, is held for `take`.
    pub(crate) fn listen(
        connection: &Connection,
        rule: MatchRule<'static>,
        keep: usize,
        relevant: Relevant,
        deadline: Deadline,
    ) -> Result<Self, AdapterError> {
        let stream = within(deadline, async {
            MessageStream::for_match_rule(rule, connection, Some(QUEUE))
                .await
                .map_err(|error| classify(&error))
        })?;
        let (cancel, receiver) = UnixStream::pair().map_err(fault)?;
        let receiver = async_io::Async::new(receiver).map_err(fault)?;
        let wake = Arc::new((Mutex::new(Shared::default()), Condvar::new()));
        let reader_wake = Arc::clone(&wake);
        let connection = connection.clone();
        let reader = std::thread::Builder::new()
            .name("desktop-wakeup".into())
            .spawn(move || {
                zbus::block_on(async {
                    read(stream, receiver, reader_wake, relevant, keep).await;
                    future::race(
                        async {
                            let _ = connection.close().await;
                        },
                        async {
                            async_io::Timer::after(CLEANUP).await;
                        },
                    )
                    .await;
                });
            })
            .map_err(fault)?;
        Ok(Self {
            wake,
            cancel,
            reader: Some(reader),
        })
    }

    /// Listens on a session bus connection of its own, so ending the
    /// subscription closes nothing another caller holds.
    pub(crate) fn on_session(
        rule: MatchRule<'static>,
        keep: usize,
        relevant: Relevant,
        deadline: Deadline,
    ) -> Result<Self, AdapterError> {
        Self::listen(&session(deadline)?, rule, keep, relevant, deadline)
    }

    /// The signals held since the last call.
    pub(crate) fn take(&self) -> Vec<zbus::Message> {
        let mut held = self.wake.0.lock().unwrap_or_else(PoisonError::into_inner);
        std::mem::take(&mut held.kept)
    }

    pub(crate) fn open(
        bus: &SharedBus,
        filter: &SignalFilter,
        deadline: Deadline,
    ) -> Result<Self, AdapterError> {
        let senders = match &filter.process {
            Some(process) => {
                crate::system::registry::read_registry_for(bus, Some(process.pid.get()), deadline)?
                    .apps
                    .into_iter()
                    .filter(|app| {
                        app.root.pid() == process.pid.get()
                            && app.facts.instance == process.instance
                    })
                    .map(|app| app.root.bus_name().to_owned())
                    .collect()
            }
            None => Vec::new(),
        };
        let session = session(deadline)?;
        let connection = within(deadline, async {
            let reply = session
                .call_method(
                    Some("org.a11y.Bus"),
                    "/org/a11y/bus",
                    Some("org.a11y.Bus"),
                    "GetAddress",
                    &(),
                )
                .await
                .map_err(|error| classify(&error))?;
            let address: String = reply
                .body()
                .deserialize()
                .map_err(|error| classify(&error))?;
            Builder::address(address.as_str())
                .map_err(|error| classify(&error))?
                .build()
                .await
                .map_err(|error| classify(&error))
        })?;
        let rule = MatchRule::builder()
            .msg_type(zbus::message::Type::Signal)
            .build();
        let relevant: Relevant = {
            let senders = senders.clone();
            Box::new(move |message| from_application(message, &senders))
        };
        let subscription = Self::listen(&connection, rule, 0, relevant, deadline)?;
        within(deadline, async {
            let applications = if senders.is_empty() {
                vec![String::new()]
            } else {
                senders
            };
            for application in applications {
                for event in ["object:", "window:", "focus:"] {
                    connection
                        .call_method(
                            Some("org.a11y.atspi.Registry"),
                            "/org/a11y/atspi/registry",
                            Some("org.a11y.atspi.Registry"),
                            "RegisterEvent",
                            &(event, Vec::<String>::new(), application.as_str()),
                        )
                        .await
                        .map_err(|error| classify(&error))?;
                }
            }
            Ok(())
        })?;
        Ok(subscription)
    }
}

impl WaitWakeup for Subscription {
    fn wait(&mut self, deadline: Deadline) -> Result<(), AdapterError> {
        let mut state = self.wake.0.lock().unwrap_or_else(PoisonError::into_inner);
        while matches!(state.state, WakeState::Quiet) && !deadline.is_expired() {
            state = self
                .wake
                .1
                .wait_timeout(state, deadline.remaining())
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        match std::mem::take(&mut state.state) {
            WakeState::Lost => {
                state.state = WakeState::Lost;
                Err(fault("native event stream ended"))
            }
            WakeState::Quiet | WakeState::Pending => Ok(()),
        }
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        let _ = self.cancel.write_all(&[1]);
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

#[cfg(test)]
#[path = "subscription_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "subscription_live_tests.rs"]
mod live_tests;
