use serde::{Deserialize, Serialize};

/// The renderer an application's window contents are drawn by, detected
/// best-effort from its bundle. `Chromium` covers both Electron and CEF —
/// no downstream consumer needs to tell them apart, only whether a CDP
/// client can attach to the window contents.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RendererKind {
    Chromium,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chromium_round_trips_through_the_lowercase_wire_string() {
        let wire = serde_json::to_string(&RendererKind::Chromium).unwrap();

        assert_eq!(wire, "\"chromium\"");
        assert_eq!(
            serde_json::from_str::<RendererKind>(&wire).unwrap(),
            RendererKind::Chromium
        );
    }
}
