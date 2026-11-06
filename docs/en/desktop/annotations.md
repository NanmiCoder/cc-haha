---
title: Annotating and quoting text
nav_title: Annotations
description: Select a passage in the conversation, turn it into a note, and send several of them together.
order: 10
---

# Annotating and quoting text

When Claude writes something and you want to point at one sentence, you do not have to quote it back by hand. Select the passage in the conversation and the toolbar offers three actions. The most useful one turns it into an **annotation**: select, write a line about it, collect a few, and send them together.

## The three actions

Drag over a passage in any message and a toolbar appears next to the selection:

| Action | What it does | When to use it |
| --- | --- | --- |
| **Annotate** | Opens a small popover for a note about that passage | You know what should change and want it done that way |
| **Add to chat** | Adds just the quote to the composer, with no note | You only want the passage carried along as context |
| **Ask in side chat** | Asks about the passage in a side chat, leaving the current session alone | You want to clarify before deciding what to change |

## Writing an annotation

**Annotate** expands an editor inside the popover: the passage you selected on top, your note underneath. It takes the keyboard:

- `⌘↵` (or `Ctrl+↵` on Windows) saves.
- `Esc` cancels and leaves nothing behind.

The note cannot be empty — a note-less annotation is just a plain quote, which is what **Add to chat** already does. Until you type something, Save is disabled.

## After saving

- The passage keeps a terracotta mark in the message, with a small round badge at its end holding the annotation's number.
- A chip appears above the composer showing the same number, the quote, and your note.
- The mark does not intercept the mouse, so you can still select the same passage again.

Numbering is shared: the badge in the message, the chip above the composer, and the `[Annotation N]` blocks sent to Claude all use one sequence.

## Editing and deleting

Click the numbered badge at the end of the passage, or the chip above the composer — both open the same editor, with the existing note filled in. **Delete annotation** in its bottom-left corner removes it.

## Sending them together

Collect several annotations and send them in one go. They are submitted as their own block, each with its quote and your note, numbered exactly as the interface showed them:

````text
Annotated chat context:
[Annotation 1]
Assistant message:
```
The order is reversed.
```
Comment: Move this after the user text.
[Annotation 1 end]
````

Plain quotes with no note keep their original format; the two do not interfere.

## When an annotation disappears

An annotation is pending content — it travels with the composer's references:

- **It is consumed on send.** The mark and the chip go away together, and the annotation's full text stays in the message you sent, there to re-read.
- **The message changes.** An annotation records where in the message its text sat. If that message is later rewritten, the position no longer matches and the mark stops being drawn. The chip is unaffected — your note is never lost.

## Related

- [Sessions, permissions, and review](./sessions.md) — the whole path from asking to reviewing.
- [Workspace](./workspace.md) — the same "write a note" model, applied to line comments on a diff.
