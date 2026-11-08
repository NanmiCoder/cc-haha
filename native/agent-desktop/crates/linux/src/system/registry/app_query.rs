use super::registry_app::RegistryApp;

pub(crate) struct AppQuery<'a> {
    pub(crate) pid: Option<u32>,
    pub(crate) select: &'a dyn Fn(&RegistryApp) -> bool,
    pub(crate) enrich: bool,
}
