use agent_desktop_core::{AdapterError, Deadline, NotificationFilter, NotificationInfo};

use super::list::NotificationEntry;

#[cfg(test)]
#[path = "scan_tests.rs"]
mod tests;

pub(super) struct NotificationScan {
    app_filter: Option<String>,
    text_filter: Option<String>,
    limit: usize,
    index: usize,
    entries: Vec<NotificationEntry>,
    deadline: Deadline,
}

impl NotificationScan {
    pub(super) fn new(filter: &NotificationFilter, deadline: Deadline) -> Self {
        Self {
            app_filter: filter.app.as_deref().map(str::to_lowercase),
            text_filter: filter.text.as_deref().map(str::to_lowercase),
            limit: filter.limit.unwrap_or(usize::MAX),
            index: 1,
            entries: Vec::new(),
            deadline,
        }
    }

    pub(super) fn collect(
        &mut self,
        elements: &[crate::tree::AXElement],
        depth: u8,
    ) -> Result<(), AdapterError> {
        if depth > 10 || self.entries.len() >= self.limit {
            return Ok(());
        }
        for element in elements {
            if self.entries.len() >= self.limit {
                return Ok(());
            }
            let role = match super::read::string(element, "AXRole", self.deadline) {
                Ok(role) => role,
                Err(error) => {
                    tolerate_element_error(error, self.deadline)?;
                    continue;
                }
            };
            let children = match super::read::children(element, self.deadline) {
                Ok(children) => children,
                Err(error) => {
                    tolerate_element_error(error, self.deadline)?;
                    continue;
                }
            };
            if matches!(role.as_deref(), Some("AXGroup" | "AXButton")) && !children.is_empty() {
                let extracted =
                    match extract_notification(element, &children, self.index, self.deadline) {
                        Ok(info) => info,
                        Err(error) => {
                            tolerate_element_error(error, self.deadline)?;
                            None
                        }
                    };
                if let Some(info) = extracted {
                    if super::list::matches_filters(&info, &self.app_filter, &self.text_filter) {
                        self.entries.push(NotificationEntry {
                            info,
                            element: element.clone(),
                        });
                    }
                    self.index += 1;
                    continue;
                }
            }
            self.collect(&children, depth.saturating_add(1))?;
        }
        Ok(())
    }

    pub(super) fn is_full(&self) -> bool {
        self.entries.len() >= self.limit
    }

    pub(super) fn finish(self) -> Vec<NotificationEntry> {
        self.entries
    }
}

fn extract_notification(
    element: &crate::tree::AXElement,
    children: &[crate::tree::AXElement],
    index: usize,
    deadline: Deadline,
) -> Result<Option<NotificationInfo>, AdapterError> {
    let stacking_id = super::read::string(element, "AXStackingIdentifier", deadline)?;
    let subrole = super::read::string(element, "AXSubrole", deadline)?;
    let is_notification = stacking_id
        .as_deref()
        .is_some_and(|value| !value.is_empty())
        || matches!(
            subrole.as_deref(),
            Some("AXNotificationCenterAlert" | "AXNotificationCenterBanner")
        );
    if !is_notification {
        return Ok(None);
    }
    let description = super::read::string(element, "AXDescription", deadline)?;
    let mut text_values = Vec::new();
    let mut actions = Vec::new();
    for child in children {
        match super::read::string(child, "AXRole", deadline)?.as_deref() {
            Some("AXStaticText") => {
                if let Some(value) = super::read::string(child, "AXValue", deadline)?
                    && !value.is_empty()
                {
                    text_values.push(value);
                }
            }
            Some("AXButton") => {
                let identifier = super::read::string(child, "AXIdentifier", deadline)?;
                if is_notification_action(identifier.as_deref())
                    && let Some(name) = super::read::title_or_description(child, deadline)?
                    && !name.is_empty()
                {
                    actions.push(name);
                }
            }
            _ => {}
        }
    }
    let Some((app_name, title, body)) = description
        .as_deref()
        .and_then(|value| parse_row_description(value, &text_values))
    else {
        return Ok(None);
    };
    Ok(Some(NotificationInfo {
        index,
        app_name,
        title,
        body,
        actions,
    }))
}

fn parse_row_description(
    description: &str,
    text_values: &[String],
) -> Option<(String, String, Option<String>)> {
    let (field, start) = text_values
        .iter()
        .filter_map(|value| {
            description
                .find(&format!(", {value}"))
                .map(|start| (value, start))
        })
        .min_by_key(|(_, start)| *start)?;
    let app_name = description[..start].trim();
    if app_name.is_empty() {
        return None;
    }
    let remainder = description[start + field.len() + 2..].trim();
    if remainder.is_empty() {
        return Some((
            app_name.to_owned(),
            app_name.to_owned(),
            Some(field.clone()),
        ));
    }
    let body = remainder.strip_prefix(',')?.trim();
    (!body.is_empty()).then(|| (app_name.to_owned(), field.clone(), Some(body.to_owned())))
}

pub(super) fn is_notification_action(identifier: Option<&str>) -> bool {
    identifier.is_some_and(|value| value.eq_ignore_ascii_case("action_button"))
}

fn tolerate_element_error(error: AdapterError, deadline: Deadline) -> Result<(), AdapterError> {
    super::read::tolerate_ax_strategy_error(error, deadline)
}
