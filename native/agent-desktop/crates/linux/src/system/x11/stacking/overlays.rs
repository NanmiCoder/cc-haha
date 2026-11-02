#[derive(Default, Debug, Clone, PartialEq, Eq)]
pub(in crate::system::x11) struct Overlays {
    pub(in crate::system::x11) bounds: Vec<crate::tree::Extents>,
    pub(in crate::system::x11) receiving: Vec<(u32, crate::tree::Extents)>,
    pub(in crate::system::x11) names: Vec<(u32, String)>,
}
