# Environment Variables

Claude Code Haha has two configuration paths:

- Desktop users should select, test, and activate a provider under **Settings → Providers**. The app manages authentication, model mappings, and protocol translation.
- When running the CLI from source, use a repository `.env`, shell variables, or Claude Code `settings.json`.

Do not store the same API key in several places. When troubleshooting, first check whether a Desktop provider is active.

## Common variables

### Anthropic-compatible endpoints

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Choose one authentication variable | Sent in the `x-api-key` request header |
| `ANTHROPIC_AUTH_TOKEN` | Choose one authentication variable | Sent as `Authorization: Bearer` |
| `ANTHROPIC_BASE_URL` | No | Base URL of an Anthropic Messages-compatible endpoint |
| `ANTHROPIC_MODEL` | No | Default model for the session |
| `ANTHROPIC_DEFAULT_FABLE_MODEL` | No | Fable model slot; configure it only when the provider supports it |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | No | Haiku model slot |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | No | Sonnet model slot |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | No | Opus model slot |
| `API_TIMEOUT_MS` | No | API request timeout in milliseconds; defaults to `600000` |

The correct authentication variable depends on the header required by the service. Do not infer it from the provider name alone. For a `401` response, check the provider documentation and the authentication strategy selected in Desktop.

### Azure OpenAI

Azure OpenAI uses a dedicated Responses API path:

| Variable | Required | Description |
|----------|----------|-------------|
| `CLAUDE_CODE_USE_AZURE_OPENAI` | Yes | Set to `1` to enable Azure OpenAI |
| `AZURE_OPENAI_BASE_URL` | Yes | Azure resource base URL; `AZURE_OPENAI_ENDPOINT` is also accepted |
| `AZURE_OPENAI_API_VERSION` | No | API version; defaults to `2025-04-01-preview` |
| `AZURE_OPENAI_API_KEY` | Yes | Azure OpenAI API key |
| `AZURE_OPENAI_CODEX_DEPLOYMENT` | Model-dependent | Azure deployment name for Codex models |

Example:

```bash
CLAUDE_CODE_USE_AZURE_OPENAI=1
AZURE_OPENAI_BASE_URL=https://your-resource.cognitiveservices.azure.com
AZURE_OPENAI_API_VERSION=2025-04-01-preview
AZURE_OPENAI_API_KEY=your_azure_openai_key
AZURE_OPENAI_CODEX_DEPLOYMENT=your_codex_deployment
```

### Local runtime and privacy

| Variable | Description |
|----------|-------------|
| `CLAUDE_CONFIG_DIR` | Use a specific configuration directory instead of `~/.claude`; useful for portable mode and isolated tests |
| `CLAUDE_CODE_FORCE_RECOVERY_CLI` | Set to `1` to use the simplified Recovery CLI |
| `CLAUDE_CODE_SHELL_PREFIX` | Prefix Bash tool commands, for example `wsl -e bash -lc` on Windows |
| `DISABLE_TELEMETRY` | Set to `1` to disable telemetry |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | Set to `1` to disable non-essential network requests |

See [Local Server](../reference/local-server.md) for `SERVER_HOST`, `SERVER_PORT`, `SERVER_AUTH_REQUIRED`, and related variables.

## Configuration methods

### Desktop providers

Desktop stores the provider index at:

```text
~/.claude/cc-haha/providers.json
```

Provider-managed environment data is written to an isolated Haha configuration. You do not need to copy it into `~/.claude/settings.json`. When the CLI finds an active provider, it reuses its credentials, models, and protocol settings. Providers using `openai_chat` or `openai_responses` automatically use a loopback proxy.

See [Third-Party Models](./third-party-models.md) for the setup flow.

### Repository `.env`

The source `bin/claude-haha` launcher loads a `.env` file from the repository root when it exists:

```bash
cp .env.example .env
```

Minimal example for an Anthropic-compatible endpoint:

```bash
ANTHROPIC_AUTH_TOKEN=sk-example
ANTHROPIC_BASE_URL=https://provider.example.com/anthropic
ANTHROPIC_MODEL=provider-model
ANTHROPIC_DEFAULT_HAIKU_MODEL=provider-model
ANTHROPIC_DEFAULT_SONNET_MODEL=provider-model
ANTHROPIC_DEFAULT_OPUS_MODEL=provider-model
```

The repository `.env` is only for source launches. CLI processes created by Desktop skip it so a stale key cannot replace the active provider.

### `settings.json`

User settings live at `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "sk-example",
    "ANTHROPIC_BASE_URL": "https://provider.example.com/anthropic",
    "ANTHROPIC_MODEL": "provider-model"
  }
}
```

A project can also contain `.claude/settings.json` or `.claude/settings.local.json`. These files are workspace input. Use them only in trusted projects, especially when they define `PATH`, `LD_PRELOAD`, proxy endpoints, or authentication variables.

## Effective precedence

There is no reliable three-step rule such as “shell > `.env` > settings”:

1. `bin/claude-haha` first lets Bun load the repository `.env`.
2. CLI initialization merges enabled user, project, local, command-line, and managed setting sources.
3. An active Haha provider overrides provider-routing values from ordinary Claude settings so the two clients do not contaminate each other.
4. Runtime values injected by the Desktop host are protected from same-name fields in `settings.json`.
5. Enterprise policy and `--setting-sources` can also change the effective result.

Keep one primary provider configuration source. Desktop users should use the Providers page; CLI-only users should choose either `.env` or user-level `settings.json`.

## Security guidance

- Never commit `.env`, provider configuration, or a `settings.json` containing secrets.
- Do not expose full tokens in screenshots, issues, logs, or diagnostic archives.
- Use `CLAUDE_CONFIG_DIR` to isolate tests from real user configuration.
- `--print` skips the workspace trust dialog and must only run in trusted directories. See [CLI Reference](./cli-reference.md).
- Do not treat CORS as authentication when exposing the local server. Enable an H5 token or explicit authentication.
