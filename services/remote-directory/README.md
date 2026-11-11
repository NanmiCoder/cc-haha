# cc-haha remote discovery

This is a project-operated address directory for persistent Android pairing. End users install the desktop and Android apps and pair once. They do not deploy a server or supply a Cloudflare account.

Deployment has **not** been performed by this change. `src/shared/remoteServiceConfig.ts` intentionally has an empty default URL. Builds without a deployed directory report temporary access and cannot discover a computer after its tunnel address changes.

## What it stores

One signed announcement per computer: protocol version, SHA-256 public-key ID, RSA public key, HTTPS origin, increasing sequence, expiration, and signature. There are no sessions, messages, login cookies, phone keys, or model credentials. Records expire for reads after ten minutes. The last record remains as a sequence tombstone, preventing an old address from being replayed after expiry or a service restart.

The server public key is pinned by the first trusted desktop QR. Phones verify the announcement and then request an anonymous, fresh proof from the candidate endpoint before sending device authorization. A directory response cannot replace a pinned key. Device grants are revocable, persist independently of short-lived origin-bound cookies, and are renewed using Android Keystore signatures.

This service does not proxy a user's endpoint and does not make server-side requests to announced URLs. It is not end-to-end conversation encryption: the existing HTTPS tunnel provider terminates transport encryption. Quick Tunnels remain a testing transport without an availability guarantee. A project-operated directory removes repeated scanning when their addresses change; it does not provide offline computer access or wake a sleeping computer.

## Private server alternative

For an existing Linux server, use the [private Bun/SQLite deployment](SELF_HOSTED.md). It has a mandatory computer-identity allowlist, loopback-only listener, systemd/nginx examples, and a process-restart smoke. Follow the [private desktop configuration guide](private-client.md) to select the service once without changing contributed source. Personal deployment addresses and configuration stay outside the contributed source and are not defaults for other users. This is independent of the Cloudflare deployment below.

## Local validation

Use Node.js 22 or later and the repository's pinned Bun version:

```sh
bun run check:remote-directory
```

The command verifies signatures, expiry, key mismatches, replay/rollback, concurrent updates, request limits, and request-size bounds. It installs the pinned Wrangler dependency using the committed lockfile, starts local workerd with an isolated home and SQLite state, publishes over loopback HTTP, restarts the process, and verifies persistence and address rotation. It never logs into Cloudflare or calls a model. Temporary state and child processes are cleaned up.

For interactive local development:

```sh
cd services/remote-directory
npm ci
npm run dev
```

## Project deployment

One project maintainer needs a Cloudflare Workers account. SQLite-backed Durable Objects are available on the Workers free plan, subject to account quotas. An account is still required for a durable deployment. A temporary preview account is not an acceptable stable discovery endpoint. Do not add secrets to the source tree or use an end user's Cloudflare account.

After deployment has been authorized:

```sh
cd services/remote-directory
npm ci
npx wrangler login
npm run deploy
```

The checked-in configuration creates a Worker named `cc-haha-remote-directory`, a `HOSTS` Durable Object namespace, and per-IP/per-host rate-limit bindings. Keep the Worker hostname and Durable Object namespace when upgrading. Do not remove storage migrations or reset the namespace: sequence history is part of the replay boundary. Rate-limit namespace IDs must not collide with another service in the same account. Edge rate limits are approximate per-location limits, not a global quota guarantee.

Before shipping a desktop build:

1. Confirm `GET /health` returns protocol version 2 over the permanent HTTPS origin.
2. Use a disposable computer key to publish and read a signed announcement, then redeploy and confirm it survives. Do not publish real session data.
3. For a project-operated official service, set `REMOTE_DIRECTORY_URL` in `src/shared/remoteServiceConfig.ts` to that exact origin (no path, query, credentials, or trailing slash), then build the desktop and Android artifacts. For a personal service, leave that source default empty and [launch the desktop once with `CC_HAHA_REMOTE_DIRECTORY_URL`](private-client.md). The validated HTTPS selection is saved in private local settings v4 and survives subsequent launches without the environment variable. Neither is an end-user settings field.
4. Pair a test phone once. Restart the computer/app, rotate the tunnel address, switch phone networks, and verify automatic restoration and revocation. Network tests must distinguish emulator/loopback fixtures from a physical phone on cellular data.

Directory outages leave existing working tunnels active. The desktop retries publication independently; phones may use a cached endpoint only after verifying its pinned identity. If the computer's identity file is corrupt, recovery fails rather than silently generating a replacement identity. Restoring unrelated or older identity backups can roll back the publication sequence and should not be used as automatic repair.

## API

- `GET /health`: service name and protocol version.
- `PUT /v1/hosts/<sha256-spki>`: a signed announcement, at most 4 KiB. Returns 201 on first storage or 200 on update/identical retry. Invalid signatures and malformed input return 400; stale sequences return 409; throttling returns 429.
- `GET /v1/hosts/<sha256-spki>`: signed announcement, 404 if unknown, or 410 if offline/expired. No redirects, cookies, permissive CORS, or cached responses.

The exact signature format and shared interoperability vectors are in `src/shared/remoteIdentityProtocol.ts` and `src/shared/__fixtures__/remote-identity-v2.json`. The fixture private key has no real authorization. Do not use it for deployed clients.

Primary references: [Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/), [Durable Object storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [Workers rate-limit bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), [Workers pricing and quotas](https://developers.cloudflare.com/workers/platform/pricing/).
