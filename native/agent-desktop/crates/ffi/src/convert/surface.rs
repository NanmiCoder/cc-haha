use crate::convert::string::{free_c_string, opt_string_to_c, string_to_c_lossy};
use crate::types::{AdExactSurfaceInfo, AdSnapshotSurface, AdSurfaceInfo};
use agent_desktop_core::{AdapterError, ErrorCode, SnapshotSurface, SurfaceInfo};
use std::os::raw::c_char;
use std::ptr;

pub(crate) fn surface_info_to_c(s: &SurfaceInfo) -> AdSurfaceInfo {
    AdSurfaceInfo {
        kind: string_to_c_lossy(&s.kind),
        title: opt_string_to_c(s.title.as_deref()),
        item_count: s.item_count.map(|c| c as i64).unwrap_or(-1),
    }
}

pub(crate) fn exact_surface_info_to_c(surface: &SurfaceInfo) -> AdExactSurfaceInfo {
    AdExactSurfaceInfo {
        version: crate::types::exact_surface_info::AD_EXACT_SURFACE_INFO_VERSION,
        size: crate::types::exact_surface_info::AD_EXACT_SURFACE_INFO_SIZE as u32,
        id: string_to_c_lossy(&surface.id),
        surface: surface_info_to_c(surface),
        unclassified: if surface.unclassified.is_empty() {
            ptr::null()
        } else {
            string_to_c_lossy(&surface.unclassified.join(","))
        },
    }
}

pub(crate) fn validate_surface_info(surface: &SurfaceInfo) -> Result<(), AdapterError> {
    if surface.id.is_empty() {
        return Err(AdapterError::new(
            ErrorCode::Internal,
            "Surface id is empty",
        ));
    }
    crate::resource::validate_output_string(&surface.id, "Surface id")?;
    crate::resource::validate_output_string(&surface.kind, "Surface kind")?;
    if let Some(title) = &surface.title {
        crate::resource::validate_output_string(title, "Surface title")?;
    }
    Ok(())
}

pub(crate) fn snapshot_surface_from_c(
    raw: i32,
    field: &str,
) -> Result<SnapshotSurface, AdapterError> {
    AdSnapshotSurface::from_c(raw)
        .map(|surface| match surface {
            AdSnapshotSurface::Window => SnapshotSurface::Window,
            AdSnapshotSurface::Focused => SnapshotSurface::Focused,
            AdSnapshotSurface::Menu => SnapshotSurface::Menu,
            AdSnapshotSurface::Menubar => SnapshotSurface::Menubar,
            AdSnapshotSurface::Sheet => SnapshotSurface::Sheet,
            AdSnapshotSurface::Popover => SnapshotSurface::Popover,
            AdSnapshotSurface::Alert => SnapshotSurface::Alert,
            AdSnapshotSurface::Desktop => SnapshotSurface::Desktop,
            AdSnapshotSurface::Taskbar => SnapshotSurface::Taskbar,
            AdSnapshotSurface::SystemTray => SnapshotSurface::SystemTray,
            AdSnapshotSurface::QuickSettings => SnapshotSurface::QuickSettings,
            AdSnapshotSurface::NotificationCenter => SnapshotSurface::NotificationCenter,
            AdSnapshotSurface::Toolbar => SnapshotSurface::Toolbar,
            AdSnapshotSurface::Dock => SnapshotSurface::Dock,
            AdSnapshotSurface::Spotlight => SnapshotSurface::Spotlight,
            AdSnapshotSurface::MenuBarExtras => SnapshotSurface::MenuBarExtras,
            AdSnapshotSurface::SystemTrayOverflow => SnapshotSurface::SystemTrayOverflow,
            AdSnapshotSurface::StartMenu => SnapshotSurface::StartMenu,
            AdSnapshotSurface::ActionCenter => SnapshotSurface::ActionCenter,
        })
        .ok_or_else(|| {
            AdapterError::new(
                ErrorCode::InvalidArgs,
                format!("invalid {field} discriminant"),
            )
        })
}

pub(crate) unsafe fn free_surface_info_fields(s: &mut AdSurfaceInfo) {
    unsafe {
        free_c_string(s.kind as *mut c_char);
        free_c_string(s.title as *mut c_char);
        s.kind = ptr::null();
        s.title = ptr::null();
    }
}

pub(crate) unsafe fn free_exact_surface_info_fields(surface: &mut AdExactSurfaceInfo) {
    unsafe {
        free_c_string(surface.id as *mut c_char);
        free_c_string(surface.unclassified as *mut c_char);
        free_surface_info_fields(&mut surface.surface);
        surface.id = ptr::null();
        surface.unclassified = ptr::null();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::convert::string::c_to_string;

    #[test]
    fn test_surface_info_no_title() {
        let s = SurfaceInfo {
            id: "menu-1".into(),
            kind: "menu".into(),
            title: None,
            item_count: Some(3),
            unclassified: Vec::new(),
        };
        let c = surface_info_to_c(&s);
        assert_eq!(unsafe { c_to_string(c.kind) }.as_deref(), Some("menu"));
        assert!(c.title.is_null());
        assert_eq!(c.item_count, 3);
        let mut c = c;
        unsafe { free_surface_info_fields(&mut c) };
    }

    #[test]
    fn exact_surface_info_preserves_id_and_releases_every_string() {
        let surface = SurfaceInfo {
            id: "ax-window:42".into(),
            kind: "window".into(),
            title: Some("Preferences".into()),
            item_count: Some(8),
            unclassified: Vec::new(),
        };
        let mut exact = exact_surface_info_to_c(&surface);

        assert_eq!(
            exact.version,
            crate::types::exact_surface_info::AD_EXACT_SURFACE_INFO_VERSION
        );
        assert_eq!(
            exact.size as usize,
            crate::types::exact_surface_info::AD_EXACT_SURFACE_INFO_SIZE
        );
        assert_eq!(
            unsafe { c_to_string(exact.id) }.as_deref(),
            Some("ax-window:42")
        );
        assert_eq!(
            unsafe { c_to_string(exact.surface.title) }.as_deref(),
            Some("Preferences")
        );

        assert!(exact.unclassified.is_null());
        unsafe { free_exact_surface_info_fields(&mut exact) };
        assert!(exact.id.is_null());
        assert!(exact.surface.kind.is_null());
        assert!(exact.surface.title.is_null());
    }

    #[test]
    fn exact_surface_info_names_the_kinds_its_probe_could_not_read() {
        let surface = SurfaceInfo {
            id: "w-7".into(),
            kind: "window".into(),
            title: None,
            item_count: None,
            unclassified: vec!["sheet".into(), "menu".into()],
        };
        let mut exact = exact_surface_info_to_c(&surface);

        assert_eq!(
            unsafe { c_to_string(exact.unclassified) }.as_deref(),
            Some("sheet,menu")
        );
        unsafe { free_exact_surface_info_fields(&mut exact) };
        assert!(exact.unclassified.is_null());
    }

    #[test]
    fn snapshot_surface_from_c_uses_shared_enum_validation() {
        assert_eq!(
            snapshot_surface_from_c(5, "source_surface").unwrap(),
            SnapshotSurface::Popover
        );

        let err = snapshot_surface_from_c(99, "source_surface").unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidArgs);
        assert_eq!(err.message, "invalid source_surface discriminant");
    }

    #[test]
    fn item_count_none_maps_to_sentinel_minus_one() {
        let s = SurfaceInfo {
            id: "menu-1".into(),
            kind: "menu".into(),
            title: None,
            item_count: None,
            unclassified: Vec::new(),
        };
        let c = surface_info_to_c(&s);
        assert_eq!(c.item_count, -1);
        let mut c = c;
        unsafe { free_surface_info_fields(&mut c) };
    }

    #[test]
    fn item_count_some_zero_maps_to_zero_not_to_absent_sentinel() {
        let s = SurfaceInfo {
            id: "popover-1".into(),
            kind: "popover".into(),
            title: None,
            item_count: Some(0),
            unclassified: Vec::new(),
        };
        let c = surface_info_to_c(&s);
        assert_eq!(
            c.item_count, 0,
            "Some(0) must map to 0, not to the -1 absent sentinel"
        );
        let mut c = c;
        unsafe { free_surface_info_fields(&mut c) };
    }

    #[test]
    fn title_some_maps_to_non_null_c_string_with_correct_value() {
        let s = SurfaceInfo {
            id: "sheet-1".into(),
            kind: "sheet".into(),
            title: Some("Save Panel".into()),
            item_count: None,
            unclassified: Vec::new(),
        };
        let c = surface_info_to_c(&s);
        assert!(!c.title.is_null());
        assert_eq!(
            unsafe { c_to_string(c.title) }.as_deref(),
            Some("Save Panel")
        );
        let mut c = c;
        unsafe { free_surface_info_fields(&mut c) };
    }

    #[test]
    fn snapshot_surface_from_c_maps_all_variants_exactly() {
        let cases: [(i32, SnapshotSurface); 19] = [
            (0, SnapshotSurface::Window),
            (1, SnapshotSurface::Focused),
            (2, SnapshotSurface::Menu),
            (3, SnapshotSurface::Menubar),
            (4, SnapshotSurface::Sheet),
            (5, SnapshotSurface::Popover),
            (6, SnapshotSurface::Alert),
            (7, SnapshotSurface::Desktop),
            (8, SnapshotSurface::Taskbar),
            (9, SnapshotSurface::SystemTray),
            (10, SnapshotSurface::QuickSettings),
            (11, SnapshotSurface::NotificationCenter),
            (12, SnapshotSurface::Toolbar),
            (13, SnapshotSurface::Dock),
            (14, SnapshotSurface::Spotlight),
            (15, SnapshotSurface::MenuBarExtras),
            (16, SnapshotSurface::SystemTrayOverflow),
            (17, SnapshotSurface::StartMenu),
            (18, SnapshotSurface::ActionCenter),
        ];
        for (raw, expected) in cases {
            assert_eq!(
                snapshot_surface_from_c(raw, "kind").unwrap(),
                expected,
                "raw discriminant {raw} must map to {expected:?}"
            );
        }
    }
}
