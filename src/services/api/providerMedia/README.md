# Outbound provider image files

`buildProviderMediaFetch` wraps the final authenticated fetch, after protocol
conversion and before the transport/trace capture. It changes a disposable JSON
request, never persisted messages or original media. API key and account-login
transports use the same engine; credentials come from the outgoing request.

The only enabled provider is the exact HTTPS `api.deepseek.com` origin, using
`deepseek-flash` or its documented vision alias. Anthropic Messages, OpenAI Chat
Completions and Responses shapes are supported, including tool-result images.
Third-party relays and other providers pass through unchanged.

## Policy and recovery

- Small requests remain inline. Above 40 MiB of serialized JSON, upload the
  largest image groups until the request is at most 32 MiB, where possible.
- Repeated image content shares a file reference. In-process cache keys include
  provider, origin and a hash of the actual credentials; file IDs are not shared
  between keys/accounts. The cache stores at most 1024 entries, with no images or
  raw credentials. Restarting can upload again from the preserved originals.
- Upload original bytes with an explicit 24-hour expiry. Reuse valid cached IDs
  even below the threshold. Expiry includes a one-minute clock margin. An
  upstream missing/expired-file response invalidates the used IDs.
- A 413 or missing-file response can trigger one additional inference attempt.
  Retries only occur after a changed request; they never loop within the wrapper.
- Upload failure preserves images and falls back to the normal inference/error
  path. Cancellation propagates. No image is replaced with an omission message.
- Uploads use the same transport/proxy options and signal, strip inference-only
  headers, and reject redirects. Inference redirects are also rejected when the
  request is rewritten.

Files API reduces transfer size, not vision token usage, image dimensions/count
or context limits. DeepSeek ignores `detail` on file references. OAuth file
endpoint permission remains a provider capability to validate live separately;
unsupported upload auth falls back without discarding media.

## Adding a provider

1. Implement a `MediaEndpointResolver` beside `deepseek.ts`, validating the exact
   official origin and documented paths. Do not route arbitrary compatible
   endpoints to another service for uploads.
2. Implement the `MediaEndpoint` contract: limits, supported models/image shapes,
   credential scope, authenticated multipart/request construction, returned file
   parsing and reference replacement. Only walk documented message fields;
   tool arguments/schemas and strings containing JSON are not image inputs.
3. Register it in `providers.ts`. The common engine owns thresholds, cache,
   cancellation and bounded recovery. No persisted provider-schema change is
   needed for a static capability addition.
4. Test exact wire requests, unknown hosts/models, all supported credentials,
   multi-turn reuse, expiry, cancellation and failures with fake transports.
   Cover actual client/proxy entrypoints before separately authorized live tests.

DeepSeek contracts:
- https://api-docs.deepseek.com/zh-cn/guides/files_api/
- https://api-docs.deepseek.com/zh-cn/guides/vision/
