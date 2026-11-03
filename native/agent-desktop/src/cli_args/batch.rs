use clap::Parser;

#[derive(Parser, Debug)]
pub(crate) struct BatchArgs {
    #[arg(value_name = "JSON", help = "JSON array of {command, args} objects")]
    pub commands_json: String,
    #[arg(long, help = "Halt the batch on the first failed command")]
    pub stop_on_error: bool,
    #[arg(
        long,
        default_value = "60000",
        help = "Absolute wall-clock budget for the whole non-atomic batch"
    )]
    pub timeout_ms: u64,
}
