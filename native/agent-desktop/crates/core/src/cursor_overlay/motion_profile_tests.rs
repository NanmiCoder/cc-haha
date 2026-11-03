use super::*;
use crate::{Point, Rect};

mod legacy {
    use crate::Point;

    pub(super) fn duration_ms(start: &Point, destination: &Point) -> u64 {
        let distance = (destination.x - start.x).hypot(destination.y - start.y);
        if distance < 1.5 {
            return 0;
        }
        (40.0 + 70.0 * (distance / 40.0 + 1.0).log2()).clamp(90.0, 320.0) as u64
    }

    pub(super) fn at(start: &Point, destination: &Point, t: f64) -> Point {
        let dx = destination.x - start.x;
        let dy = destination.y - start.y;
        let distance = dx.hypot(dy);
        let seed =
            (start.x.to_bits() ^ destination.y.to_bits()).rotate_left(17) ^ destination.x.to_bits();
        let bow = (0.055 * distance).min(38.0);
        let primary = jerk((t / 0.74).clamp(0.0, 1.0));
        let correction = jerk(((t - 0.62) / (1.0 - 0.62)).clamp(0.0, 1.0));
        let travelled = 1.035 * primary + (1.0 - 1.035) * correction;
        let (normal_x, normal_y) = if distance > f64::EPSILON {
            (-dy / distance, dx / distance)
        } else {
            (0.0, 0.0)
        };
        let settle = (std::f64::consts::PI * t).sin();
        let sideways =
            bow * (std::f64::consts::PI * t.powf(0.8)).sin() + 1.1 * tremor(seed, t) * settle;
        Point {
            x: start.x + dx * travelled + normal_x * sideways,
            y: start.y + dy * travelled + normal_y * sideways,
        }
    }

    fn jerk(t: f64) -> f64 {
        t * t * t * (10.0 + t * (-15.0 + 6.0 * t))
    }

    fn tremor(seed: u64, t: f64) -> f64 {
        let x = t * 7.0;
        let step = x.floor();
        let fraction = x - step;
        let low = unit_hash(seed, step as u64);
        let high = unit_hash(seed, step as u64 + 1);
        let blend = fraction * fraction * (3.0 - 2.0 * fraction);
        (low + (high - low) * blend) * 2.0 - 1.0
    }

    fn unit_hash(seed: u64, index: u64) -> f64 {
        let mut hash = seed ^ index.wrapping_mul(0x9E37_79B9_7F4A_7C15);
        hash ^= hash >> 33;
        hash = hash.wrapping_mul(0xFF51_AFD7_ED55_8CCD);
        hash ^= hash >> 33;
        (hash >> 11) as f64 / (1u64 << 53) as f64
    }
}

fn point(x: f64, y: f64) -> Point {
    Point { x, y }
}

fn profile(edit: impl FnOnce(&mut CursorMotionProfile)) -> CursorMotionProfile {
    let mut profile = CursorMotionProfile::default();
    edit(&mut profile);
    profile
}

#[test]
fn default_profile_reproduces_the_built_in_motion_bit_for_bit() {
    let start = point(37.25, 911.5);
    for distance in [0.0, 10.0, 600.0, 4_000.0] {
        let destination = point(start.x + distance * 0.8, start.y - distance * 0.6);
        let motion = CursorMotion::new(start.clone(), destination.clone());
        let shaped =
            CursorMotion::shaped(start.clone(), destination.clone(), &Default::default(), 9);
        let duration = legacy::duration_ms(&start, &destination);
        assert_eq!(motion.duration_ms(), duration);
        assert_eq!(shaped.duration_ms(), duration);
        assert_eq!(motion.total_ms(), duration);
        for elapsed in 0..=duration + 5 {
            let expected = if elapsed >= duration {
                destination.clone()
            } else {
                legacy::at(&start, &destination, elapsed as f64 / duration as f64)
            };
            assert_eq!(
                motion.sample(elapsed),
                expected,
                "{distance} px @ {elapsed} ms"
            );
            assert_eq!(
                shaped.sample(elapsed),
                expected,
                "{distance} px @ {elapsed} ms"
            );
        }
    }
}

#[test]
fn ranges_and_budget_are_enforced_at_the_boundaries() {
    let accepted = [
        profile(|p| p.set_travel_ms(30, 30)),
        profile(|p| p.set_travel_ms(400, 700)),
        profile(|p| {
            p.set_travel_ms(90, 400);
            p.set_dwell_ms(300);
        }),
        profile(|p| p.set_bow(0.0)),
        profile(|p| p.set_bow(3.0)),
        profile(|p| p.set_overshoot(0.15)),
        profile(|p| p.set_tremor(4.0)),
        profile(|p| p.set_seed(Some(u64::MAX))),
    ];
    for value in accepted {
        assert!(value.clone().validated().is_ok(), "{value:?}");
    }
    let rejected = [
        (profile(|p| p.set_travel_ms(29, 320)), "--travel-ms"),
        (profile(|p| p.set_travel_ms(321, 320)), "--travel-ms"),
        (profile(|p| p.set_travel_ms(90, 701)), "700 ms"),
        (
            profile(|p| {
                p.set_travel_ms(90, 401);
                p.set_dwell_ms(300);
            }),
            "700 ms",
        ),
        (profile(|p| p.set_dwell_ms(301)), "--dwell-ms"),
        (profile(|p| p.set_bow(-0.1)), "--bow"),
        (profile(|p| p.set_bow(3.01)), "--bow"),
        (profile(|p| p.set_bow(f64::NAN)), "--bow"),
        (profile(|p| p.set_overshoot(0.151)), "--overshoot"),
        (profile(|p| p.set_tremor(f64::INFINITY)), "--tremor"),
    ];
    for (value, flag) in rejected {
        let error = value.clone().validated().expect_err("out of range");
        assert_eq!(error.code, crate::ErrorCode::InvalidArgs);
        assert!(error.message.contains(flag), "{value:?}: {}", error.message);
    }
}

#[test]
fn travel_range_maps_short_moves_to_min_and_long_moves_to_max() {
    let tuned = profile(|p| p.set_travel_ms(200, 600));
    let short = CursorMotion::shaped(point(0.0, 0.0), point(5.0, 0.0), &tuned, 0);
    let long = CursorMotion::shaped(point(0.0, 0.0), point(5_000.0, 0.0), &tuned, 0);
    let medium = CursorMotion::shaped(point(0.0, 0.0), point(300.0, 0.0), &tuned, 0);
    assert_eq!(short.duration_ms(), 200);
    assert_eq!(long.duration_ms(), 600);
    assert!((200..600).contains(&medium.duration_ms()));
}

#[test]
fn dwell_holds_the_destination_and_delays_the_ripple() {
    let tuned = profile(|p| p.set_dwell_ms(120));
    let destination = point(640.0, 360.0);
    let motion = CursorMotion::shaped(point(0.0, 0.0), destination.clone(), &tuned, 0)
        .with_impact(true)
        .with_ripple(true);
    let travel = motion.duration_ms();
    assert_eq!(motion.dwell_ms(), 120);
    assert_eq!(motion.total_ms(), travel + 120 + 300);
    for elapsed in travel..=travel + 120 {
        assert_eq!(motion.pose(elapsed), CursorPose::still(destination.clone()));
    }
    assert!(motion.pose(travel + 121).ripple > 0.0);
    assert_eq!(motion.pose(motion.total_ms()).ripple, 1.0);
}

#[test]
fn zero_bow_and_tremor_travel_in_a_straight_line() {
    let tuned = profile(|p| {
        p.set_bow(0.0);
        p.set_tremor(0.0);
    });
    let motion = CursorMotion::shaped(point(10.0, 50.0), point(900.0, 50.0), &tuned, 0);
    for elapsed in 0..=motion.duration_ms() {
        assert_eq!(motion.sample(elapsed).y, 50.0);
    }
}

#[test]
fn zero_overshoot_never_passes_the_target() {
    let tuned = profile(|p| p.set_overshoot(0.0));
    let motion = CursorMotion::shaped(point(0.0, 0.0), point(1_000.0, 0.0), &tuned, 0);
    for elapsed in 0..=motion.duration_ms() {
        assert!(motion.sample(elapsed).x <= 1_000.0 + 1e-9);
    }
    let default = CursorMotion::new(point(0.0, 0.0), point(1_000.0, 0.0));
    assert!((0..=default.duration_ms()).any(|elapsed| default.sample(elapsed).x > 1_000.0));
}

#[test]
fn a_seed_makes_moves_repeatable_and_distinct() {
    let seeded = profile(|p| p.set_seed(Some(7)));
    let samples = |index| {
        let motion = CursorMotion::shaped(point(0.0, 0.0), point(800.0, 300.0), &seeded, index);
        (0..=motion.duration_ms())
            .map(|elapsed| motion.sample(elapsed))
            .collect::<Vec<_>>()
    };
    assert_eq!(samples(3), samples(3));
    assert_ne!(samples(3), samples(4));
    let other = profile(|p| p.set_seed(Some(8)));
    let moved = CursorMotion::shaped(point(0.0, 0.0), point(800.0, 300.0), &other, 3);
    let paths_differ = (0..moved.duration_ms().min(samples(3).len() as u64))
        .any(|elapsed| moved.sample(elapsed) != samples(3)[elapsed as usize]);
    assert!(paths_differ);
}

#[test]
fn default_motion_is_omitted_from_json_and_old_json_still_parses() {
    let config = CursorOverlayConfig::enabled(None, 6).unwrap();
    assert!(!serde_json::to_string(&config).unwrap().contains("motion"));
    let control = CursorOverlayControl::enable("s1".into(), CursorOverlayStyle::default())
        .with_motion(config.motion().clone());
    assert!(!serde_json::to_string(&control).unwrap().contains("motion"));
    let old: CursorOverlayConfig =
        serde_json::from_str(r#"{"enabled":true,"max_words":6,"style":{}}"#).unwrap();
    assert!(old.motion().is_default());
    let old: CursorOverlayControl =
        serde_json::from_str(r#"{"action":"enable","session_id":"s1","label":"hi"}"#).unwrap();
    assert_eq!(old.motion(), Some(&CursorMotionProfile::default()));
}

#[test]
fn tuned_motion_round_trips_and_unknown_motion_keys_are_rejected() {
    let tuned = profile(|p| {
        p.set_dwell_ms(80);
        p.set_seed(Some(3));
    });
    let config = CursorOverlayConfig::enabled(None, 6)
        .unwrap()
        .with_motion(tuned.clone())
        .unwrap();
    let json = serde_json::to_string(&config).unwrap();
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(value["motion"], serde_json::json!({"dwell_ms":80,"seed":3}));
    let parsed: CursorOverlayConfig = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.motion(), &tuned);
    let partial: CursorMotionProfile = serde_json::from_str(r#"{"dwell_ms":50}"#).unwrap();
    assert_eq!(partial, profile(|p| p.set_dwell_ms(50)));
    assert!(serde_json::from_str::<CursorMotionProfile>(r#"{"speed":2}"#).is_err());
    let invalid = r#"{"enabled":true,"motion":{"dwell_ms":900}}"#;
    let parsed: CursorOverlayConfig = serde_json::from_str(invalid).unwrap();
    assert!(parsed.validated().is_err());
    let control = r#"{"action":"enable","session_id":"s1","label":"hi","motion":{"bow":9}}"#;
    let control: CursorOverlayControl = serde_json::from_str(control).unwrap();
    assert!(control.validate().is_err());
}

#[test]
fn worst_case_present_fits_the_renderer_transport_limit() {
    let label = vec!["w".repeat(41); 12].join(" ");
    assert!(label.len() <= 512);
    let config = CursorOverlayConfig::enabled(Some(label), 12).unwrap();
    let motion = profile(|p| {
        p.set_travel_ms(399, 400);
        p.set_bow(2.999_999_999_999_999);
        p.set_overshoot(0.149_999_999_999_999);
        p.set_tremor(3.999_999_999_999_999);
        p.set_dwell_ms(300);
        p.set_seed(Some(u64::MAX));
    });
    let instruction =
        CursorOverlayInstruction::new(point(-12_345.678_9, 98_765.432_1), &config, true)
            .unwrap()
            .with_drag_from(Some(point(-12_345.678_9, 98_765.432_1)))
            .with_target(Some(Rect {
                x: -12_345.678_9,
                y: 98_765.432_1,
                width: 12_345.678_9,
                height: 98_765.432_1,
            }))
            .with_phase(CursorPhase::Drag);
    let control = CursorOverlayControl::present_with_style(
        "s".repeat(64),
        instruction,
        CursorOverlayStyle::default(),
    )
    .with_motion(motion.validated().unwrap())
    .with_agent_id(Some("a".repeat(64)));
    control.validate().unwrap();
    let bytes = serde_json::to_vec(&control).unwrap().len();
    assert!(bytes < 4096, "{bytes} bytes");
}

#[test]
fn an_unvalidated_profile_falls_back_to_the_default_motion() {
    let start = point(0.0, 0.0);
    let destination = point(700.0, 200.0);
    let reference = CursorMotion::new(start.clone(), destination.clone());
    for broken in [
        profile(|p| p.set_travel_ms(500, 100)),
        profile(|p| p.set_bow(f64::NAN)),
        profile(|p| p.set_tremor(f64::INFINITY)),
        profile(|p| p.set_dwell_ms(10_000)),
    ] {
        let motion = CursorMotion::shaped(start.clone(), destination.clone(), &broken, 0);
        assert_eq!(motion.duration_ms(), reference.duration_ms(), "{broken:?}");
        assert_eq!(motion.dwell_ms(), 0, "{broken:?}");
        for elapsed in 0..=motion.duration_ms() {
            assert_eq!(
                motion.sample(elapsed),
                reference.sample(elapsed),
                "{broken:?}"
            );
        }
    }
}
