pub(crate) struct PagedPrefix<T> {
    pub(crate) elements: Vec<T>,
    pub(crate) stalled: bool,
}

pub(crate) fn read_paged_prefix<T>(
    requested: usize,
    page_size: usize,
    mut read_page: impl FnMut(usize, usize) -> Result<Vec<T>, i32>,
) -> Result<PagedPrefix<T>, i32> {
    let mut elements = Vec::with_capacity(requested);
    while elements.len() < requested {
        let page_len = (requested - elements.len()).min(page_size);
        let page = read_page(elements.len(), page_len)?;
        let returned = page.len();
        if returned > page_len {
            return Err(i32::MIN);
        }
        elements.extend(page);
        if returned == 0 {
            return Ok(PagedPrefix {
                elements,
                stalled: true,
            });
        }
    }
    Ok(PagedPrefix {
        elements,
        stalled: false,
    })
}
