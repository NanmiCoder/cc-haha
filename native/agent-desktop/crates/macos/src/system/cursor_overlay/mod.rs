mod bridge;
mod child;
mod endpoint;
mod spawn;

pub(crate) use child::entry_from_env;
pub(crate) use spawn::update;
