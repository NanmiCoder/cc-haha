use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::{AdapterError, AppError, Deadline, ErrorCode};

const MAX_ATTEMPT_TIMEOUT: Duration = Duration::from_millis(500);
const POLL_INTERVAL: Duration = Duration::from_millis(100);
const MAX_RESPONSE_BYTES: usize = 64 * 1024;

/// A DevTools endpoint returned only after the caller verifies listener
/// ownership. `port` comes from launch setup; the remaining fields come from
/// a live `/json/version` response constrained to that loopback port. A direct
/// `probe` alone does not establish which process owns the listener.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CdpEndpoint {
    pub port: u16,
    pub http_endpoint: String,
    pub websocket_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub product: Option<String>,
}

/// Binds an ephemeral port to learn one the OS considers free, then releases
/// it immediately. The port is advisory until launch orchestration proves the
/// launched process owns the listener.
pub(crate) fn pick_free_port() -> Result<u16, AppError> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(bind_failed)?;
    let port = listener.local_addr().map_err(bind_failed)?.port();
    drop(listener);
    Ok(port)
}

pub(crate) fn port_is_free(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

enum Attempt {
    Verified(CdpEndpoint),
    RespondedWithoutDevtoolsBody,
    NotYetListening,
}

/// Polls `/json/version` until it answers with a parseable DevTools body or
/// the deadline runs out. An endpoint that is not yet listening is expected
/// right after launch. A responder without a parseable DevTools body keeps
/// the loop going while the app may still be starting. This is only a
/// protocol check; launch orchestration separately verifies process ownership.
pub(crate) fn probe(port: u16, deadline: Deadline) -> Result<CdpEndpoint, AppError> {
    let mut saw_responder_without_body = false;
    loop {
        let attempt_timeout = deadline.remaining().min(MAX_ATTEMPT_TIMEOUT);
        match attempt(port, attempt_timeout.max(Duration::from_millis(1))) {
            Attempt::Verified(endpoint) => return Ok(endpoint),
            Attempt::RespondedWithoutDevtoolsBody => saw_responder_without_body = true,
            Attempt::NotYetListening => {}
        }
        if deadline.is_expired() {
            return Err(unavailable(port, deadline, saw_responder_without_body));
        }
        std::thread::sleep(POLL_INTERVAL.min(deadline.remaining()));
    }
}

fn attempt(port: u16, timeout: Duration) -> Attempt {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, timeout) else {
        return Attempt::NotYetListening;
    };
    if stream.set_read_timeout(Some(timeout)).is_err()
        || stream.set_write_timeout(Some(timeout)).is_err()
    {
        return Attempt::NotYetListening;
    }
    let request = format!(
        "GET /json/version HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return Attempt::NotYetListening;
    }
    let Some(raw) = read_http_response(&mut stream, timeout) else {
        return Attempt::NotYetListening;
    };
    match parse_response(port, &raw) {
        Some(endpoint) => Attempt::Verified(endpoint),
        None => Attempt::RespondedWithoutDevtoolsBody,
    }
}

/// Chromium's DevTools server answers and then holds the connection open,
/// ignoring `Connection: close`, so reading to EOF waits for a close that
/// never comes and times out on every live endpoint. The response is done
/// once the headers' Content-Length bytes of body arrive; EOF and a
/// post-headers read timeout are accepted as a server's way of ending it.
/// The read timeout shrinks to the attempt's own remaining time on every
/// iteration, so a server that trickles a byte at a time can only ever cost
/// this attempt its allotted `timeout`, not one full read-timeout per byte.
fn read_http_response(stream: &mut TcpStream, timeout: Duration) -> Option<Vec<u8>> {
    let started = Instant::now();
    let mut raw = Vec::new();
    let mut chunk = [0_u8; 4096];
    loop {
        let elapsed = started.elapsed();
        if elapsed >= timeout || stream.set_read_timeout(Some(timeout - elapsed)).is_err() {
            break;
        }
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(received) => {
                raw.extend_from_slice(&chunk[..received]);
                if response_complete(&raw) || raw.len() > MAX_RESPONSE_BYTES {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    if raw.is_empty() { None } else { Some(raw) }
}

fn response_complete(raw: &[u8]) -> bool {
    let Some(header_end) = raw.windows(4).position(|window| window == b"\r\n\r\n") else {
        return false;
    };
    let body_received = raw.len() - (header_end + 4);
    content_length(&raw[..header_end]).is_some_and(|expected| body_received >= expected)
}

fn content_length(headers: &[u8]) -> Option<usize> {
    String::from_utf8_lossy(headers).lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.trim()
            .eq_ignore_ascii_case("content-length")
            .then(|| value.trim().parse::<usize>().ok())
            .flatten()
    })
}

fn parse_response(port: u16, raw: &[u8]) -> Option<CdpEndpoint> {
    let text = String::from_utf8_lossy(raw);
    let body = text
        .split_once("\r\n\r\n")
        .map_or("", |(_, body)| body)
        .trim();
    let parsed: serde_json::Value = serde_json::from_str(body).ok()?;
    let websocket_url = parsed
        .get("webSocketDebuggerUrl")
        .and_then(serde_json::Value::as_str)?
        .to_owned();
    if !valid_websocket_url(&websocket_url, port) {
        return None;
    }
    let product = parsed
        .get("Browser")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    Some(CdpEndpoint {
        port,
        http_endpoint: format!("http://127.0.0.1:{port}"),
        websocket_url,
        product,
    })
}

fn valid_websocket_url(value: &str, expected_port: u16) -> bool {
    let Some((scheme, rest)) = value.split_once("://") else {
        return false;
    };
    if !matches!(scheme, "ws" | "wss") {
        return false;
    }
    let Some((authority, path)) = rest.split_once('/') else {
        return false;
    };
    if path.is_empty() || authority.contains(['@', '?', '#']) {
        return false;
    }
    let Some((host, port)) = authority.rsplit_once(':') else {
        return false;
    };
    if host != "127.0.0.1" {
        return false;
    }
    port.parse::<u16>() == Ok(expected_port)
}

pub(crate) fn unattributed(port: u16) -> AppError {
    AppError::Adapter(
        AdapterError::new(
            ErrorCode::ActionFailed,
            format!("The DevTools listener on port {port} could not be attributed to the launched process"),
        )
        .with_details(serde_json::json!({
            "kind": "cdp_listener_unattributed",
            "port": port,
        }))
        .with_disposition(crate::DeliverySemantics::delivered_unverified()),
    )
}

fn bind_failed(error: std::io::Error) -> AppError {
    AppError::Adapter(
        AdapterError::new(
            ErrorCode::Internal,
            "Could not bind a local port to pick a free one",
        )
        .with_platform_detail(error.to_string()),
    )
}

fn unavailable(port: u16, deadline: Deadline, responder_without_devtools_body: bool) -> AppError {
    let mut details = serde_json::json!({
        "kind": "cdp_endpoint_unavailable",
        "port": port,
        "elapsed_ms": deadline.elapsed().as_millis(),
    });
    if responder_without_devtools_body {
        details["responder_without_devtools_body"] = serde_json::Value::Bool(true);
    }
    AppError::Adapter(
        AdapterError::new(
            ErrorCode::ActionFailed,
            format!("No DevTools endpoint answered on port {port} before the deadline"),
        )
        .with_details(details)
        .with_disposition(crate::DeliverySemantics::delivered_unverified()),
    )
}

/// Adds `extra`'s keys to `base`, favoring `extra` on collision. Used to
/// enrich a probe's error with launch-side context (pid, process instance,
/// probe budget) without discarding the probe's own message and evidence.
/// Non-object inputs pass `base` through unchanged, since there is nothing
/// sensible to merge.
pub(crate) fn merge_object_details(
    base: serde_json::Value,
    extra: serde_json::Value,
) -> serde_json::Value {
    match (base, extra) {
        (serde_json::Value::Object(mut base_map), serde_json::Value::Object(extra_map)) => {
            base_map.extend(extra_map);
            serde_json::Value::Object(base_map)
        }
        (base, _) => base,
    }
}

#[cfg(test)]
#[path = "cdp_endpoint_tests.rs"]
mod tests;
