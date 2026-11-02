use clap::Args;

#[derive(Args, Debug, Default)]
pub(crate) struct CursorOverlayMotionArgs {
    #[arg(
        long,
        value_name = "MIN,MAX",
        value_parser = parse_travel_ms,
        help = "Cursor travel time range in ms, short to long moves (default 90,320)"
    )]
    pub travel_ms: Option<(u64, u64)>,
    #[arg(
        long,
        value_name = "N",
        help = "Path curvature multiplier from 0 (straight) to 3 (default 1)"
    )]
    pub bow: Option<f64>,
    #[arg(
        long,
        value_name = "N",
        help = "Overshoot past the target as a fraction, 0 to 0.15 (default 0.035)"
    )]
    pub overshoot: Option<f64>,
    #[arg(
        long,
        value_name = "PX",
        help = "Hand tremor amplitude in points, 0 to 4 (default 1.1)"
    )]
    pub tremor: Option<f64>,
    #[arg(
        long,
        value_name = "N",
        help = "Pause on the target before the action runs, 0 to 300 (default 0)"
    )]
    pub dwell_ms: Option<u64>,
    #[arg(
        long,
        value_name = "N",
        help = "Vary each move deterministically from this seed"
    )]
    pub motion_seed: Option<u64>,
}

impl CursorOverlayMotionArgs {
    pub(crate) fn to_core(&self) -> agent_desktop_core::CursorMotionProfile {
        let mut motion = agent_desktop_core::CursorMotionProfile::default();
        if let Some((min, max)) = self.travel_ms {
            motion.set_travel_ms(min, max);
        }
        if let Some(bow) = self.bow {
            motion.set_bow(bow);
        }
        if let Some(overshoot) = self.overshoot {
            motion.set_overshoot(overshoot);
        }
        if let Some(tremor) = self.tremor {
            motion.set_tremor(tremor);
        }
        if let Some(dwell_ms) = self.dwell_ms {
            motion.set_dwell_ms(dwell_ms);
        }
        motion.set_seed(self.motion_seed);
        motion
    }
}

fn parse_travel_ms(value: &str) -> Result<(u64, u64), String> {
    let invalid = || "travel range must be MIN,MAX in whole milliseconds, e.g. 90,320".to_string();
    let (min, max) = value.split_once(',').ok_or_else(invalid)?;
    let min = min.trim().parse::<u64>().map_err(|_| invalid())?;
    let max = max.trim().parse::<u64>().map_err(|_| invalid())?;
    Ok((min, max))
}

#[cfg(test)]
#[path = "cursor_overlay_motion_tests.rs"]
mod tests;
