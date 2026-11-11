---
title: WeChat Integration
nav_title: WeChat
description: Scan a QR code in Settings to log in a WeChat bot account, then authorize individual users with a pairing code.
order: 3
---

# WeChat Integration

For people who only want to use WeChat: the whole setup is one QR scan, with no developer platform to register on. The trade-off is that permission approval is text replies rather than tappable buttons, and only private chats are supported.

Besides text, this path accepts transcribed voice content, images, files, and videos, and can return artifacts from the current project to WeChat.

## Bind the bot account

1. Open **Settings → IM Adapters** and select the **WeChat** tab.
2. Select **Scan to Bind**.
3. Scan the QR code with WeChat and confirm the login on your phone.
4. Wait for the status to read **WeChat is bound**.

Credentials are written to local configuration and the adapter restarts on its own; no separate save is needed. The tab then offers **Rescan** and **Unbind WeChat account**.

Binding the bot account is not the same as allowing every WeChat contact. Who may use it is decided in the next step.

## Authorize a user

1. Back at the top of the page, under **Pairing**, select **Generate Code**.
2. Send the six-character code to the bound bot in WeChat.
3. Once pairing is confirmed, you can send messages directly.

Codes are valid for 60 minutes, work once, and are invalidated when a new one is generated.

Known WeChat user IDs can instead be entered in **Allowed Users**, separated by commas. That suits a fixed allowlist but is less convenient than pairing.

## Projects and sessions

With **Default Project** set, the first accepted message opens a session in that directory. Without it, the bot lists recent projects; reply with a number, project name, or absolute path.

Later messages in the same chat reuse that session, and the mapping survives a Desktop restart. `/new` picks another project; `/clear` empties the context while keeping the project binding.

## Commands

WeChat has no configurable menu, so the chat box is the only entry point. After pairing, the bot suggests `/help`.

- `/help` or `帮助` — show available commands
- `/status` or `状态` — project, branch, model, run state, and task summary
- `/projects` or `项目列表` — list recent projects again
- `/new` or `新会话` — clear the current binding and choose a project
- `/new <number, project name, or absolute path>` — start directly in that project
- `/clear` or `清空` — clear context, keep the project binding
- `/stop` or `停止` — stop the current generation
- `/send <project path>` — return an image, video, or file; quote paths containing spaces
- `/transcode <project video path>` — convert to a compatible MP4 and return it, up to 120 seconds
- `/voice on`, `/voice off` — toggle audio-file replies; preferences persist for the bound account and user across restarts
- `/voice list`, `/voice select <number|auto>` — list installed voices and choose one or restore automatic selection
- `/speak <text>` — synthesize the supplied text as a WAV file on Windows
- `/delivery` — inspect pending, failed, and uncertain deliveries
- `/retry <reply ID>` — explicitly resend a recorded text reply after checking it was not received

## Returning images, files, and videos

For example, `/send reports/result.pdf` reads the file from the active session's project and sends it as a WeChat attachment. Files are limited to 30 MiB and images to 10 MiB. Files outside the active project, missing paths, directories, and links escaping the project are rejected.

Local Markdown images in assistant replies are returned automatically. Other deliverables require explicit `file:` download links, for example `[Report](file:///C:/project/report.pdf)`. Ordinary source citations and web links are not uploaded. Automatic delivery is limited to five items and 30 MiB per reply; use `/send` for additional files.

Recognized MP4 files use video messages; other formats are sent as files. This version does not automatically transcode. Failed uploads or sends are not automatically repeated because delivery may be uncertain. Check whether WeChat received the attachment before retrying with `/send`.

For a compatible format, explicitly send `/transcode videos/example.avi`. Local FFmpeg converts it to H.264/AAC MP4, checks duration and audio preservation, and rejects truncated results. Input and output are limited to 30 MiB; input duration is limited to 120 seconds.

## Video analysis

An incoming video is downloaded as an attachment and sampled into at most 12 timestamped frames. Its audio track, if present, is transcribed using the desktop's prepared speech recognizer. Visual analysis requires an image-capable model. If speech recognition is unavailable, the reply explicitly describes the visual-only coverage; sampled analysis does not inspect every frame.

Analysis is limited to 30 MiB, 120 seconds, and one video per message. Longer clips or missing dependencies keep the original attachment and produce an explanation instead of silently truncating the analysis. Each message accepts up to five attachments totaling 30 MiB.

Install or provide executable `ffmpeg` and `ffprobe` on PATH, or set `WECHAT_FFMPEG_PATH` and `WECHAT_FFPROBE_PATH` to their full paths in the environment used to start cc-haha. The app does not download them automatically. Prepare the recognizer through desktop voice settings.

## Audio replies

After `/voice on`, completed answers also produce audio files. `/speak Hello, this is a voice test` tests synthesis directly. This implementation uses installed Windows speech components and requires no additional cloud speech API key. Chinese uses a Windows Chinese voice; other text uses System.Speech. Missing speech components or PowerShell produce an actionable error.

The result is a downloadable WAV file, **not a native WeChat voice bubble**. Synthesis accepts up to 2,000 characters and 10 MiB; code blocks are not spoken. Ask for a shorter summary before synthesizing a long answer. Text replies remain available if synthesis fails. This local synthesis implementation currently supports Windows only.

`/stop` cancels media processing and the current generation; messages already sent cannot be recalled.

## Connection state and restart recovery

Account binding and channel health are shown separately. Connection details show online, reconnecting, expired authentication, or stale status, together with recent receive/send times. Binding alone does not prove connectivity. Reconnect reuses saved credentials and restarts only WeChat; scan again only when authentication must be renewed.

The receive cursor and authorized pending messages are saved together. Unstarted messages can resume after restart. Submitted tasks without a confirmed result are not automatically rerun: inspect the desktop conversation first. Unauthorized message bodies and pairing codes are not stored as recoverable tasks.

Text chunks and attachment delivery states are recorded. A timeout may mean the phone already received the message, so no blind resend occurs. Use `/delivery` to inspect records, then `/retry <reply ID>` for a missing text reply without rerunning AI. Media processing and uploads cannot yet resume across restarts; use `/send` or start processing again.

Successful records normally expire after 24 hours; failed or uncertain records expire after seven days. Active work is not evicted to make space. When journaling fails, the receive cursor does not advance and connection health reports a failure. Recovery does not guarantee exactly-once delivery or execution.

## Approval and reply behavior

A permission request arrives as text. With one pending request, the footer only shows numeric choices: `1` to allow once, `2` to always allow, and `3` to deny. Long ID commands are not repeated.

With multiple pending requests, the prompt shows commands containing the request ID; numeric replies do not approve any request. Use one of the commands from the relevant prompt:

- `/allow <requestId>` — allow once
- `/always <requestId>` — persist the matching approval
- `/deny <requestId>` — deny

Messages are received through long polling and long replies are split into platform-sized messages. A typing indicator is shown while Claude thinks or runs tools. Images enter model input inline; other files are downloaded to a local temporary path. Oversized attachments are reported back in the chat.

## Unbind

Two levels:

- **Unbind WeChat account** clears the bot credentials and this platform's authorization lists. Binding again means scanning again.
- **Unbind** next to a name under **Paired Users** revokes only that person. They need a fresh pairing code afterwards.

## Development

Packaged Desktop starts the sidecar automatically. Run it by hand only when working from source:

```bash
cd adapters
bun install
bun run wechat
```

Optional overrides:

```bash
export WECHAT_ACCOUNT_ID="..."
export WECHAT_BOT_TOKEN="..."
export WECHAT_BASE_URL="https://ilinkai.weixin.qq.com"
export WECHAT_USER_ID="..."
export ADAPTER_SERVER_URL="ws://127.0.0.1:3456"
```

Normal Desktop use needs none of these; QR binding writes the local configuration.

## Troubleshooting

**Still unauthorized after a successful scan.** That is the expected flow. Scanning only stores bot credentials; the individual user still has to send a pairing code or appear in **Allowed Users**.

**The QR code expired.** Select **Scan to Bind** again. WeChat login QR codes are short-lived.

**The adapter reports a missing WeChat account.** Neither the environment variables nor `wechat.accountId` / `wechat.botToken` in `~/.claude/adapters.json` took effect. Complete QR binding in Settings first.

**No replies.** Confirm Desktop is running, the tab reads **WeChat is bound**, the sender is paired or allowlisted, and `~/.claude/adapters.json` is writable. When running from source, also confirm `ADAPTER_SERVER_URL` points at the running Desktop server.

**Session not restored after a restart.** Verify that `~/.claude/adapter-sessions.json` is writable and that the session still exists in Desktop.

## Source

`index.ts`, `protocol.ts`, and `media.ts` under `adapters/wechat/`, plus `pairing.ts`, `session-store.ts`, `ws-bridge.ts`, and `http-client.ts` under `adapters/common/`.
