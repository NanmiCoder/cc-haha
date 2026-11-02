use std::cell::{Cell, RefCell};

use agent_desktop_core::AdapterError;

use super::{TextPort, WriteReply};
use crate::actions::chain::chain_delivery_outcome::DeliveryOutcome;
use crate::actions::chain::chain_rung::Rung;
use crate::tree::capabilities::text_selection::CaretAndSelection;
use crate::tree::capabilities::text_units::LengthUnit;

#[derive(Clone)]
pub(crate) enum Script {
    Apply,
    Absent,
    Ignore,
    Fail(AdapterError),
}

pub(crate) struct Fake {
    pub(crate) text: RefCell<Option<String>>,
    pub(crate) set: Script,
    pub(crate) delete: Script,
    pub(crate) insert: Script,
    pub(crate) landing: Option<String>,
    pub(crate) caret: Result<Option<CaretAndSelection>, AdapterError>,
    pub(crate) log: RefCell<Vec<String>>,
    pub(crate) reads: Cell<usize>,
    pub(crate) unit: LengthUnit,
}

impl Fake {
    pub(crate) fn holding(text: &str) -> Self {
        Self {
            text: RefCell::new(Some(text.to_owned())),
            set: Script::Apply,
            delete: Script::Apply,
            insert: Script::Apply,
            landing: None,
            caret: Ok(None),
            log: RefCell::new(Vec::new()),
            reads: Cell::new(0),
            unit: LengthUnit::Utf8Bytes,
        }
    }

    pub(crate) fn logged(&self) -> Vec<String> {
        self.log.borrow().clone()
    }

    fn reply(script: &Script) -> Result<(WriteReply, bool), AdapterError> {
        match script {
            Script::Apply => Ok((WriteReply::Done, true)),
            Script::Ignore => Ok((WriteReply::Done, false)),
            Script::Absent => Ok((WriteReply::Absent, false)),
            Script::Fail(error) => Err(error.clone()),
        }
    }
}

impl TextPort for Fake {
    fn length_unit(&self) -> LengthUnit {
        self.unit
    }

    fn set_contents(&self, text: &str) -> Result<WriteReply, AdapterError> {
        self.log.borrow_mut().push(format!("set({text})"));
        let (reply, applied) = Self::reply(&self.set)?;
        if applied {
            let stored = self.landing.clone().unwrap_or_else(|| text.to_owned());
            *self.text.borrow_mut() = Some(stored);
        }
        Ok(reply)
    }

    fn delete(&self, start: i32, end: i32) -> Result<WriteReply, AdapterError> {
        self.log.borrow_mut().push(format!("delete({start},{end})"));
        let (reply, applied) = Self::reply(&self.delete)?;
        if applied {
            let mut held = self.text.borrow_mut();
            if let Some(text) = held.as_mut() {
                let kept: String = text
                    .chars()
                    .enumerate()
                    .filter(|(at, _)| (*at as i32) < start || (*at as i32) >= end)
                    .map(|(_, c)| c)
                    .collect();
                *text = kept;
            }
        }
        Ok(reply)
    }

    fn insert(&self, position: i32, text: &str, length: i32) -> Result<WriteReply, AdapterError> {
        self.log
            .borrow_mut()
            .push(format!("insert({position},{length},{text})"));
        let (reply, applied) = Self::reply(&self.insert)?;
        if applied {
            let mut held = self.text.borrow_mut();
            if let Some(old) = held.as_mut() {
                let mut chars: Vec<char> = old.chars().collect();
                let at = (position as usize).min(chars.len());
                for (offset, c) in text.chars().enumerate() {
                    chars.insert(at + offset, c);
                }
                *old = chars.into_iter().collect();
            }
        }
        Ok(reply)
    }

    fn read(&self) -> Option<String> {
        self.reads.set(self.reads.get() + 1);
        self.text.borrow().clone()
    }

    fn caret(&self) -> Result<Option<CaretAndSelection>, AdapterError> {
        self.caret.clone()
    }
}

pub(crate) fn drive(
    rungs: &mut [Rung<'_>],
) -> Result<(&'static str, DeliveryOutcome), AdapterError> {
    for rung in rungs.iter_mut() {
        let outcome = (rung.run)()?;
        if outcome != DeliveryOutcome::NotDelivered {
            return Ok((rung.label, outcome));
        }
    }
    Ok(("exhausted", DeliveryOutcome::NotDelivered))
}

pub(crate) fn span(start: usize, end: usize) -> Vec<std::ops::Range<usize>> {
    std::iter::once(std::ops::Range { start, end }).collect()
}
