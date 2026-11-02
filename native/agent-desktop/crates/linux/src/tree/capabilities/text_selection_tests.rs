use std::ops::Range;

use agent_desktop_core::{AdapterError, ErrorCode};

use super::{
    MAX_TEXT_CHARACTERS, TEXT_INTERFACE, TextSource, selection_utf16, selection_when_readable,
};

const MIXED: &str = "a\u{1F600}e\u{301}b";

#[derive(Default)]
struct Fake {
    caret: Option<usize>,
    selections: Option<Vec<Range<usize>>>,
    count: Option<usize>,
    text: Option<String>,
    text_reads: usize,
    gone: bool,
}

impl Fake {
    fn over(text: &str, caret: usize) -> Self {
        Self {
            caret: Some(caret),
            selections: Some(Vec::new()),
            count: Some(text.chars().count()),
            text: Some(text.to_owned()),
            ..Self::default()
        }
    }
}

impl TextSource for Fake {
    fn caret(&mut self) -> Result<Option<usize>, AdapterError> {
        if self.gone {
            return Err(AdapterError::new(ErrorCode::AppNotFound, "gone"));
        }
        Ok(self.caret)
    }

    fn selections(&mut self) -> Result<Option<Vec<Range<usize>>>, AdapterError> {
        Ok(self.selections.clone())
    }

    fn character_count(&mut self) -> Result<Option<usize>, AdapterError> {
        Ok(self.count)
    }

    fn text(&mut self, _end: usize) -> Result<Option<String>, AdapterError> {
        self.text_reads += 1;
        Ok(self.text.clone())
    }
}

fn interfaces(names: &[&str]) -> Vec<String> {
    names.iter().map(|name| (*name).to_owned()).collect()
}

#[test]
fn utf16_selection_and_refusal_boundaries() {
    let mut fake = Fake::over(MIXED, 3);
    assert_eq!(selection_utf16(&mut fake).expect("answers"), Some(4..4));
    fake.selections = Some(vec![Range { start: 2, end: 1 }]);
    assert_eq!(selection_utf16(&mut fake).expect("answers"), Some(1..3));

    fake.selections = Some(Vec::new());
    fake.caret = None;
    assert_eq!(selection_utf16(&mut fake).expect("answers"), None);
    fake.caret = Some(3);
    fake.selections = None;
    assert_eq!(selection_utf16(&mut fake).expect("answers"), None);

    fake.selections = Some(Vec::new());
    fake.count = Some(MAX_TEXT_CHARACTERS + 1);
    fake.text_reads = 0;
    assert_eq!(selection_utf16(&mut fake).expect("answers"), None);
    assert_eq!(fake.text_reads, 0);
    fake.count = Some(MAX_TEXT_CHARACTERS);
    assert_eq!(selection_utf16(&mut fake).expect("answers"), Some(4..4));
    fake.caret = Some(9);
    assert_eq!(selection_utf16(&mut fake).expect("answers"), None);

    fake.gone = true;
    let error = selection_utf16(&mut fake).expect_err("a gone node is refused");
    assert_eq!(error.code, ErrorCode::AppNotFound);
    assert_eq!(error.message, "gone");

    let interfaces = interfaces(&[TEXT_INTERFACE]);
    let mut fake = Fake::over("hunter2", 7);
    assert_eq!(
        selection_when_readable(true, Some(&interfaces), &mut fake).expect("secure refusal"),
        None
    );
    assert_eq!(
        selection_when_readable(false, None, &mut fake).expect("unknown interface refusal"),
        None
    );
    assert_eq!(
        selection_when_readable(false, Some(&["org.a11y.atspi.Value".to_owned()]), &mut fake,)
            .expect("non-text interface refusal"),
        None
    );
    assert_eq!(fake.text_reads, 0);
    assert_eq!(
        selection_when_readable(false, Some(&interfaces), &mut fake).expect("answers"),
        Some(7..7)
    );
    assert!(fake.text_reads > 0);
}
