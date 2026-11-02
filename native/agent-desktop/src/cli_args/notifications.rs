use clap::Parser;
use serde::Deserialize;

#[derive(Parser, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ListNotificationsCliArgs {
    #[arg(long, help = "Filter to notifications from this app")]
    pub app: Option<String>,
    #[arg(long, help = "Filter to notifications containing this text")]
    pub text: Option<String>,
    #[arg(long, help = "Maximum number of notifications to return")]
    pub limit: Option<usize>,
}

#[derive(Parser, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DismissNotificationCliArgs {
    #[arg(value_name = "INDEX", help = "1-based notification index from list-notifications",
          value_parser = clap::value_parser!(u64).range(1..))]
    pub index: u64,
    #[arg(
        long,
        help = "Require the notification at INDEX to be from this app; INDEX is its position in the unfiltered list"
    )]
    pub app: Option<String>,
    #[arg(
        long,
        help = "Expected app name at INDEX; one expected identity field is required",
        value_name = "APP"
    )]
    pub expected_app: Option<String>,
    #[arg(
        long,
        help = "Expected title at INDEX; one expected identity field is required",
        value_name = "TITLE"
    )]
    pub expected_title: Option<String>,
}

#[derive(Parser, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DismissAllNotificationsCliArgs {
    #[arg(long, help = "Only dismiss notifications from this app")]
    pub app: Option<String>,
}

#[derive(Parser, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct NotificationActionCliArgs {
    #[arg(value_name = "INDEX", help = "1-based notification index from list-notifications",
          value_parser = clap::value_parser!(u64).range(1..))]
    pub index: u64,
    #[arg(
        value_name = "ACTION",
        help = "Name of the action button to click (e.g., Reply, Open)"
    )]
    pub action: String,
    #[arg(
        long,
        help = "Expected app name at INDEX; one expected identity field is required",
        value_name = "APP"
    )]
    pub expected_app: Option<String>,
    #[arg(
        long,
        help = "Expected title at INDEX; one expected identity field is required",
        value_name = "TITLE"
    )]
    pub expected_title: Option<String>,
}
