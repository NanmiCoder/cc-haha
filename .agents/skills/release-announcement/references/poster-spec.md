# `poster-spec.json` format

After running `scan`, fill in the JSON from the latest release note. Fields:

```json
{
  "version": "0.6.7",
  "product": "Claude Code Haha",
  "features": [
    {"title": "Side conversation", "body": "Type /btw to open a separate temporary conversation on the right without interrupting the main task."}
  ],
  "extras": [
    {"title": "Models and providers", "headline": "New models and mappings", "body": "Condense this release's notes into one sentence."}
  ],
  "fixes": [
    {"title": "Huge sessions won't open", "body": "History larger than 20MB can be opened again."}
  ],
  "contributors": [
    {"login": "example-user", "contribution": "What this person is credited with in this release"}
  ],
  "install_note": "Only fill this in when the release note explicitly includes an install reminder.",
  "footer_url": "github.com/NanmiCoder/cc-haha"
}
```

- `version`, `features`, `fixes`, and `contributors` are required; `extras`, `install_note`, and `footer_url` may be omitted. For a fixes-only release use `"features": []`; for a features-only release use `"fixes": []`; they cannot both be empty. With no credited contributors, `contributors` is `[]`.
- Choose 2–4 `features` normally, up to 6 for a major release; order them by user value. The first is drawn on the orange first screen under the "Highlight" label. Other features are a numbered single column; descriptions don't need manual line breaks. `fixes` should normally be at most 9, with a hard limit of 12; `extras` is for additional input, model, or provider changes, shown as panels in the paper section, and is not a place to dump leftover commits.
- Existing JSON works with the new template without adding style fields. Colors and font sizes are maintained centrally by the script; long titles, contribution notes, IDs, and URLs wrap automatically, and overlong English strings are split only when they exceed the available width, never truncated or elided.
- `render --scan` validates that the version and contributor IDs are explicit credit candidates in the release note. Ordinary mentions are not credits; don't put example IDs in real results.
- For tests or offline layout, contributors may be given an `avatar_path` with `--allow-offline-avatars` passed explicitly; production renders must not use this option and must verify public GitHub accounts and avatars live.
- The production image keeps every verified, credited contributor; if there are many names, shorten each contribution summary, but never drop accounts or fill slots with fake avatars.
