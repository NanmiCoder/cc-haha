# Poster and group message requirements

Use the latest release markdown as the only content source. Write for WeChat group users who already use Claude Code Haha, highlighting the changes they will notice most, and avoid cramming every commit into the image.

## Visual direction: Swiss bold type

A 1080px-wide long image for vertical phone reading, chosen by the maintainer from four directions in 2026-10. Three color bands set the reading order: signal-orange first screen (product, oversized version number, release highlight) → paper body (remaining features, additional changes) → ink closing (fixes, contributors, install notes, footer). All text and avatars are drawn deterministically by the script, and height grows naturally with content.

| Role | Fixed spec |
| --- | --- |
| First screen background | Signal orange `#FF5B23`; all text on it is ink `#151515` (contrast ≥ 4.5:1) |
| Body background / extras panel | Paper `#F1F0EB` / `#E3E1D9`; body text `#3B3B38`, contrast ≥ 7:1 for both |
| Body accent | Deep orange `#A8340B`, only for numbers, ranges, and small labels on the extras panel |
| Closing background | Ink `#151515`; headings `#F1F0EB`, body `#CFCCC4` (≥ 7:1), rules `#3A3A38`; square markers, the install note frame, and the footer version number use signal orange |
| Numeral font | Version number and item numbers use a condensed black: macOS Helvetica Neue Condensed Black, falling back to Avenir Next Condensed Heavy, DejaVu Sans Condensed Bold, Arial Bold |
| Text font | Hiragino Sans GB W3/W6, falling back to STHeiti; on Linux Noto Sans CJK (Black for headings when available), on Windows Microsoft YaHei. When no black weight is available, add a 1px same-color stroke only to headings ≥ 60px; never stroke small text (it blurs) |
| Font sizes | Version number up to 400px (scaled down automatically when too wide, never below 96px); section headings 64px, first-item title 64px, item titles 44px (fixes 40px), main body 36px; extras panel and contribution notes 34px, install note 32px, labels 26–30px |
| Grid | 64px left and right margins; features section has a 160px left column for numbers and a 792px text column; 2px ink rules between items, 1px dark rules between fixes |

**First screen:** Product name top-left, "New release" top-right, the oversized version number below (without `v`), then a heavy rule followed by the `01` numeral with the "Highlight" label and the first feature. The first item must be fully readable on the phone's first screen. For a fixes-only release, the first screen instead says "Fix release · N fixes" ("1 fix" for a single fix) and goes straight into the ink fixes section.

**Body section:** Remaining features start with "New and improved" plus a number range on the right, each item with a large deep-orange number on the left. Extras use a flat light-gray panel (no rounded corners, no shadows) with three layers: label, title, body. With only one feature and no extras, there is no paper section.

**Closing section:** "Key fixes" lists each item with an orange square marker; when there are credits, "Thanks to community contributors" lists real circular avatars, full IDs, and contributions line by line; the install note is a thin orange frame with the "Install note" label on the left and text on the right; the footer is the product name + orange version number, with the repository URL right-aligned if it fits, otherwise on its own line.

**Body wrapping:** When the last line of a paragraph is shorter than 1/3 of the column width, re-flow it at a narrower measure while keeping the same number of lines, to avoid a last line with only one or two characters; other paragraphs keep the full column width.

**Forbidden:** gradients, shadows, rounded cards, emoji, neon or purple-blue "AI" palettes, fabricated UI screenshots, fake avatars, shrinking body text to fit more items. Signal orange is only for the first screen background and small markers in the ink section, never as a text color on the paper section.

## Content extraction

Usually choose 2–4 core features, up to 6 for a major release; usually at most 9 user-understandable fixes, with a hard script limit of 12. Leave missing categories empty. Keep each title short (a few words), and use one sentence to explain "what you can do now" or "how the earlier problem improved". Put the most important feature first; don't weight items evenly by commit order.

Prioritize changes group members will feel directly, and don't let internal developer fixes crowd out useful user features. Keep necessary conditions, e.g. "after enabling it in Settings", timeout options, applicable platforms, temporary status, or signing status. Important model and provider updates can be merged into one short section. Don't attribute uncredited fixes to contributors.

## Group message

Use a natural, short group-chat tone, at most three sentences; include the version number and the two most important changes, and end by pointing to the image. If this release has credited contributors, thank them for their code contributions; otherwise thank people for feedback and support. Only call contributors "group members" if the user explicitly says they are in the group. Don't copy the image's list again, don't use emoji, and don't invent download links or `@` unverified GitHub IDs.

## Output check

Open the 1080px original and a 390px-wide phone preview. Check that the first item appears on the first screen, body text is readable without zooming, long English and punctuation don't overflow, headings and body don't overlap, avatars and IDs match one-to-one, and empty categories are hidden. If the image is too long, cut secondary information first and keep the main body font size. When changing the template, compare before and after with the same spec, then verify edge cases such as features-only, fixes-only, and long contribution notes.
