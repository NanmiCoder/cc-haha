# Mobile Local Protocol Fixture

This is a **mock server** for app UI acceptance testing, not the cc-haha backend or a relay server. All sessions, providers, file contents, and replies are kept only in process memory and reset on restart. It does not read `~/.claude`, holds no real credentials, calls no models, runs no shell, and does not create or modify files on the computer.

## Starting and connecting

Run in the repository's `mobile/` directory:

```sh
bun scripts/fixture-server.ts --port=3457
```

On the app's add-LAN-host screen, enter:

| Field | Test value |
| --- | --- |
| Name | Local Fixture |
| Address | `http://127.0.0.1:3457` |
| Token | `mobile-fixture` |

The default port is `3457`; use `--port=3458` to start a second independent instance at the same time to check multi-host isolation. `--port=0` uses a free port assigned by the system. The startup log prints the actual address.

The server is always bound to `127.0.0.1`, with no option to listen on other addresses. It works for browser previews on the same machine and for simulators that can reach the host's loopback address; on a physical phone `127.0.0.1` refers to the phone itself and cannot be used to reach the computer. This server does not emulate HTTPS, public pairing, or native secure storage; those need the corresponding server tests and on-device acceptance.

Browser Origins are only accepted from `localhost`, `127.0.0.1`, and `[::1]`, with CORS preflight support for local Expo web pages. HTTP uses `Authorization: Bearer mobile-fixture`; WebSocket accepts either that header or `?token=mobile-fixture`. This fixed token is only for local fake data.

## Paths you can test

After startup there are four sessions labeled `Fixture`: normal chat and history, action approval, answering a question, and confirming a plan. The last three already have pending requests; open them to check the restored decision UI.

| Action | Mock behavior |
| --- | --- |
| Any normal message | Echoes the user message, a thinking block, a Read tool call and result, a chunked text reply, usage, and end events |
| `/approval` | Bash action approval; allow, deny, and remember-allow-for-session can all be demonstrated, but no command is run |
| `/edit` | Edit file change approval (only shows a change preview, writes nothing); checking "Auto-accept file edits" switches the session permission mode to acceptEdits |
| `/question` | One single-choice and one multiple-choice question, using the official `updatedInput.answers` protocol |
| `/plan` | Plan confirmation; can carry the execution model, thinking effort, and session permission mode |
| `/slow` | Slow chunked output for testing stop; stopping cancels all unsent events |
| `/error` | A clearly labeled mock failure, after which you can resend |
| `/retry` | Emits one retry status, then continues the normal reply |
| `/steps` | Tool timeline sample: read, search, edit, a background sub-Agent, and a command that runs about 8 seconds, then ends normally; the sub-Agent stays in the background until stopped |
| Change model / thinking effort | `set_runtime_config` is validated and returns `runtime_config_applied`; changes are saved on that session |
| Create / rename / delete session | Operates on the current process's in-memory list |
| Load more history | 6 items per page for normal sessions; after a new message is written, old cursors return `409 HISTORY_PAGE_STALE` |
| View workspace | Shows an in-memory file tree, files, and diffs; these paths don't correspond to real files |
| Change host default model / settings / providers | Modifies that fixture instance's in-memory configuration; does not change existing sessions' runtime configuration |

Normal chat history contains text and tool blocks in the same `tool_use` record, which is good for checking whether history conversion wrongly drops assistant text. On reconnect the server resends pending requests and `permission_requests_snapshot`, and after receiving `sync_state` returns the real current in-memory run state.

To trigger a disconnect and reconnect manually, run in another terminal:

```sh
curl -X POST -H 'Authorization: Bearer mobile-fixture' \
  http://127.0.0.1:3457/__fixture/disconnect
```

`GET /__fixture/status` (also token-protected) reports in-memory session and connection counts. `GET /health` is a public fixture declaration and returns no real user data. `Ctrl+C` stops the server.

## Automatic self-test

```sh
bun scripts/fixture-server.ts --self-test
```

The self-test uses a random loopback port and shuts the server down automatically, covering authentication, pagination and stale cursors, runtime config confirmation, tool and text streams, the three decision types, and event cancellation after stop. It doesn't require the fixture to be started first.

This server only covers the protocol subset used by the first mobile release and does not emulate real model behavior, attachment transfer to disk, background task execution, branch rollback, persistence, Git operations, or public authorization. Unimplemented HTTP paths explicitly return `404`; text streams not yet finished when stopped are not written back to history. Passing fixture acceptance proves the UI and protocol wiring work, but cannot replace testing against the real desktop server and on real iOS / Android devices.
