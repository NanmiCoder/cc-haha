---
description: One-shot triage on a sample — identifies file type, packing, and routes to the right RE skill
argument-hint: <path-to-sample>
---

Run a triage pass on the sample at `$ARGUMENTS`.

Steps:

1. Use the `triage` skill on the file.
2. Compute SHA-256 and use the first 12 hex chars as the sample id.
3. Resolve the artefact directory: use the user's `ARTIFACT_DIR` plugin
   setting if present; otherwise default to `artifacts/re-runs` relative
   to the current working directory.
4. Write the triage record to `<artefact-dir>/<sample-id>/triage.md`.
5. Output a one-line verdict and the recommended next skill.

Do NOT run the sample. Do NOT upload it anywhere.
