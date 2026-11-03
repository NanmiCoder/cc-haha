use std::cell::RefCell;
use std::rc::Rc;

use agent_desktop_core::{ActionStep, DeliveryDisposition, StepMechanism};

use super::*;
use crate::actions::chain::chain_delivery_outcome::DeliveryOutcome;
use crate::actions::chain::chain_observed::Observed;
use crate::actions::select::unchanged_is_ignored;

struct World {
    shown: String,
    items: Vec<&'static str>,
    current_list: bool,
    open: bool,
    opens_on_click: bool,
    selects_on_commit: bool,
    escape_closes: bool,
    commit_closes: bool,
    refuse_commit: bool,
    overview: Option<bool>,
    clicks: Vec<String>,
    commits: Vec<String>,
    escapes: usize,
    overview_reads: usize,
}

impl World {
    fn dropdown() -> Rc<RefCell<World>> {
        Rc::new(RefCell::new(World {
            shown: "5 minutes".to_owned(),
            items: vec!["30 seconds", "5 minutes", "Never"],
            current_list: true,
            open: false,
            opens_on_click: true,
            selects_on_commit: true,
            escape_closes: true,
            commit_closes: true,
            refuse_commit: false,
            overview: None,
            clicks: Vec::new(),
            commits: Vec::new(),
            escapes: 0,
            overview_reads: 0,
        }))
    }
}

#[derive(Clone)]
struct Fake(Rc<RefCell<World>>);

fn element(path: &str) -> AtspiElement {
    AtspiElement::new(":1.7", path, 7)
}

impl Choices for Fake {
    fn lists(&mut self) -> Result<Vec<AtspiElement>, AdapterError> {
        let world = self.0.borrow();
        let mut lists = Vec::new();
        if world.current_list {
            lists.push(element("/current"));
        }
        if world.open {
            lists.push(element("/popup"));
        }
        Ok(lists)
    }

    fn shown(&mut self, _: &AtspiElement) -> Option<String> {
        Some(self.0.borrow().shown.clone())
    }

    fn find(
        &mut self,
        _: &AtspiElement,
        wanted: &str,
    ) -> Result<Search<AtspiElement>, AdapterError> {
        let world = self.0.borrow();
        Ok(
            match world.items.iter().find(|item| name_matches(item, wanted)) {
                Some(item) => {
                    let row = element(&format!("/item/{item}"));
                    Search::Found(Hit {
                        item: row.clone(),
                        container: None,
                        row: Some(row),
                        own: false,
                    })
                }
                None => Search::NotFound { selectable: true },
            },
        )
    }

    fn commit(
        &mut self,
        hit: &Hit<AtspiElement>,
        _: &AtspiElement,
        _: &str,
    ) -> Result<ActionResult, AdapterError> {
        let mut world = self.0.borrow_mut();
        let name = hit.item.path().trim_start_matches("/item/").to_owned();
        world.commits.push(name.clone());
        if world.refuse_commit {
            return Err(AdapterError::new(ErrorCode::ActionFailed, "refused")
                .with_disposition(DeliverySemantics::not_delivered()));
        }
        world.open = !world.commit_closes;
        if !world.selects_on_commit {
            return Err(
                unchanged_is_ignored(DeliveryOutcome::Delivered(Observed::Unchanged))
                    .expect_err("an unchanged value is ignored"),
            );
        }
        world.shown = name;
        let step = ActionStep::succeeded("Action.DoAction")
            .with_mechanism(StepMechanism::SemanticApi)
            .with_verified(true);
        Ok(ActionResult::delivered_unverified("select")
            .with_steps(vec![step])
            .with_verified_delivery())
    }

    fn overview_open(&self) -> Option<bool> {
        let mut world = self.0.borrow_mut();
        world.overview_reads += 1;
        world.overview
    }
}

impl Pointer for Fake {
    fn click(&self, target: &AtspiElement) -> Result<Vec<ActionStep>, AdapterError> {
        let mut world = self.0.borrow_mut();
        world.clicks.push(target.path().to_owned());
        world.open = world.opens_on_click;
        Ok(vec![
            ActionStep::succeeded("XTEST.click").with_mechanism(StepMechanism::PhysicalSynthetic),
        ])
    }

    fn escape(&self) -> Result<Vec<ActionStep>, AdapterError> {
        let mut world = self.0.borrow_mut();
        world.escapes += 1;
        if world.escape_closes {
            world.open = false;
        }
        Ok(Vec::new())
    }
}

fn choose_with(
    world: &Rc<RefCell<World>>,
    pointer: Option<&dyn Pointer>,
    wanted: &str,
) -> Result<ActionResult, AdapterError> {
    let deadline = Deadline::after(300).expect("a short deadline");
    choose_by_pointer(
        &mut Fake(world.clone()),
        pointer,
        &element("/combo"),
        wanted,
        deadline,
    )
}

fn choose(world: &Rc<RefCell<World>>, wanted: &str) -> Result<ActionResult, AdapterError> {
    choose_with(world, Some(&Fake(world.clone())), wanted)
}

#[test]
fn a_combo_that_already_shows_the_choice_is_not_touched() {
    let world = World::dropdown();
    let result = choose(&world, " 5 MINUTES ").expect("already shown");
    assert!(world.borrow().clicks.is_empty());
    assert!(world.borrow().commits.is_empty());
    assert_eq!(
        result.disposition().delivery(),
        DeliveryDisposition::NotDelivered
    );
}

#[test]
fn a_choice_in_the_popup_is_committed_through_the_list_and_verified_by_the_shown_value() {
    let world = World::dropdown();
    let result = choose(&world, "never").expect("selected");
    let world = world.borrow();
    assert_eq!(world.clicks, ["/combo"]);
    assert_eq!(world.commits, ["Never"]);
    assert_eq!(world.escapes, 0);
    assert_eq!(
        result.disposition().delivery(),
        DeliveryDisposition::DeliveredVerified
    );
    let labels: Vec<&str> = result.steps.iter().map(ActionStep::label).collect();
    assert_eq!(labels, ["XTEST.click", "Action.DoAction"]);
}

#[test]
fn an_absent_choice_closes_the_popup_and_is_not_found() {
    let world = World::dropdown();
    let error = choose(&world, "Sometimes").expect_err("absent");
    assert_eq!(error.code, ErrorCode::ElementNotFound);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    let world = world.borrow();
    assert_eq!(world.clicks, ["/combo"]);
    assert!(world.commits.is_empty());
    assert_eq!(world.escapes, 1);
    assert!(!world.open);
}

#[test]
fn an_absent_choice_that_leaves_the_popup_open_is_not_reported_as_untouched() {
    let world = World::dropdown();
    world.borrow_mut().escape_closes = false;
    let error = choose(&world, "Sometimes").expect_err("absent");
    assert_eq!(error.code, ErrorCode::ElementNotFound);
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
}

#[test]
fn a_commit_that_leaves_the_shown_value_unchanged_is_a_write_ignored_failure() {
    let world = World::dropdown();
    world.borrow_mut().selects_on_commit = false;
    let error = choose(&world, "Never").expect_err("ignored");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(error.details.expect("details")["cause"], "write_ignored");
    assert_eq!(world.borrow().commits, ["Never"]);
}

#[test]
fn a_popup_that_never_opens_is_reported_as_not_observed() {
    let world = World::dropdown();
    world.borrow_mut().opens_on_click = false;
    let error = choose(&world, "Never").expect_err("no popup");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(
        error.details.expect("details")["kind"],
        "popup_not_observed"
    );
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    assert_eq!(world.borrow().clicks, ["/combo"]);
}

#[test]
fn a_popup_that_never_opens_under_an_open_overview_names_the_overview() {
    let world = World::dropdown();
    world.borrow_mut().opens_on_click = false;
    world.borrow_mut().overview = Some(true);
    let error = choose(&world, "Never").expect_err("no popup");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    assert!(
        error
            .suggestion
            .as_deref()
            .is_some_and(|text| text.contains("Escape"))
    );
    let details = error.details.expect("details");
    assert_eq!(details["kind"], "popup_not_observed");
    assert_eq!(details["cause"], "overview_open");
    assert_eq!(world.borrow().overview_reads, 1);
}

#[test]
fn a_popup_that_never_opens_under_a_closed_or_unread_overview_names_no_cause() {
    for overview in [Some(false), None] {
        let world = World::dropdown();
        world.borrow_mut().opens_on_click = false;
        world.borrow_mut().overview = overview;
        let error = choose(&world, "Never").expect_err("no popup");
        assert!(error.details.expect("details").get("cause").is_none());
        assert_eq!(world.borrow().overview_reads, 1);
    }
}

#[test]
fn a_popup_that_opens_never_reads_the_overview() {
    let world = World::dropdown();
    world.borrow_mut().overview = Some(true);
    choose(&world, "Never").expect("selected");
    assert_eq!(world.borrow().overview_reads, 0);
}

#[test]
fn a_popup_that_closes_by_itself_after_the_commit_is_never_sent_an_escape() {
    let world = World::dropdown();
    choose(&world, "Never").expect("selected");
    assert_eq!(world.borrow().escapes, 0);
}

#[test]
fn a_popup_that_stays_open_after_the_commit_is_closed_with_escape() {
    let world = World::dropdown();
    world.borrow_mut().commit_closes = false;
    choose(&world, "Never").expect("selected");
    assert_eq!(world.borrow().escapes, 1);
    assert!(!world.borrow().open);
}

#[test]
fn a_commit_the_popup_refuses_closes_the_popup_and_returns_the_refusal() {
    let world = World::dropdown();
    world.borrow_mut().refuse_commit = true;
    let error = choose(&world, "Never").expect_err("refused");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(world.borrow().escapes, 1);
    assert!(!world.borrow().open);
}

#[test]
fn a_combo_with_no_list_that_shows_its_value_is_refused_before_any_click() {
    let world = World::dropdown();
    world.borrow_mut().current_list = false;
    let error = choose(&world, "Never").expect_err("no value to read");
    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    assert!(world.borrow().clicks.is_empty());
}

#[test]
fn a_headless_select_of_the_value_already_shown_is_a_no_op_and_of_another_is_refused() {
    let world = World::dropdown();
    let result = choose_with(&world, None, "5 minutes").expect("nothing to click");
    assert_eq!(
        result.disposition().delivery(),
        DeliveryDisposition::NotDelivered
    );
    let error = choose_with(&world, None, "Never").expect_err("a click is needed");
    assert_eq!(error.code, ErrorCode::PolicyDenied);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert!(world.borrow().clicks.is_empty());
}
