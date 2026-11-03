use std::collections::VecDeque;

use agent_desktop_core::{
    ClipboardContent, ClipboardFormat, Deadline, DeliverySemantics, ErrorCode,
};

use super::*;

struct Fake {
    offered: Result<Option<Vec<String>>, Fault>,
    value: Result<Converted, Fault>,
    chunks: VecDeque<Result<Vec<u8>, Fault>>,
    pid: Option<u32>,
    asked: Vec<String>,
}

impl Fake {
    fn with(targets: &[&str], value: Converted) -> Self {
        Self {
            offered: Ok(Some(
                targets.iter().map(|name| (*name).to_owned()).collect(),
            )),
            value: Ok(value),
            chunks: VecDeque::new(),
            pid: None,
            asked: Vec::new(),
        }
    }
}

impl Requestor for Fake {
    fn offered(&mut self, _deadline: Deadline) -> Result<Option<Vec<String>>, Fault> {
        self.offered.clone()
    }

    fn request(&mut self, target: &str, _deadline: Deadline) -> Result<Converted, Fault> {
        self.asked.push(target.to_owned());
        self.value.clone()
    }

    fn next_chunk(&mut self, _deadline: Deadline) -> Result<Vec<u8>, Fault> {
        self.chunks.pop_front().unwrap_or(Err(Fault::Timeout))
    }

    fn owner_pid(&mut self) -> Option<u32> {
        self.pid
    }
}

fn deadline() -> Deadline {
    Deadline::after(1_000).expect("a deadline")
}

fn read(
    fake: &mut Fake,
    format: ClipboardFormat,
) -> Result<Option<ClipboardContent>, AdapterError> {
    read_with(fake, format, deadline())
}

fn text_of(content: Option<ClipboardContent>) -> Option<String> {
    match content {
        Some(ClipboardContent::Text(text)) => Some(text),
        _ => None,
    }
}

fn tiny_png(width: u32, height: u32) -> Vec<u8> {
    let mut data = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
    data.extend_from_slice(b"IHDR");
    data.extend_from_slice(&width.to_be_bytes());
    data.extend_from_slice(&height.to_be_bytes());
    data.extend_from_slice(&[8, 2, 0, 0, 0]);
    data.extend_from_slice(&[0; 4]);
    data
}

#[test]
fn no_owner_reads_as_absent_and_not_as_an_error() {
    let mut fake = Fake::with(&[], Converted::Refused);
    fake.offered = Ok(None);
    assert!(
        read(&mut fake, ClipboardFormat::Text)
            .expect("absent")
            .is_none()
    );
}

#[test]
fn an_owner_without_the_wanted_target_reads_as_absent() {
    let mut fake = Fake::with(&["image/png"], Converted::Value(b"x".to_vec()));
    assert!(
        read(&mut fake, ClipboardFormat::Text)
            .expect("absent")
            .is_none()
    );
    assert!(fake.asked.is_empty());
}

#[test]
fn a_refused_conversion_reads_as_absent() {
    let mut fake = Fake::with(&["UTF8_STRING"], Converted::Refused);
    assert!(
        read(&mut fake, ClipboardFormat::Text)
            .expect("absent")
            .is_none()
    );
}

#[test]
fn an_empty_text_is_a_value_distinct_from_none() {
    let mut fake = Fake::with(&["UTF8_STRING"], Converted::Value(Vec::new()));
    let content = read(&mut fake, ClipboardFormat::Text).expect("a value");
    assert_eq!(text_of(content), Some(String::new()));
}

#[test]
fn a_large_value_delivered_by_incr_in_one_kib_chunks_reassembles_byte_for_byte() {
    let data: Vec<u8> = (0..10_000u32).map(|n| b'a' + (n % 26) as u8).collect();
    let mut fake = Fake::with(&["UTF8_STRING"], Converted::Incr);
    fake.chunks = data.chunks(1024).map(|chunk| Ok(chunk.to_vec())).collect();
    fake.chunks.push_back(Ok(Vec::new()));
    let content = read(&mut fake, ClipboardFormat::Text).expect("reassembled");
    assert_eq!(text_of(content).map(String::into_bytes), Some(data));
}

#[test]
fn an_incr_transfer_whose_next_chunk_never_arrives_is_a_timeout_and_not_a_short_value() {
    let mut fake = Fake::with(&["UTF8_STRING"], Converted::Incr);
    fake.chunks = VecDeque::from([Ok(b"partial".to_vec())]);
    let error = read(&mut fake, ClipboardFormat::Text).expect_err("a stall is not a value");
    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
}

#[test]
fn an_incr_transfer_over_the_cap_stops_reading_early() {
    let big = vec![b'a'; 16 * 1024 * 1024];
    let mut fake = Fake::with(&["UTF8_STRING"], Converted::Incr);
    fake.chunks = (0..6).map(|_| Ok(big.clone())).collect();
    let error = read(&mut fake, ClipboardFormat::Text).expect_err("over the cap");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert!(error.message.contains("cap"), "{}", error.message);
    assert_eq!(fake.chunks.len(), 1, "reading must stop at the cap");
}

#[test]
fn a_single_value_over_the_cap_is_refused() {
    let value = vec![b'a'; MAX_PNG_INPUT_BYTES + 1];
    let mut fake = Fake::with(&["UTF8_STRING"], Converted::Value(value));
    let error = read(&mut fake, ClipboardFormat::Text).expect_err("over the cap");
    assert_eq!(error.code, ErrorCode::ActionFailed);
}

#[test]
fn an_owner_that_never_answers_is_a_timeout_naming_its_pid() {
    let mut fake = Fake::with(&["UTF8_STRING"], Converted::Refused);
    fake.value = Err(Fault::Timeout);
    fake.pid = Some(4242);
    let error = read(&mut fake, ClipboardFormat::Text).expect_err("a timeout");
    assert_eq!(error.code, ErrorCode::Timeout);
    let pid = error
        .details
        .as_ref()
        .and_then(|details| details.get("owner_pid"))
        .and_then(|pid| pid.as_u64());
    assert_eq!(pid, Some(4242));
}

#[test]
fn a_timeout_without_an_owner_pid_still_times_out() {
    let mut fake = Fake::with(&[], Converted::Refused);
    fake.offered = Err(Fault::Timeout);
    let error = read(&mut fake, ClipboardFormat::Text).expect_err("a timeout");
    assert_eq!(error.code, ErrorCode::Timeout);
    assert!(error.details.is_none());
}

#[test]
fn an_image_keeps_its_png_bytes_with_the_size_from_the_header() {
    let png = tiny_png(3, 5);
    let mut fake = Fake::with(&["image/png"], Converted::Value(png.clone()));
    let Some(ClipboardContent::Image(image)) =
        read(&mut fake, ClipboardFormat::Image).expect("an image")
    else {
        panic!("an image is read as an image")
    };
    assert_eq!((image.width, image.height, image.data), (3, 5, png));
    assert_eq!(image.scale_factor, 1.0);
}

#[test]
fn an_owner_offering_only_bmp_has_no_image() {
    let mut fake = Fake::with(&["image/bmp", "TARGETS"], Converted::Value(b"BM".to_vec()));
    assert!(
        read(&mut fake, ClipboardFormat::Image)
            .expect("absent")
            .is_none()
    );
}

#[test]
fn a_png_target_with_unusable_bytes_is_a_failure() {
    let mut fake = Fake::with(&["image/png"], Converted::Value(b"not a png".to_vec()));
    let error = read(&mut fake, ClipboardFormat::Image).expect_err("unusable");
    assert_eq!(error.code, ErrorCode::ActionFailed);
}

#[test]
fn invalid_utf8_is_a_failure_and_never_read_lossily() {
    let mut fake = Fake::with(&["UTF8_STRING"], Converted::Value(vec![0x66, 0xff, 0x6f]));
    let error = read(&mut fake, ClipboardFormat::Text).expect_err("strict decoding");
    assert_eq!(error.code, ErrorCode::ActionFailed);
}

#[test]
fn a_malformed_uri_list_is_a_failure() {
    let mut fake = Fake::with(
        &["text/uri-list"],
        Converted::Value(b"file:///tmp/a%zz\r\n".to_vec()),
    );
    let error = read(&mut fake, ClipboardFormat::FileUrls).expect_err("malformed");
    assert_eq!(error.code, ErrorCode::ActionFailed);
}

#[test]
fn a_uri_list_with_no_usable_entry_reads_as_absent() {
    let mut fake = Fake::with(
        &["text/uri-list"],
        Converted::Value(b"# only a comment\r\nhttp://host/x\r\n".to_vec()),
    );
    assert!(
        read(&mut fake, ClipboardFormat::FileUrls)
            .expect("absent")
            .is_none()
    );
}

#[test]
fn auto_prefers_file_paths_over_image_and_text() {
    let mut fake = Fake::with(
        &["UTF8_STRING", "image/png", "text/uri-list"],
        Converted::Value(b"file:///tmp/a\r\n".to_vec()),
    );
    let content = read(&mut fake, ClipboardFormat::Auto).expect("a value");
    assert!(matches!(content, Some(ClipboardContent::FileUrls(paths)) if paths == ["/tmp/a"]));
    assert_eq!(fake.asked, ["text/uri-list"]);
}

#[test]
fn a_refused_connection_and_an_unreachable_one_are_told_apart() {
    let denied = fault_error(Fault::Connect(MonitorFault::Denied("no".into())), None);
    let gone = fault_error(
        Fault::Connect(MonitorFault::Unreachable("gone".into())),
        None,
    );
    assert_eq!(
        denied.details.expect("cause")["display_unavailable"],
        "auth_refused"
    );
    assert_eq!(
        gone.details.expect("cause")["display_unavailable"],
        "missing"
    );
    assert_eq!(denied.code, ErrorCode::PlatformNotSupported);
    assert_eq!(gone.code, ErrorCode::PlatformNotSupported);
}
