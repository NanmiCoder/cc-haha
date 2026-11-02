use super::grab_error::GrabError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct GrabRect {
    pub(crate) x: i16,
    pub(crate) y: i16,
    pub(crate) width: u16,
    pub(crate) height: u16,
}

impl GrabRect {
    pub(crate) fn strips(self, row_bytes: usize, limit: usize) -> Result<Vec<Self>, GrabError> {
        let rows = limit / row_bytes.max(1);
        if rows == 0 {
            return Err(GrabError::Resource);
        }
        let rows = rows.min(usize::from(self.height));
        let mut strips = Vec::with_capacity(usize::from(self.height).div_ceil(rows));
        let mut done = 0usize;
        while done < usize::from(self.height) {
            let take = rows.min(usize::from(self.height) - done);
            let y =
                i16::try_from(i32::from(self.y) + done as i32).map_err(|_| GrabError::Resource)?;
            strips.push(Self {
                y,
                height: take as u16,
                ..self
            });
            done += take;
        }
        Ok(strips)
    }
}

#[cfg(test)]
#[path = "grab_rect_tests.rs"]
mod tests;
