use clap::Args;
use serde::Deserialize;

#[derive(Args, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DragTargetArgs {
    #[arg(long, help = "Source element ref; requires --headed")]
    pub from: Option<String>,
    #[arg(
        long,
        name = "from-xy",
        help = "Source coordinates as x,y; requires --headed; write a negative value with = (--from-xy=-100,50)"
    )]
    pub from_xy: Option<String>,
    #[arg(long, help = "Destination element ref; requires --headed")]
    pub to: Option<String>,
    #[arg(
        long,
        name = "to-xy",
        help = "Destination coordinates as x,y; requires --headed; write a negative value with = (--to-xy=-100,50)"
    )]
    pub to_xy: Option<String>,
}
