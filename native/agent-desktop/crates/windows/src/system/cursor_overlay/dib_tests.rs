use super::Dib;
use windows_sys::Win32::Graphics::Gdi::{GdiFlush, GetPixel};

/// The surface has to be exactly the size that was asked for, because both
/// callers index it by their own width and would read past the end - or paint
/// a shifted image - if the stride disagreed.
#[test]
fn the_surface_holds_exactly_the_pixels_that_were_asked_for() {
    let mut dib = Dib::create(8, 5).expect("a small surface can be made on a desktop session");

    assert_eq!(dib.pixels().len(), 40);
}

/// A refused surface must not be a partially-built one. There is no way to
/// observe a leaked DC directly from here, so what is pinned is the contract
/// the callers rely on: a refusal is `None`, not a `Dib` that is unusable.
#[test]
fn a_surface_with_no_area_is_refused_rather_than_half_made() {
    assert!(Dib::create(0, 10).is_none());
    assert!(Dib::create(10, 0).is_none());
    assert!(Dib::create(-4, 10).is_none());
}

/// The storage is the bitmap's own, so a write through the slice is what the
/// drawing calls will see. If this were a copy, the label pass would draw its
/// glyphs into a buffer nobody reads and the card would come out blank. GDI
/// reads the pixel back through the surface's own DC, which a heap copy could
/// never satisfy.
#[test]
fn writes_through_the_slice_reach_the_bitmaps_own_storage() {
    let mut dib = Dib::create(4, 4).expect("a small surface can be made on a desktop session");

    dib.pixels()[7] = 0x00AB_CDEF;

    unsafe { GdiFlush() };
    let colorref = unsafe { GetPixel(dib.dc(), 3, 1) };
    assert_eq!(
        colorref, 0x00EF_CDAB,
        "GDI must read back the pixel written through the slice (COLORREF is BGR)"
    );
    let untouched = unsafe { GetPixel(dib.dc(), 0, 0) };
    assert_eq!(untouched, 0, "only the written pixel may change");
}
