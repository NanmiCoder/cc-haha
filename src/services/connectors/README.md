# Desktop office connectors

The application ships 55 entries: 46 service connectors and 9 skill tool bundles.
Service connectors use either a pinned native CLI or an official remote MCP
endpoint. Tool bundles contain pinned upstream skills and supporting files.
`pluginBridge.ts` reuses plugin caching, marketplace registration, enablement,
and session reload; no new execution protocol or application-hosted proxy is
introduced. Catalog metadata does not contain credentials.

The following native-artifact sections describe the original three CLI services.
Remote service sources and skill bundle details are documented below and in
`research.md`.

## Pinned artifacts and evidence

The following public package metadata and archives were inspected on 2026-09-13.
The download and native-member checksums are in `managedRuntime.ts`; updating a
version requires adding a new version entry with both sets of hashes and the
command/output fixtures. Keep the previous released version entries: updates
and rollback must resolve pins from the installed version, never the latest
catalog version. Unknown versions fail closed before installation or invocation.

| Connector | Package | Native platforms |
| --- | --- | --- |
| Feishu | `@larksuite/cli@1.0.95` | macOS ARM64/x64, Windows ARM64/x64 |
| DingTalk | `dingtalk-workspace-cli@1.0.61` | macOS ARM64/x64, Windows ARM64/x64 |
| WeCom | `@wecom/cli@1.2.1` | macOS ARM64/x64, Windows x64 |

Primary evidence:

- [Lark package metadata](https://registry.npmjs.org/@larksuite/cli/1.0.95), its
  `scripts/install.js` and `scripts/run.js`, and the
  [v1.0.95 release](https://github.com/larksuite/cli/releases/tag/v1.0.95).
  The release API publishes archive SHA-256 digests. The npmmirror binary path
  comes from that pinned install script; fallback must pass the same checksum.
- [DingTalk package metadata](https://registry.npmjs.org/dingtalk-workspace-cli/1.0.61),
  package `install.js`, native archives in `assets/`, and their included README.
  The npm archive has pinned SHA-512 integrity and contains all four targets.
- [WeCom package metadata](https://registry.npmjs.org/@wecom/cli/1.2.1), its wrapper
  `bin/wecom.js`, and exact-version `@wecom/cli-darwin-arm64`,
  `@wecom/cli-darwin-x64`, and `@wecom/cli-win32-x64` packages. There is no declared
  Windows ARM64 package. Each target archive has its own pinned SHA-512.
- [Lark v1.0.95 status implementation](https://github.com/larksuite/cli/blob/v1.0.95/cmd/auth/status.go)
  and [initial setup](https://github.com/larksuite/cli/blob/v1.0.95/cmd/config/init.go).
- [WeCom auth implementation](https://github.com/WecomTeam/wecom-cli/blob/main/crates/wecom-cli/src/cmd/auth.rs)
  informed local-state semantics. This source URL is moving, not an immutable
  v1.2.1 reference; the pinned native binary's command help separately confirmed
  `auth init --no-browser --noninteractive` and `auth show --status`.

The packages execute native binaries behind small JavaScript wrappers. Invoking
the managed native binary removes the user's Node/npm prerequisite. It also
avoids npm postinstall scripts that publish skills into other agents' user
folders. No npm lifecycle scripts or package-provided installers are executed.

Only a known archive member is extracted to stdout using system `tar -xOf`,
then written into the staging directory. macOS bsdtar and the Windows 10/11
bundled libarchive tar support the tgz/zip formats. Missing tar reports an
installation error. The Windows executable and argv construction are covered
by injected-process fixtures; actual Windows tar/process execution is not yet
validated. No shell command string is used to install or authorize.

## Account and verification semantics

- Feishu uses the user's existing CLI account after the UI's shared-state
  consent. If and only if the status command returns the structured
  `config/not_configured` error, setup runs `config init --new --brand feishu`.
  Upstream `--new` bypasses terminal selection; no `--force-init` override is
  used. Other config errors stop the operation. Login uses `--recommend --json`.
  `auth status --json --verify` is remote verification, and requires
  `identity: user` plus `verified: true` for the connected result.
- DingTalk uses `DWS_CONFIG_DIR`, `DWS_KEYCHAIN_DIR`, and
  `DWS_DISABLE_KEYCHAIN=1`. The latter two symbols are present in the pinned
  native binary; the included README describes file-DEK versus OS-keychain
  operation. These paths are application-owned and also appear in the bridge
  skill so tasks use the same credential store. HOME and USERPROFILE are not
  changed. Full logged-in persistence/isolation requires future account tests.
  `auth status --format json` is conservatively classified as local verification;
  the adapter does not claim that cached `authenticated: true` proves a fresh
  server check. Login uses `--no-browser`.
- WeCom uses existing shared CLI credentials with explicit UI consent.
  `auth show --status` reports presence of a configured bot, not current server
  validity. It is classified as local verification. Login's upstream flow
  validates credentials before saving, but that does not turn later local
  status checks into fresh remote verification.

No adapter stores tokens or account secrets in connector state. No raw CLI
stderr/stdout is returned as a user-facing error. Only HTTPS authorization URLs
on exact configured vendor hosts may be published as progress. The UI opens
the URL; adapter code itself never launches a browser. DingTalk and WeCom
receive their explicit `--no-browser` flags. Feishu login uses JSON output and
piped stdio; the inspected v1.0.95 login command emits a device-authorization
URL, but this is not a verified guarantee that every upstream setup helper
never launches a browser. End-to-end first-account browser behavior still
requires authorized acceptance testing. Expired credentials or missing business
permissions must still be handled by the requested business command.

## Lifecycle and validation limits

Installation validates the downloaded archive, then the binary SHA-256 and
exact version before publication. Cached binaries are checksum-checked before
execution, including every adapter status check and authorization invocation;
checks select the exact installed version’s retained pin. Failed staging preserves the previous installed version. Different
versions remain available on disk until connector removal; removal deletes
only this connector's managed runtime tree, including old versions and staging
remnants. Account storage is preserved. Disabling/removing the plugin does not
revoke other programs' access to shared credentials.

Processes use bounded output, deadlines, and abort signals. Cancellation kills
the managed POSIX process group or uses Windows `taskkill /PID /T /F`; unrelated
shared services are not targeted. Abrupt host termination can leave staging
files, which are removed with the connector. It cannot promise cancellation of
an operation the upstream service already accepted.

`fixtures/status-output.json` labels provenance. Feishu's not-configured error is emitted on stderr with an empty stdout and
nonzero exit status. This is covered by the first-login adapter test.
Feishu's not-configured and DingTalk's signed-out outputs came from the pinned macOS ARM64 binaries in
temporary account directories. Successful status responses are synthetic
fixtures derived from inspected schemas, **not real authorized-account
results**. WeCom's status strings are schema fixtures from upstream code.
Tests use fake processes/artifacts and a loopback download server; no model,
real account login, token refresh, or business operation is part of a test.

Real account authorization for all three providers, Windows execution,
macOS x64 execution, and service permission coverage remain unverified. Artifact
availability and successful deterministic tests do not substitute for those
release acceptance checks.

## Verified read-only command recipes

These are concrete entry points, not executed business calls. Replace the CLI
name with the exact executable and environment emitted by the bridge skill.

| Intent | Command suffix | Evidence and prerequisites |
| --- | --- | --- |
| Feishu agenda | `calendar +agenda` | Pinned package README; connected user with calendar read scopes. Inspect `calendar +agenda --help` for the requested date window. |
| DingTalk agenda | `calendar +agenda --format json` | Pinned `assets/dws-skills.zip` → `multi/dingtalk-calendar/SKILL.md` labels it read-only and defaults to today. Requires OAuth, enterprise administrator authorization and access to the relevant calendar. Calendar ACL reader or higher is required when reading shared calendars. |
| WeCom calendar range | `calendar schedules list --begin-time <str> --end-time <str>` | Pinned native `--help`. Omitted times mean now through 30 days, so choose the user's intended range explicitly. Requires configured bot/user access and calendar capability authorization. Inspect `calendar schedules list --help` / `--schema`; do not invent OAuth scope names. |
| WeCom contact search | `contact users search --keywords <name>` | Pinned native `--help`. Requires contact access; show ambiguous matches rather than silently selecting the first. |

WeCom's `--json` means **request body JSON**, not an output-format switch. Do not
append `--format json` to its commands. The DingTalk README additionally confirms
`calendar event list` for today's events. Missing scopes, enterprise approval,
or per-resource access must be reported from the service response; installation
and local account configuration cannot establish those permissions.

Feishu account display names come only from `identities.user.userName`, as
specified in [v1.0.95 identity diagnostics](https://github.com/larksuite/cli/blob/v1.0.95/internal/identitydiag/diagnostics.go).
No identity object, token metadata, or undocumented email field is exposed as
an account label. DingTalk and WeCom labels are omitted until an authoritative
field is established for their exact status commands.

## Expanded directory and remote MCP connectors

The desktop directory contains 46 services across office, productivity,
development, search, maps, data, design, finance and legal research. The original
three CLI adapters are joined by 43 official HTTP MCP endpoints documented in
`research.md` and `remoteCatalog.ts`. GLM search additionally follows
https://docs.bigmodel.cn/cn/coding-plan/mcp/search-mcp-server and requires the
appropriate Coding Plan key. Directory presence does not mean a service account
has been connected or its business operations have been tested.

Remote adapters use the existing MCP client, tools/list discovery and OAuth
flow. They do not download Node or execute npm wrappers. The plugin manifest
and `.mcp.json` contain sensitive `user_config` placeholders; submitted keys are
stored in the existing plugin-specific sensitive options store, never in the
connector DTO, state.json, skill text or catalog. Query parameters are encoded
before the same plugin loader substitution used by the runtime. Installed
remote plugins use `plugin:office-<id>:service`, matching the check/OAuth identity.

A remote check clears its previous MCP connection cache and discovers current
tools. No business tool is called to establish readiness. A missing key, OAuth
requirement, failed handshake, empty tool list or cancelled operation cannot be
reported as ready. OAuth authorization URLs open only through the explicit UI
flow. Check/configuration disables the plugin and refreshes active sessions
before credentials change. Updating an installed package cannot silently replace
its credentials; use the connection form to rotate credentials instead.

Remote definitions currently have one reviewed recipe version, 1.0.0. A future
endpoint/authentication migration must preserve the old recipe for installed
versions and rollback; do not silently point a recorded old version at a new
endpoint. Keys and OAuth tokens are scoped to this managed plugin. Removal
cleans that owned scope and plugin installation, never another user's MCP
server, CLI account, or provider-wide authorization.

The page uses compact directory rows, small icon actions and all six current
application themes. Remote service names/descriptions/requirements/task
examples are translated through the existing five-language mechanism. Brand
asset provenance is recorded in desktop/public/connectors/SOURCES.md.

## 2026-09-14: Service and tool catalog

There are currently 55 built-in entries: 22 China-market services, 24 global services, and 9 skill toolkits (4 shown in the plugin catalog, 5 in the skill catalog). Previously added services are grouped by vendor and workflow; multiple sub-APIs of the same data platform are not counted as separate services.

The catalog is a read-only definition shipped with the app:

- `catalog.ts`: aggregation and the original three CLIs.
- `remoteCatalog.ts`, `domesticCatalog.ts`, `globalCatalog.ts`: service presentation and execution recipes, still with a single source of endpoint/auth.
- `skillCatalog.ts`, `skillBundles.lock.json`: tool descriptions, pinned commits of public repositories, licenses, and per-file SHA-256. HyperFrames uses the full v0.4.0 five-skill bundle; Remotion uses its official MIT-licensed Codex plugin skill tree; both are loaded through this app's Claude plugin bridge.
- `desktop/public/connectors/`: local icons and provenance records.

State after adding continues to be managed by `<Claude config dir>/connectors/state.json`; plugin registration and enablement reuse the existing plugin settings; keys reuse the sensitive config store, and OAuth reuses the existing OAuth store. Catalog expansion and UI filtering don't write user state, and no global schema fields were added to the shared settings.json. This round did not change the persistence shape.

Tool plugin installation only downloads the skills, references, scripts, and licenses listed in the lock file, staging and verifying them before publishing; it never runs scripts, installs Node, downloads browsers, or calls models during installation. Files in both the original install and the plugin cache must pass integrity checks before "Skill loaded" is shown; this status does not mean the renderer and business services have been verified. Load status must be re-verified after restart, and disabling/removing refreshes plugin capabilities for existing sessions.

So Skills, MCP, and CLIs can all be plugin components, but they are not equivalent protocols, and not every Codex plugin can be reused directly. Products that depend on OpenAI-hosted Apps, proprietary tools, or undisclosed authorization methods are not passed off as integrated via an empty Skill.

## Installation acceptance — 2026-09-14

All 54 entries reached the production installation path in disposable macOS
ARM64 fixtures. Three native CLIs produced their provider authorization URLs;
41 remote MCP entries require an account or key. Context7 and Exa also passed
an anonymous read-only tool call. Eight skill bundles passed download, integrity
and loader checks with local examples; this does not validate their optional
rendering dependencies or every bundled script. No third-party account login
was completed. Windows, Linux and macOS x64 were not executed.

Seven desktop samples exercised native shared-account consent, isolated CLI
authorization, missing/rejected API keys, OAuth URL generation, anonymous MCP
readiness and skill-bundle removal. Opening the provider login link and granting
account access remain separate acceptance steps. Detailed local records live
in ignored `artifacts/connectors/live-acceptance/`; they are not release assets.

The initial acceptance worker incorrectly reached the macOS credential backend
and caused repeated missing-keychain prompts. It was stopped. Later acceptance
used a temporary file credential backend with process guards. Those guards do
not constitute an OS sandbox or prove interception of native Security.framework
calls. Do not repeat live acceptance with a fake username and the normal macOS
credential backend. Automated PR checks must use disposable credential fixtures.
