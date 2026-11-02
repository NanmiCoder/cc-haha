#[derive(Default)]
pub(super) enum WakeState {
    #[default]
    Quiet,
    Pending,
    Lost,
}
