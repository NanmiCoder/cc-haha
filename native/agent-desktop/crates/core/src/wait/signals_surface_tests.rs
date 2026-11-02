use super::*;

#[test]
fn surface_title_is_preserved_and_orders_simultaneous_events() {
    let baseline = SignalBaseline {
        completeness: crate::SignalCompleteness::complete(),
        ..Default::default()
    };
    let current = SignalBaseline {
        windows: Vec::new(),
        apps: Vec::new(),
        surfaces: vec![
            SurfaceSignal {
                kind: SnapshotSurface::Sheet,
                app: "TextEdit".into(),
                pid: crate::ProcessId::new(200),
                process_instance: "instance-200".into(),
                id: "sheet-zulu".into(),
                title: Some("Zulu".into()),
            },
            SurfaceSignal {
                kind: SnapshotSurface::Sheet,
                app: "TextEdit".into(),
                pid: crate::ProcessId::new(200),
                process_instance: "instance-200".into(),
                id: "sheet-alpha".into(),
                title: Some("Alpha".into()),
            },
        ],
        completeness: crate::SignalCompleteness::complete(),
    };

    let events = diff_signals(&baseline, &current);

    assert_eq!(events.len(), 2);
    assert_eq!(events[0].title.as_deref(), Some("Alpha"));
    assert_eq!(events[1].title.as_deref(), Some("Zulu"));

    let mut reversed = current.clone();
    reversed.surfaces.reverse();
    assert_eq!(diff_signals(&baseline, &reversed), events);
}

#[test]
fn same_named_app_instances_keep_surface_events_pid_scoped() {
    let baseline = SignalBaseline {
        completeness: crate::SignalCompleteness::complete(),
        ..Default::default()
    };
    let current = SignalBaseline {
        windows: Vec::new(),
        apps: Vec::new(),
        surfaces: vec![
            SurfaceSignal {
                kind: SnapshotSurface::Alert,
                app: "Electron".into(),
                pid: crate::ProcessId::new(202),
                process_instance: "instance-202".into(),
                id: "alert-202".into(),
                title: Some("Confirm".into()),
            },
            SurfaceSignal {
                kind: SnapshotSurface::Alert,
                app: "Electron".into(),
                pid: crate::ProcessId::new(101),
                process_instance: "instance-101".into(),
                id: "alert-101".into(),
                title: Some("Confirm".into()),
            },
        ],
        completeness: crate::SignalCompleteness::complete(),
    };

    let events = diff_signals(&baseline, &current);

    assert_eq!(events.len(), 2);
    assert_eq!(events[0].pid, Some(crate::ProcessId::new(101)));
    assert_eq!(events[1].pid, Some(crate::ProcessId::new(202)));
}

#[test]
fn event_kind_same_variant_ignores_surface_payload() {
    let requested = EventKind::parse("surface-appeared").unwrap();
    let observed = EventKind::SurfaceAppeared {
        surface: SnapshotSurface::Alert,
    };
    assert!(requested.same_variant(&observed));

    let dismissed = EventKind::SurfaceDismissed {
        surface: SnapshotSurface::Alert,
    };
    assert!(!requested.same_variant(&dismissed));
}

#[test]
fn event_kind_parse_rejects_unknown_token() {
    assert!(EventKind::parse("window_opened").is_none());
    assert!(EventKind::parse("bogus").is_none());
}
