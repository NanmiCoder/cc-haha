fn separator(left: u8, right: u8) -> bool {
    matches!(left, b'/' | b'\\') && matches!(right, b'/' | b'\\')
}

fn path_byte_eq(left: u8, right: u8) -> bool {
    separator(left, right) || left.eq_ignore_ascii_case(&right)
}

fn delimiter(character: char) -> bool {
    character.is_whitespace()
        || matches!(
            character,
            '/' | '\\' | ')' | ']' | '}' | '>' | '\'' | '"' | ';' | ',' | ':'
        )
}

fn boundary_before(text: &str, start: usize) -> bool {
    text[..start].chars().next_back().is_none_or(|character| {
        delimiter(character) || !character.is_alphanumeric() && !matches!(character, '_' | '-')
    })
}

fn boundary_after(text: &str, end: usize) -> bool {
    text[end..].chars().next().is_none_or(delimiter)
}

fn root_end(text: &str, start: usize, root: &str) -> Option<usize> {
    let folded_root = fold_path(root);
    let mut candidate = String::with_capacity(folded_root.len());
    for (offset, character) in text[start..].char_indices() {
        fold_character(character, &mut candidate);
        if !folded_root.starts_with(&candidate) {
            return None;
        }
        if candidate == folded_root {
            let end = start + offset + character.len_utf8();
            return boundary_after(text, end).then_some(end);
        }
    }
    None
}

fn fold_path(path: &str) -> String {
    let mut folded = String::with_capacity(path.len());
    for character in path.chars() {
        fold_character(character, &mut folded);
    }
    folded
}

fn fold_character(character: char, into: &mut String) {
    if matches!(character, '/' | '\\') {
        into.push('/');
    } else {
        into.extend(character.to_lowercase());
    }
}

fn user_path_end(text: &str, start: usize) -> Option<usize> {
    let prefix = text.get(start..start + 7)?;
    if !prefix
        .bytes()
        .zip(b"/users/".iter().copied())
        .all(|(left, right)| path_byte_eq(left, right))
    {
        return None;
    }
    let name_start = start + prefix.len();
    let name_end = text[name_start..]
        .find(['/', '\\'])
        .map_or(text.len(), |offset| name_start + offset);
    (name_end > name_start).then_some(name_end)
}

fn next_path(text: &str, from: usize, roots: &[&str]) -> Option<(usize, usize)> {
    for (start, _) in text.char_indices().filter(|(index, _)| *index >= from) {
        if !boundary_before(text, start) {
            continue;
        }
        if let Some(end) = roots
            .iter()
            .filter_map(|root| root_end(text, start, root))
            .max()
            .or_else(|| user_path_end(text, start))
        {
            return Some((start, end));
        }
    }
    None
}

pub(crate) fn redact_paths(text: &str, roots: &[String], placeholder: &str) -> String {
    let mut roots = roots
        .iter()
        .map(|root| root.trim_end_matches(['/', '\\']))
        .filter(|root| !root.is_empty())
        .collect::<Vec<_>>();
    roots.sort_by_key(|root| std::cmp::Reverse(root.len()));
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;
    while let Some((start, end)) = next_path(text, cursor, &roots) {
        out.push_str(&text[cursor..start]);
        out.push_str(placeholder);
        cursor = end;
    }
    out.push_str(&text[cursor..]);
    out
}

#[cfg(test)]
mod tests {
    use super::redact_paths;

    const REDACTED: &str = "<userprofile>";

    #[test]
    fn redacts_custom_roots_across_case_separator_and_token_boundaries() {
        let roots = vec![
            "D:/Profiles/Example".to_string(),
            "C:\\Users\\user".to_string(),
        ];
        let source = concat!(
            "D:\\PROFILES/example\\app.dll); D:/Profiles/Example); ",
            "D:/Profiles/Example-other/app.dll; ",
            r"\\?\c:/USERS/user\app.dll"
        );

        let result = redact_paths(source, &roots, REDACTED);

        assert_eq!(
            result,
            concat!(
                "<userprofile>\\app.dll); <userprofile>); ",
                "D:/Profiles/Example-other/app.dll; ",
                r"\\?\<userprofile>\app.dll"
            )
        );
    }

    #[test]
    fn redacts_repeated_user_folders_and_preserves_suffixed_paths() {
        let result = redact_paths(
            "C:/Users/user/app.dll); D:\\users\\username\\host.dll);",
            &[],
            REDACTED,
        );

        assert_eq!(
            result,
            "C:<userprofile>/app.dll); D:<userprofile>\\host.dll);"
        );
    }

    #[test]
    fn redacts_unknown_profile_names_with_spaces_and_apostrophes() {
        let source = format!(
            "C:/Users/{}\\App.dll; C:/Users/{}",
            "First Last", "O'Connor"
        );

        assert_eq!(
            redact_paths(&source, &[], REDACTED),
            "C:<userprofile>\\App.dll; C:<userprofile>"
        );
    }

    #[test]
    fn matches_accented_profile_roots_without_ascii_only_case_comparison() {
        let roots = vec!["D:/Profiles/Éxample".to_string()];

        assert_eq!(
            redact_paths("d:/profiles/éXAMPLE/App.dll", &roots, REDACTED),
            "<userprofile>/App.dll"
        );
    }

    #[test]
    fn keeps_anonymous_prefix_collisions_and_embedded_roots_intact() {
        let roots = vec!["D:/Profiles/Example".to_string()];
        let source = "xD:/Profiles/Example/a.dll D:/Profiles/Example-other/a.dll";

        assert_eq!(redact_paths(source, &roots, REDACTED), source);
    }
}
