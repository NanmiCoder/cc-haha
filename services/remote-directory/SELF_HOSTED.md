# Private deployment on an existing server

This alternative uses Bun's built-in SQLite and a normal HTTPS reverse proxy. It uses the same signed v2 protocol as the Cloudflare Worker and Android app. It does not require Cloudflare credentials, Docker, a database service, or a public Bun listener. You can compile a standalone executable so the server does not need Bun installed.

Private deployments always require an explicit nonempty computer identity allowlist. Only the listed computer identities may publish or resolve an address. Knowing a listed ID does not authorize a write: each publication must carry a valid signature from that computer's private key. Phone authorization remains between the phone and the computer. A permitted computer's signed public address metadata is readable by anyone who already knows its public identity; this is an address directory, not a secret storage service. No other computers can use this deployment without the operator changing its allowlist.

Do not put a personal server address, SSH key, deployment credential, or actual allowlist in contributed source. The checked-in examples are placeholders. Keep private environment files outside the repository and keep `REMOTE_DIRECTORY_URL` empty for upstream contributions. A maintainer may later operate a separate public service with their own release configuration.

## Verify before deploying

From this directory, with the repository's pinned Bun version:

```sh
bun run test:self-hosted
```

The tests use fake keys and isolated temporary directories. The process smoke uses the repository's quality-gate sandbox with provider seeding disabled, redirects user/config/cache/temp paths, and fails if the user-state metadata guard detects writes to real configuration. It publishes over loopback, kills the server process, checks SQLite durability, expires a record, restarts again, rejects a rollback, rotates the address, and rejects unlisted identities and forged signatures. It never reads production credential contents or deploys anything.

To build and test a standalone binary for the current machine, run from the repository root:

```sh
bun build src/remote/directory/selfHostedMain.ts --compile --outfile /tmp/cc-haha-remote-directory
bun services/remote-directory/self-hosted-smoke.ts /tmp/cc-haha-remote-directory
```

For a Linux x86-64 server, cross-compile with the baseline CPU target:

```sh
bun build src/remote/directory/selfHostedMain.ts --compile --target=bun-linux-x64-baseline --outfile /tmp/cc-haha-remote-directory-linux-x64
```

Use a matching target for other server architectures. A cross-build on macOS is build evidence only; execute the smoke on an isolated directory on the actual server before installing the binary.

## Runtime configuration

| Environment variable | Requirement |
| --- | --- |
| `CC_HAHA_DIRECTORY_ALLOWED_HOST_IDS` | Mandatory comma-separated lowercase SHA-256 public-key IDs; between 1 and 128 distinct IDs. No wildcard. |
| `CC_HAHA_DIRECTORY_STATE_DIR` | Mandatory absolute path to a dedicated persistent directory. |
| `CC_HAHA_DIRECTORY_PORT` | Optional port, default `8788`; binding is always `127.0.0.1`. |

The computer ID comes from the desktop's native remote identity, available through its authenticated local administration API (`GET /api/public-access/native/identity`). It is a public fingerprint, never the private key. Provision only your computer's ID and [select the private desktop service once](private-client.md) using `CC_HAHA_REMOTE_DIRECTORY_URL=https://directory.example`. The validated selection is persisted in private local settings v4 and survives later launches without the environment variable. The Android app receives and pins this origin during trusted QR pairing; it does not need a hardcoded personal URL.

Missing/empty/invalid allowlists refuse startup. All other host IDs receive HTTP 403 for both reads and writes. Changing the allowlist requires a service restart. Removing an ID prevents further directory access without deleting its sequence tombstone. On the computer, revoke the phone's grant if phone access must be removed; removing a directory entry alone does not invalidate a phone's already known, working endpoint.

## Install behind existing HTTPS

Review and adapt `deploy/directory.env.example`, `deploy/cc-haha-remote-directory.service`, and `deploy/nginx.conf.example`. Use a dedicated unprivileged system user named `cc-haha-directory`. Install the executable under `/opt/cc-haha-remote-directory/` owned by root and not writable by the service user. Keep the environment file at `/etc/cc-haha-remote-directory.env`, owned by root with mode 0600. The service unit's `StateDirectory` creates the private database directory under `/var/lib`.

The nginx example requires an existing valid, publicly trusted HTTPS certificate. Use either a dedicated HTTPS hostname or the exact `/health` and `/v1/hosts/` routes on a compatible existing HTTPS site. Do not route the whole existing site to the directory. Check existing route ownership and run `nginx -t` before reloading. Keep the application's loopback port closed to the internet. No DNS change is required when reusing a compatible existing hostname. HTTP-only endpoints cannot be paired by the native client.

The app enforces a global 300 requests/minute cap and 30 publication attempts/minute per allowed computer, including invalid signatures. Limits reset after a process restart. nginx provides additional per-IP limiting before the process, overwrites forwarded address headers, strips cookies/Authorization, and bounds uploads to 4 KiB. The application never trusts forwarded IP headers, never requests an announced URL, never proxies sessions, and never writes request bodies to logs. Rate limits are protection for a small private deployment, not a public multi-tenant billing system.

After installing and enabling the service, verify:

1. `GET /health` over HTTPS returns protocol version 2 and `access: private`.
2. A valid but unlisted identity gets 403 for GET and PUT.
3. The desktop publishes its signed address and reports discovery ready.
4. Pair a phone once, then test desktop process restart, tunnel address rotation, phone cold start, network changes, and grant revocation.
5. Reboot the server and verify its service comes back with the existing SQLite state. Never claim a physical-phone/network test based only on loopback fixtures.

The directory stabilizes address discovery. The existing tunnel still transports sessions, so this does not replace Quick Tunnel availability guarantees, wake a sleeping computer, or provide access while the computer is off.

## Upgrades and rollback

Keep the same state directory across executable updates. The database uses a schema version, SQLite WAL, synchronous FULL commits, and an atomic sequence comparison/write. Reads return HTTP 410 after expiry, but the last sequence remains permanently. The service refuses future schema versions rather than resetting them. Do not delete a database, restore an older backup, or lower a computer's publication sequence as an automatic repair; these actions weaken replay protection or prevent legitimate new announcements.

Before an authorized migration, stop the service and copy the complete state directory (including any SQLite WAL files) with restrictive ownership and permissions. Preserve the previous executable for application rollback, but do not roll back the state directory. Run the smoke with a fresh, disposable directory when verifying a new executable; never point the smoke at production state.

To remove the deployment, stop/disable its systemd service and remove only its own nginx locations after checking `nginx -t`. Preserve the private state and credentials until their owner explicitly decides how to archive or delete them. Unrelated website configuration must remain intact.
