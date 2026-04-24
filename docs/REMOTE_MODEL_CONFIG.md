# Remote Model Config

The desktop app can now read remote model controls from the `data` object of:

- `GET https://aiapi.space/api/status`

This is meant for backend-side control of which models are visible in the desktop app, how they are ordered, and how internal alias models should route for sub-tasks and fast-path requests.

## Supported fields

### Preferred format

Use one of these keys on `status.data`:

- `desktop_models_config`
- `desktop_model_config`
- `desktop_models_json`
- `desktop_models`

The value may be either:

- a JSON string
- or a plain object

Example:

```json
{
  "desktop_models_config": {
    "providerName": "丸美小沐",
    "defaultModel": "gemini-3.1-pro-preview",
    "models": [
      {
        "id": "gemini-3.1-pro-preview",
        "name": "Gemini Pro+",
        "description": "主力写作模型",
        "context": "1m",
        "routing": {
          "haiku": "gpt-5.4",
          "sonnet": "gemini-3.1-pro-preview",
          "opus": "gemini-3.1-pro-preview",
          "smallFast": "gpt-5.4"
        }
      },
      {
        "id": "gpt-5.4",
        "name": "GPT-5.4",
        "description": "通用备用模型",
        "context": "200k"
      }
    ]
  }
}
```

## Supported object keys

- `providerName`: Optional. Overrides the provider label shown by `/api/models`.
- `defaultModel` / `defaultModelId`: Optional. Used when the user has not explicitly selected a model, or when the previously selected model is no longer visible.
- `models`: Optional array of models. Array order is preserved.
- `visibleModels` / `visibleModelIds` / `modelIds`: Optional array of model IDs when you only want filtering without inline metadata.
- `order` / `modelOrder`: Optional array of model IDs to reorder the final list.
- `routing` / `modelRouting`: Optional map of model ID to internal routing.

## Model entry shape

Each item in `models` may be:

- a string model ID, or
- an object

Supported object fields:

- `id` / `modelId` / `model` / `model_name`
- `name` / `displayName` / `display_name`
- `description` / `desc` / `subtitle`
- `context` / `contextWindow` / `context_window`
- `enabled`, `visible`, `disabled`
- `routing`
- top-level routing keys:
  - `main`
  - `haiku`
  - `sonnet`
  - `opus`
  - `smallFast`

## Legacy compatible fields

These are still supported on `status.data`:

- `desktop_visible_models`
  - CSV whitelist, for example: `"gpt-5.4,gemini-3.1-pro-preview,claude-sonnet-4-6"`
- `desktop_model_order`
  - CSV or JSON array
- `desktop_default_model`
- `desktop_model_routing`
  - JSON string or object map

## Routing behavior

When the user selects a model:

- `ANTHROPIC_MODEL` uses the selected model
- `ANTHROPIC_DEFAULT_HAIKU_MODEL`
- `ANTHROPIC_DEFAULT_SONNET_MODEL`
- `ANTHROPIC_DEFAULT_OPUS_MODEL`
- `ANTHROPIC_SMALL_FAST_MODEL`

will all follow the remote routing config for that model.

If no routing is provided, all aliases fall back to the selected model itself.

This ensures:

- chat model selection
- title generation
- fast-path requests
- internal sub-tasks / agents

stay on a compatible route instead of falling back to old hardcoded defaults.
