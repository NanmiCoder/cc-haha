---
description: Aggregate triage / static / dynamic artefacts into a final report.md for an RE engagement
argument-hint: <sample-id>
---

Use the `re-report` skill to produce the final `report.md`.

Steps:

1. Resolve the artefact directory: use the user's `ARTIFACT_DIR` plugin
   setting if present; otherwise default to `artifacts/re-runs` relative
   to the current working directory.
2. Write the report to `<artefact-dir>/$ARGUMENTS/report.md`.
3. If `$ARGUMENTS` is empty, list existing sample-ids under the artefact
   directory and ask the user to pick one.
