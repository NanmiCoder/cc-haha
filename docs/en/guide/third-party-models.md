# Third-Party Models

Claude Code Haha can connect to Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses APIs. For Desktop users, the reliable entry point is **Settings → Providers**, not a hand-written environment file. The app stores authentication and model mappings and starts a local protocol proxy when one is required.

## Recommended setup

1. Open **Settings → Providers** in Desktop.
2. Choose a built-in preset or create a custom provider.
3. Enter the base URL, authentication details, and protocol format.
4. Configure at least the primary model. Add Haiku, Sonnet, and Opus mappings when the service uses different model IDs.
5. Test the provider before activating it.
6. Start a new session and verify a tool call. A text-only response does not prove that the full agent workflow works.

After activation, Desktop and the CLI processes it launches reuse the same provider configuration. Do not keep a second, stale key in `.env` or `~/.claude/settings.json`.

## Choose the correct protocol

| Provider format | Upstream API | Use it when |
|-----------------|--------------|-------------|
| `anthropic` | Anthropic Messages | The service natively accepts Anthropic requests and responses |
| `openai_chat` | `/v1/chat/completions` | The service implements OpenAI Chat Completions |
| `openai_responses` | `/v1/responses` | The service implements OpenAI Responses |

The `anthropic` format calls the service directly without changing the protocol. For `openai_chat` and `openai_responses`, Claude Code Haha starts a loopback proxy that translates Claude agent traffic into the selected protocol. This proxy belongs to the local runtime and does not need to be exposed to a LAN.

If a provider advertises both “OpenAI compatible” and “Anthropic compatible,” choose the API that it implements completely and that handles tool calls reliably. Do not infer the protocol only from a `/v1` path.

## Authentication and model mappings

The service determines the authentication header:

- Anthropic API keys usually use `x-api-key`.
- Bearer tokens usually use `Authorization: Bearer`.
- OpenAI-compatible services usually use bearer tokens, but private gateways can differ.

Model slots are logical tiers requested by the Claude agent, not additional downloads. The primary model must support tool use. Other slots can map to that same model or to separate models chosen for cost and capability. Leave a slot empty when the provider does not support it.

Model names and provider capabilities change frequently, so this page intentionally does not maintain a soon-to-be-stale model catalog. Use the current model ID reported by the provider and confirm it with the test action in Settings.

## Built-in runtimes

Claude Code Haha also includes Claude, OpenAI, and Grok runtimes. Available sign-in methods depend on the current build and local account state; follow the authorization flow shown on the Providers page.

Built-in runtimes and custom compatible endpoints are separate paths. Prefer a built-in runtime for an existing official account. Create a custom provider for a relay service, private gateway, or local model server.

## CLI-only configuration

CLI-only users can configure an Anthropic Messages-compatible endpoint directly:

```bash
ANTHROPIC_AUTH_TOKEN=sk-example
ANTHROPIC_BASE_URL=https://provider.example.com/anthropic
ANTHROPIC_MODEL=provider-model
./bin/claude-haha
```

This path does not translate Anthropic requests into an OpenAI protocol. Configure OpenAI Chat Completions or Responses services as Desktop providers so the app can manage the protocol proxy. See [Environment Variables](./env-vars.md) for the complete variables and effective precedence.

Azure OpenAI uses the project's dedicated Responses path. See [Azure OpenAI environment variables](./env-vars.md#azure-openai).

## LiteLLM: an advanced compatibility layer

Add LiteLLM only when the service has no reliable Anthropic endpoint and the built-in provider translation is not suitable. It introduces another service, another protocol conversion, and another troubleshooting boundary.

Minimal example:

```yaml
model_list:
  - model_name: provider-model
    litellm_params:
      model: openai/provider-model
      api_base: https://provider.example.com/v1
      api_key: os.environ/PROVIDER_API_KEY
```

After starting LiteLLM, connect its Anthropic-compatible URL as an `anthropic` provider. Follow the [official LiteLLM documentation](https://docs.litellm.ai/) for deployment, authentication, and model prefixes.

## Capability boundaries

A third-party model needs at least the following behavior for a stable agent workflow:

- correct handling of multi-turn messages, system content, and tool calls;
- preservation of tool-call IDs and acceptance of matching tool results;
- sufficient context and output limits;
- complete, correctly ordered events in streaming mode.

Thinking modes, effort, prompt caching, image input, and structured output depend on the protocol, provider, and exact model. They cannot be labeled universally supported or unsupported. When diagnosing a failure, disable optional capabilities, verify basic text plus tool use, and restore features one at a time.

## Troubleshooting

| Symptom | Check first |
|---------|-------------|
| `401` / `403` | Authentication header, token permissions, and whether the base URL belongs to that credential |
| `404` | Provider format and whether the base URL duplicates an API path |
| Model not found | Use the provider's real model ID, not an alias from another platform |
| Text works but tools never run | Confirm that both the model and gateway fully support tool calls |
| Old endpoint after switching providers | Remove duplicate configuration from `.env`, `settings.json`, or Desktop |
| Streaming stops early | Disable optional capabilities and check whether a gateway buffers or rewrites the event stream |
