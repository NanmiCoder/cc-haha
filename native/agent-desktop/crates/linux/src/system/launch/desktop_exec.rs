const FILE_CODES: [&str; 4] = ["%f", "%F", "%u", "%U"];
const WRAPPER: &str = "env";

/// What the field codes of an `Exec` line stand for. `arguments` are the
/// caller's arguments: those that start with `-` are options, the rest are
/// file operands.
pub(crate) struct ExecContext<'a> {
    pub(crate) arguments: &'a [String],
    pub(crate) icon: Option<&'a str>,
    pub(crate) name: &'a str,
    pub(crate) file: Option<&'a str>,
}

fn split_words(exec: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut started = false;
    let mut quoted = false;
    let mut chars = exec.chars();
    while let Some(c) = chars.next() {
        match (quoted, c) {
            (false, '"') => {
                quoted = true;
                started = true;
            }
            (true, '"') => quoted = false,
            (true, '\\') => match chars.next() {
                Some(next @ ('"' | '`' | '$' | '\\')) => current.push(next),
                Some(other) => {
                    current.push('\\');
                    current.push(other);
                }
                None => current.push('\\'),
            },
            (false, c) if c.is_whitespace() => {
                if started {
                    words.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            (_, c) => {
                current.push(c);
                started = true;
            }
        }
    }
    if started {
        words.push(current);
    }
    words
}

fn expand_word(word: &str, context: &ExecContext<'_>) -> String {
    let mut out = String::with_capacity(word.len());
    let mut chars = word.chars();
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('%') => out.push('%'),
            Some('c') => out.push_str(context.name),
            Some('k') => out.push_str(context.file.unwrap_or_default()),
            Some(_) | None => {}
        }
    }
    out
}

/// Turns an `Exec` line into an argument vector without a shell. The line is
/// split with the specification's quoting, field codes are replaced, deprecated
/// and unknown codes vanish, and a code never reaches a word it is embedded in
/// except `%%`, `%c` and `%k`. The caller's arguments go where the file code
/// stands, or at the end when the line has none, in the order the caller gave
/// them, so an option keeps its value and a `--` keeps its place. The one-file
/// codes `%f` and `%u` take every argument too, so none is lost.
pub(crate) fn expand(exec: &str, context: &ExecContext<'_>) -> Vec<String> {
    let mut words: Vec<String> = Vec::new();
    let mut slot = None;
    for word in split_words(exec) {
        if FILE_CODES.contains(&word.as_str()) {
            slot.get_or_insert(words.len());
        } else if word == "%i" {
            if let Some(icon) = context.icon {
                words.push("--icon".to_owned());
                words.push(icon.to_owned());
            }
        } else {
            let expanded = expand_word(&word, context);
            if !expanded.is_empty() || word.is_empty() {
                words.push(expanded);
            }
        }
    }
    let at = slot.unwrap_or(words.len());
    words.splice(at..at, context.arguments.iter().cloned());
    words
}

/// The program an `Exec` line runs: its first word, after an `env` prefix and
/// the variable assignments and options that belong to it.
pub(crate) fn program_word(exec: &str) -> Option<String> {
    let mut words = split_words(exec).into_iter().peekable();
    let wrapped = words
        .peek()
        .is_some_and(|word| word.rsplit('/').next().is_some_and(|base| base == WRAPPER));
    if wrapped {
        words.next();
        while words
            .peek()
            .is_some_and(|word| word.starts_with('-') || is_assignment(word))
        {
            words.next();
        }
    }
    words.next().filter(|word| !word.starts_with('%'))
}

fn is_assignment(word: &str) -> bool {
    word.split_once('=')
        .is_some_and(|(name, _)| !name.is_empty() && !name.contains('/') && !name.starts_with('-'))
}

#[cfg(test)]
#[path = "desktop_exec_tests.rs"]
mod tests;
