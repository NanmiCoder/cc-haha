---
title: Understand an unfamiliar project in 10 minutes
nav_title: Explore a project
description: Use Plan mode to identify entry points, run commands, and important modules, then verify each claim.
order: 1
---

# Understand an unfamiliar project in 10 minutes

When you inherit a repository, ask Claude for an evidence-backed map before changing code. This guide does not require writing files.

## Before you start

- Finish [installation, model setup, and your first session](../start/first-session.md).
- Have a project folder you can read. A README, package manifest, and Git history help.

## Steps

1. Start a new session and select the project folder. Switch the composer permission control to **Plan mode**.

![New session composer with permission, project, and model controls in its toolbar (Chinese interface)](../../images/app/en/session-new.webp)

2. Send this prompt. “Evidence” means repository files and actual command output, not guesses about files it has not read.

```text
Help me understand this project using read-only investigation. Do not edit files, install dependencies, or start external services.
Read the README, project manifests, and main entry points first. Then answer:
1. What problem does it solve, and where does a user start?
2. Where does the program start? Name 3–5 important directories and their roles.
3. What are the local run and test commands? List only commands found in this repository; do not run them.
4. To change [the feature you care about], which files should I read first?
Cite file paths for every conclusion. Write “unconfirmed” where evidence is missing. End with a reading order of no more than five steps.
```

3. Open the cited paths in the **All files** tree. Check the entry points and test scripts against the answer.
4. If a claim is vague, ask: “Which file and passage supports that run command? Give the evidence without guessing.”

### Try it on this repository

If you do not have a practice project, select the cc-haha source repository and send this in Plan mode:

```text
Investigate this repository's documentation site without editing or building it. Find the page entry point, the source of long-form docs, and the local build command. Cite a file path for each conclusion.
```

You can verify three concrete results: `site/src/App.jsx` routes the homepage and documentation pages, `site/scripts/generate-docs-manifest.mjs` creates the docs index from `docs/`, and the root `package.json` offers `bun run docs:build`. Open each file to confirm it. If the model suggests a different command, ask it to cite the exact script.

## Expected result

A short project map: purpose, entry point, key directories, run and test commands found in the repo, and a reading order. **No files should change**; in a Git project, the Changed files view should match its starting state.

## Check it and unblock yourself

- Pick two claims at random and verify them in the referenced files. Run commands only after checking they make sense on your machine.
- If Claude presents a framework convention as a project fact, ask it to mark that claim as an inference and find evidence.
- No README? Start from manifests, entry points, and tests, and call out what remains unknown.

Next, practice a real edit with [Fix a bug](./fix-bug.md). [Sessions and permissions](../desktop/sessions.md) explains Plan mode and file references.
