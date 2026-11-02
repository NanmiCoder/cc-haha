use super::*;

#[test]
fn pick_free_port_returns_a_port_that_is_immediately_bindable_again() {
    let port = pick_free_port().unwrap();

    assert!(port_is_free(port));
}

#[test]
fn port_is_free_reports_false_while_a_listener_holds_the_port_and_true_once_released() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();

    assert!(!port_is_free(port));
    drop(listener);
    assert!(port_is_free(port));
}

/// Serves a canned `/json/version` response over a real socket so the parse
/// path is exercised end to end, not just against an in-memory byte slice.
#[test]
fn probe_parses_websocket_url_and_product_from_a_live_http_response() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut buf = [0_u8; 1024];
        let received = stream.read(&mut buf).unwrap_or(0);
        let request = String::from_utf8_lossy(&buf[..received]).into_owned();
        let body = format!(
            r#"{{"Browser":"Chrome/120.0.0.0","webSocketDebuggerUrl":"ws://127.0.0.1:{port}/devtools/browser/abc"}}"#
        );
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            body
        );
        stream.write_all(response.as_bytes()).unwrap();
        request
    });

    let endpoint = probe(port, Deadline::after(2_000).unwrap()).unwrap();
    let request = server.join().unwrap();

    assert!(
        request.contains(&format!("Host: 127.0.0.1:{port}")),
        "Chromium echoes the Host header into webSocketDebuggerUrl, so the port must be in it; sent: {request}"
    );

    assert_eq!(endpoint.port, port);
    assert_eq!(endpoint.http_endpoint, format!("http://127.0.0.1:{port}"));
    assert_eq!(endpoint.product.as_deref(), Some("Chrome/120.0.0.0"));
    assert_eq!(
        endpoint.websocket_url,
        format!("ws://127.0.0.1:{port}/devtools/browser/abc")
    );
}

/// Chromium's real DevTools server never closes the connection, even when
/// asked to — the launch-blocking bug this pins was a probe that read to EOF
/// and timed out on every live endpoint. The server here answers and then
/// holds the socket open, so this test fails if the probe ever needs EOF.
#[test]
fn probe_completes_against_a_server_that_never_closes_the_connection() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut buf = [0_u8; 1024];
        let _ = stream.read(&mut buf);
        let body = format!(
            r#"{{"Browser":"Chrome/142.0.0.0","webSocketDebuggerUrl":"ws://127.0.0.1:{port}/devtools/browser/def"}}"#
        );
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            body
        );
        stream.write_all(response.as_bytes()).unwrap();
        let _ = done_rx.recv_timeout(Duration::from_secs(10));
        drop(stream);
    });

    let started = std::time::Instant::now();
    let endpoint = probe(port, Deadline::after(5_000).unwrap()).unwrap();
    let elapsed = started.elapsed();
    done_tx.send(()).unwrap();
    server.join().unwrap();

    assert!(elapsed < Duration::from_secs(2), "probe took {elapsed:?}");
    assert_eq!(endpoint.product.as_deref(), Some("Chrome/142.0.0.0"));
    assert_eq!(
        endpoint.websocket_url,
        format!("ws://127.0.0.1:{port}/devtools/browser/def")
    );
}

#[test]
fn probe_leaves_responder_flag_unset_when_no_bytes_arrive() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let started = std::time::Instant::now();

    let error = probe(port, Deadline::after(300).unwrap()).unwrap_err();

    assert!(started.elapsed() < Duration::from_secs(2));
    match error {
        AppError::Adapter(inner) => {
            assert_eq!(inner.code, ErrorCode::ActionFailed);
            assert_eq!(
                inner.details.as_ref().and_then(|d| d.get("kind")),
                Some(&serde_json::json!("cdp_endpoint_unavailable"))
            );
            assert_eq!(
                inner
                    .details
                    .as_ref()
                    .and_then(|d| d.get("responder_without_devtools_body")),
                None,
                "nothing answered at all, so the responder flag must not be set"
            );
        }
        other => panic!("expected an adapter error, got {other:?}"),
    }
}

/// A responder that answers HTTP with a body `serde_json` cannot parse into
/// `webSocketDebuggerUrl` must not be mistaken for success — the port may
/// still be settling into its DevTools state, so the probe keeps polling and
/// only reports it once the deadline runs out, with a detail flag distinguishing
/// this from a port nothing ever answered on.
#[test]
fn probe_keeps_polling_a_responder_without_a_devtools_body_and_flags_it_on_expiry() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        while let Ok((mut stream, _)) = listener.accept() {
            let mut buf = [0_u8; 1024];
            let _ = stream.read(&mut buf);
            let body = "not devtools json";
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(response.as_bytes());
        }
    });

    let error = probe(port, Deadline::after(300).unwrap()).unwrap_err();

    match error {
        AppError::Adapter(inner) => {
            assert_eq!(inner.code, ErrorCode::ActionFailed);
            assert_eq!(
                inner.details.as_ref().and_then(|d| d.get("kind")),
                Some(&serde_json::json!("cdp_endpoint_unavailable"))
            );
            assert_eq!(
                inner
                    .details
                    .as_ref()
                    .and_then(|d| d.get("responder_without_devtools_body")),
                Some(&serde_json::json!(true))
            );
        }
        other => panic!("expected an adapter error, got {other:?}"),
    }
}

#[test]
fn merge_object_details_favors_extra_on_key_collision_and_passes_through_non_objects() {
    let merged = merge_object_details(
        serde_json::json!({ "kind": "cdp_endpoint_unavailable", "port": 9001 }),
        serde_json::json!({ "pid": 42, "port": 9002 }),
    );

    assert_eq!(
        merged,
        serde_json::json!({ "kind": "cdp_endpoint_unavailable", "port": 9002, "pid": 42 })
    );

    let unchanged = merge_object_details(serde_json::json!(null), serde_json::json!({ "pid": 1 }));
    assert_eq!(unchanged, serde_json::json!(null));
}

#[test]
fn websocket_url_must_use_the_exact_loopback_port_and_websocket_scheme() {
    assert!(valid_websocket_url(
        "ws://127.0.0.1:9222/devtools/browser/id",
        9222
    ));
    for invalid in [
        "http://127.0.0.1:9222/devtools/browser/id",
        "ws://192.0.2.1:9222/devtools/browser/id",
        "ws://127.0.0.1:9223/devtools/browser/id",
        "ws://localhost:9222/devtools/browser/id",
        "ws://[::2]:9222/devtools/browser/id",
        "ws://[::1]:9222/devtools/browser/id",
        "ws://127.0.0.1/devtools/browser/id",
        "ws://user@127.0.0.1:9222/devtools/browser/id",
    ] {
        assert!(!valid_websocket_url(invalid, 9222), "accepted {invalid}");
    }
}
