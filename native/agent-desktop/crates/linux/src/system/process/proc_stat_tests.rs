use super::{ProcState, parse};

fn stat_with(comm: &str, state: &str, start_time: u64) -> String {
    let after_state: Vec<String> = (4..=52)
        .map(|field| {
            if field == 22 {
                start_time.to_string()
            } else {
                "0".to_owned()
            }
        })
        .collect();
    format!("4242 ({comm}) {state} {}", after_state.join(" "))
}

#[test]
fn a_command_name_with_spaces_and_parentheses_does_not_shift_the_fields() {
    let stat = parse(&stat_with("(a b) c", "S", 987_654)).expect("parses");
    assert_eq!(stat.start_time, 987_654);
    assert_eq!(stat.state, ProcState::Sleeping);
}

#[test]
fn a_command_name_that_looks_like_a_state_does_not_decide_the_state() {
    let stat = parse(&stat_with("a) T (b", "S", 5)).expect("parses");
    assert_eq!(stat.state, ProcState::Sleeping);
    assert_eq!(stat.start_time, 5);
}

#[test]
fn malformed_or_short_proc_stat_records_are_rejected() {
    for line in [
        "4242 (broken S 1 2 3",
        "4242 )broken( S 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0",
        "4242 (code) S 1 2 3",
    ] {
        assert_eq!(parse(line), None, "{line}");
    }
}

#[test]
fn every_state_letter_maps_to_its_class() {
    let table = [
        ("R", ProcState::Running),
        ("S", ProcState::Sleeping),
        ("T", ProcState::Stopped),
        ("t", ProcState::Stopped),
        ("Z", ProcState::Zombie),
        ("X", ProcState::Dead),
    ];
    for (letter, class) in table {
        let stat = parse(&stat_with("x", letter, 1)).expect("parses");
        assert_eq!(stat.state, class, "{letter}");
    }
}

#[test]
fn an_unknown_state_letter_is_other_and_not_a_known_class() {
    for letter in ["Q", "K", "W"] {
        let stat = parse(&stat_with("x", letter, 1)).expect("parses");
        assert_eq!(stat.state, ProcState::Other, "{letter}");
    }
}

#[test]
fn the_parent_process_id_is_the_field_after_the_state() {
    let text = "4242 (a b) S 777 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 31 0 0";
    assert_eq!(parse(text).expect("parses").parent, 777);
}
