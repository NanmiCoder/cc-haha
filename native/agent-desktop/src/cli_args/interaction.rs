use clap::Args;

#[derive(Args, Debug, Default)]
pub(crate) struct InteractionArgs {
    #[arg(
        long,
        global = true,
        help = "Prefer physical delivery for natural input commands and permit focus/cursor side effects. Default is strict headless semantic delivery."
    )]
    pub headed: bool,
}
