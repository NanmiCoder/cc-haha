use super::motion_profile::{DEFAULT_TRAVEL_MAX_MS, DEFAULT_TRAVEL_MIN_MS};
use super::path_shape::PathShape;
use crate::Point;

const PRIMARY_SPAN: f64 = 0.74;
const CORRECTION_START: f64 = 0.62;
const BOW_RATIO: f64 = 0.055;
const MAX_BOW: f64 = 38.0;
const TREMOR_CYCLES: f64 = 7.0;
const SIDE_SALT: u64 = 0x5EED_0001;
const BOW_SALT: u64 = 0x5EED_0002;
const PACE_SALT: u64 = 0x5EED_0003;

pub(super) struct HandPath {
    start: Point,
    destination: Point,
    bow: f64,
    seed: u64,
    reach: f64,
    tremor_px: f64,
    pace: f64,
}

impl HandPath {
    pub(super) fn shaped(start: Point, destination: Point, shape: &PathShape) -> Self {
        let distance = distance_between(&start, &destination);
        let coordinate_seed =
            (start.x.to_bits() ^ destination.y.to_bits()).rotate_left(17) ^ destination.x.to_bits();
        let (seed, side, bow_factor, pace) = match shape.seed {
            None => (coordinate_seed, 1.0, 1.0, 1.0),
            Some(seed) => {
                let seed = mix(seed, shape.move_index);
                let side = if unit_hash(seed, SIDE_SALT) < 0.5 {
                    -1.0
                } else {
                    1.0
                };
                (
                    seed,
                    side,
                    0.7 + 0.6 * unit_hash(seed, BOW_SALT),
                    0.9 + 0.2 * unit_hash(seed, PACE_SALT),
                )
            }
        };
        Self {
            bow: side * bow_factor * shape.bow_scale * (BOW_RATIO * distance).min(MAX_BOW),
            start,
            destination,
            seed,
            reach: 1.0 + shape.overshoot,
            tremor_px: shape.tremor_px,
            pace,
        }
    }

    pub(super) fn destination(&self) -> Point {
        self.destination.clone()
    }

    pub(super) fn duration_ms(&self, travel: (u64, u64)) -> u64 {
        let distance = distance_between(&self.start, &self.destination);
        if distance < 1.5 {
            return 0;
        }
        let fitts_min = DEFAULT_TRAVEL_MIN_MS as f64;
        let fitts_max = DEFAULT_TRAVEL_MAX_MS as f64;
        let fitts = (40.0 + 70.0 * (distance / 40.0 + 1.0).log2()).clamp(fitts_min, fitts_max);
        let (min, max) = (travel.0 as f64, travel.1 as f64);
        let mapped = if travel == (DEFAULT_TRAVEL_MIN_MS, DEFAULT_TRAVEL_MAX_MS) {
            fitts
        } else {
            min + (fitts - fitts_min) / (fitts_max - fitts_min) * (max - min)
        };
        (mapped * self.pace).clamp(min, max) as u64
    }

    pub(super) fn at(&self, t: f64) -> Point {
        let dx = self.destination.x - self.start.x;
        let dy = self.destination.y - self.start.y;
        let distance = dx.hypot(dy);
        let travelled = self.submovements(t);
        let (normal_x, normal_y) = if distance > f64::EPSILON {
            (-dy / distance, dx / distance)
        } else {
            (0.0, 0.0)
        };
        let settle = (std::f64::consts::PI * t).sin();
        let sideways = self.bow * (std::f64::consts::PI * t.powf(0.8)).sin()
            + self.tremor_px * tremor(self.seed, t) * settle;
        Point {
            x: self.start.x + dx * travelled + normal_x * sideways,
            y: self.start.y + dy * travelled + normal_y * sideways,
        }
    }

    fn submovements(&self, t: f64) -> f64 {
        let primary = minimum_jerk((t / PRIMARY_SPAN).clamp(0.0, 1.0));
        let correction =
            minimum_jerk(((t - CORRECTION_START) / (1.0 - CORRECTION_START)).clamp(0.0, 1.0));
        self.reach * primary + (1.0 - self.reach) * correction
    }
}

fn distance_between(start: &Point, destination: &Point) -> f64 {
    (destination.x - start.x).hypot(destination.y - start.y)
}

pub(super) fn minimum_jerk(t: f64) -> f64 {
    t * t * t * (10.0 + t * (-15.0 + 6.0 * t))
}

fn tremor(seed: u64, t: f64) -> f64 {
    let x = t * TREMOR_CYCLES;
    let step = x.floor();
    let fraction = x - step;
    let low = unit_hash(seed, step as u64);
    let high = unit_hash(seed, step as u64 + 1);
    let blend = fraction * fraction * (3.0 - 2.0 * fraction);
    (low + (high - low) * blend) * 2.0 - 1.0
}

fn unit_hash(seed: u64, index: u64) -> f64 {
    (mix(seed, index) >> 11) as f64 / (1u64 << 53) as f64
}

fn mix(seed: u64, index: u64) -> u64 {
    let mut hash = seed ^ index.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    hash ^= hash >> 33;
    hash = hash.wrapping_mul(0xFF51_AFD7_ED55_8CCD);
    hash ^ (hash >> 33)
}
