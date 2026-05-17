# H5 Access Design

## Goal

Add a simple H5 access mode for personal and team use. A desktop user can enable H5 access in Settings, generate a token, expose the frontend/backend through LAN or their own reverse proxy, and open the same chat experience from a phone browser.

This is not a public multi-tenant product login system. The design intentionally keeps the first version small while avoiding accidental exposure of the existing desktop API.

## Non-Goals

- Do not change the default desktop/Tauri local flow.
- Do not add account login, OAuth, user management, or short-lived session exchange in the first version.
- Do not make every desktop-only feature mobile-first in the first version.
- Do not expose unauthenticated remote API access.

## Current Context

The desktop frontend is already a Vite SPA under `desktop/`. In non-Tauri browser mode, `desktop/src/lib/desktopRuntime.ts` accepts `?serverUrl=` and points the API client at that backend. The backend in `src/server/index.ts` can bind to a configured host and already requires auth for non-localhost hosts. The missing pieces are productized H5 settings, H5 token handling in the frontend, configurable CORS, WebSocket token support, and mobile-safe layout.

## Product Shape

Settings gets a new `H5 Access` section:

- Enable/disable H5 access.
- Generate a strong random token when enabling.
- Show masked token with copy and regenerate actions.
- Show an H5 URL that can be copied.
- Allow an optional public frontend/base URL override for users running a reverse proxy.
- Show a concise safety note: this is intended for LAN or self-managed reverse proxy use, and anyone with the token can operate the exposed chat surface.

The H5 browser entry shows a connection screen when no token is stored:

- Server URL field.
- Token field.
- Connect button.
- Clear, non-secret error messages for unreachable server, bad token, CORS block, and WebSocket failure.

After connection, the phone opens the existing chat product with a mobile-optimized shell.

## Architecture

### Server Configuration

Persist H5 settings in the existing cc-haha managed settings path (`~/.claude/cc-haha/settings.json`), preserving unknown fields and keeping the user-owned `~/.claude/settings.json` untouched:

```ts
type H5AccessSettings = {
  enabled: boolean
  tokenHash: string | null
  tokenPreview: string | null
  allowedOrigins: string[]
  publicBaseUrl: string | null
}
```

Store only a hash of the token. The raw token is shown only when generated or copied immediately after regeneration. If the user loses it, they regenerate it.

Server behavior:

- Localhost desktop mode remains unchanged.
- When H5 is disabled, remote browser origins are not allowed by CORS.
- When H5 is enabled, configured `allowedOrigins` can pass CORS.
- Remote `/api/*`, `/proxy/*`, and `/ws/*` require `Authorization: Bearer <h5-token>` or a WebSocket `token` query parameter.
- `/health` remains useful for local desktop startup, but when the request is non-local and H5 is enabled it should return only minimal service status and no sensitive diagnostics.

### Client Runtime

Extend the existing browser-mode startup:

- Keep Tauri mode using `get_server_url`.
- In browser mode, read `serverUrl` from query string or localStorage.
- Read H5 token from localStorage.
- If missing or invalid, render the H5 connection screen.
- Add the token to REST requests through the central API client.
- Add the token to WebSocket connections with a query parameter.
- Fix WebSocket URL construction so `https://` backends become `wss://`, not an invalid `wss` derived by string accident.

### API Surface

First version grants token holders the same core desktop API needed for chat:

- sessions list/detail/messages/create/delete/rename
- chat WebSocket
- slash commands and inspection endpoints used by the chat UI
- settings reads needed for model and permission controls
- provider/model selection paths used by the composer

High-risk or desktop-native surfaces should be hidden or disabled in the H5 UI unless they are already required by chat:

- terminal
- doctor repair
- native updater
- native file dialogs
- broad filesystem browsing
- plugin, MCP, and skill management

The server can still protect these with the same H5 token in the first implementation, but the UI should not present them as primary H5 workflows until mobile handling and risk review are done.

## Mobile UI Design

The H5 shell should be mobile-first without rewriting the desktop UI.

### Layout Rules

- Replace mobile `h-screen` usage with a `100dvh`/safe-area shell.
- Add a viewport hook or CSS breakpoint around 768px.
- On mobile, sidebar becomes a drawer with a backdrop instead of a fixed rail.
- Main chat is a single column.
- Workspace and terminal split panels are not shown as side-by-side panes on mobile; first version hides them from the mobile chat shell.
- Keep desktop layout unchanged above the breakpoint.

### Chat Priority

The first version optimizes:

- session list access
- open/create session
- message history
- streaming assistant response
- send/stop
- attachments if existing browser file input works safely
- permission confirmation dialogs
- model and permission selectors with mobile-safe popovers

### Touch And Typography

- Primary icon buttons on mobile use at least 44px hit targets.
- Menu rows use enough vertical padding for touch.
- Body text uses a readable 16px baseline where practical.
- Tiny metadata can remain smaller, but it must not be required to operate the chat.
- Fixed-width popovers such as permission mode selectors become full-width-with-margin sheets on mobile.

## Error Handling

H5 startup errors should be actionable:

- Server unreachable: show the current server URL and suggest checking LAN/reverse proxy.
- Unauthorized: ask the user to re-enter token.
- CORS blocked: explain that the backend has not allowed this H5 origin.
- WebSocket failed: show REST health status separately from chat socket status.
- H5 disabled: show that H5 access must be enabled in desktop Settings.

Do not show raw secrets in diagnostics or error text.

## Security Notes

- H5 access is opt-in.
- Token must be generated with high entropy.
- Store only a hash server-side.
- Token regeneration invalidates the old token.
- CORS must be explicit, not wildcard.
- The default bind remains localhost.
- Documentation should recommend a reverse proxy with TLS for domain access.
- This feature is suitable for personal/team controlled environments, not public internet exposure without additional controls.

## Implementation Boundaries

Implementation should be split into independent lanes:

1. Server and persistence: H5 settings, token hash, auth validation, CORS origin handling, WebSocket token handling.
2. Desktop settings UI: enable switch, token generation/reset/copy, URL display, safety note.
3. H5 browser runtime: connection screen, localStorage token/server URL, REST and WebSocket auth injection.
4. Mobile shell: drawer sidebar, `dvh` shell, chat column constraints, mobile popover/sheet fixes.
5. Tests and verification: server auth/CORS tests, API client/WebSocket tests, settings UI tests, mobile browser smoke.

Each lane should avoid changing unrelated desktop behavior. Desktop/Tauri tests must remain green.

## Verification Plan

Narrow checks:

- Server tests for H5 enabled/disabled, good token, bad token, CORS allowed/disallowed, WebSocket token accepted/rejected.
- Desktop API client tests for Authorization injection and no-token local behavior.
- WebSocket client tests for `https -> wss` and token query parameter.
- Settings UI tests for enable/regenerate/copy state.
- Mobile layout tests or browser smoke at 390x844 and 430x932.

Full checks before handoff:

- `cd desktop && bun run test`
- `bun run check:server`
- `bun run check:desktop`
- `bun run verify` when the targeted lanes are green or report any pre-existing quality gate blocker explicitly.

Manual smoke:

1. Start backend locally with default localhost and verify desktop still works.
2. Enable H5 in Settings and generate token.
3. Start backend bound for LAN or via a local reverse-proxy equivalent.
4. Open H5 URL in browser/mobile viewport, enter token, list sessions, create/open session, send a message, stop a running turn, reconnect.

## Rollout

Ship as opt-in beta wording in Settings. Keep H5 disabled by default. The first version should document LAN and reverse-proxy setup, but should not promise production public hosting.
