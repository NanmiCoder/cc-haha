---
title: Connect a model
nav_title: Connect a model
description: Official accounts, third-party APIs, or a local model — pick one and be running in ten minutes.
order: 2
---

# Connect a model

Claude Code Haha ships without a model. It's the shell that does the work; you have to give it a brain first.

Click "Settings" at the bottom of the sidebar, then pick the first tab, "Providers". From there you have three routes:

- **You have an official account** — Claude, ChatGPT, and Grok each have a built-in card. One click opens a browser sign-in. No API key to type.
- **You have a third-party API key** — DeepSeek, Kimi, Zhipu GLM and others come as presets. Paste the key and you're done.
- **You want it free** — run LM Studio or Ollama on your own machine. The model runs on your GPU, costs nothing, and works offline.

You can configure all three and switch between them in the provider list.

## Sign in with an official account

Three cards sit at the top of Settings → Providers:

| Card | What you need |
|---|---|
| **Claude Official** | A Claude.ai account (Pro / Max subscription, or an API account with credit) |
| **ChatGPT Official** | A ChatGPT account, via OpenAI OAuth |
| **Grok Official** | An xAI account, via official Grok OAuth |

Click the sign-in button on the card ("Sign in to Claude" / "Sign in with ChatGPT" / "Sign in with Grok"). Your system browser opens the provider's authorization page; complete it with the same account and the browser hands you back to the app, where the card now reads as signed in.

Three things to watch for:

- Leave Claude Code Haha running for the whole flow — the callback has to land in the running app.
- If the browser doesn't open by itself, click "Copy authorization link" and paste it in manually.
- Proxies and blocking browser extensions can intercept either the authorization page or the local callback. Turn them off before retrying.

Which models you get afterwards depends on your account tier and entitlements, not on the app. A model name appearing in documentation doesn't mean your account can call it.

## Third-party API providers

With an API key in hand, this is the fastest route. Click "Add Provider", pick something under "Preset", and the base URL and default models are filled in for you — all you supply is the key.

The built-in presets, as they appear in the dialog:

- **DeepSeek** · **Zhipu GLM** · **Kimi** · **MiniMax** — major Chinese model vendors; the base URLs point at each one's Anthropic-compatible endpoint.
- **接口AI (JiekouAI)** · **胜算云 (Shengsuanyun)** · **TeamoRouter** — routing services that give you access to official Claude models through their own gateway.
- **LM Studio** · **Ollama** — local models; see the next section.
- **Custom** — anything not listed above.

When a preset has a signup page for API keys, a "Get API Key" button appears under the key field.

## Local models

To spend nothing and stay offline, run a model server on your machine and point the app at it.

**LM Studio**: load a model, start the local server, then choose the `LM Studio` preset in "Add Provider" with base URL `http://localhost:1234`.

**Ollama**: run `ollama serve`, choose the `Ollama` preset, and use base URL `http://localhost:11434`.

Two hard requirements:

1. **Do not append `/v1` to the base URL.** Both of these expose an Anthropic-compatible protocol and the app uses that path. Adding `/v1` gives you a straight 404.
2. **Raise the context window — at least 200K.** Claude Code's system prompt, tool definitions, and Skills consume a substantial amount of context before your first message. A default 4K or 8K window can't even hold the opening. Change this in LM Studio or Ollama's own model settings, not in this app.

Whether a local model can actually sustain an agent workflow comes down to its tool-calling ability. Small models often talk endlessly without ever calling a tool — that's the model, not your configuration.

## The Add Provider dialog, field by field

![Add Provider dialog: preset, base URL, auth variable, API key, model mapping](../../images/app/settings-provider-add.webp)

**Name** (required) — how this provider appears in the list. A preset fills it in; rename it to something you'll recognize, like "DeepSeek — work account".

**Notes** — a line for yourself, e.g. "expires end of month". Doesn't affect any request.

**Base URL** (required) — the provider's API root, not its marketing site. Presets get this right. When entering it yourself, watch for duplicated path segments: if the URL already ends in `/anthropic`, don't also append `/v1/messages`.

**Auth Variable** — decides how your key is transmitted. Five options:

| Option | When to use it |
|---|---|
| API Key (`ANTHROPIC_API_KEY`) | Direct Anthropic API access, sends an `x-api-key` header |
| Bearer Token (`ANTHROPIC_AUTH_TOKEN`) | Nearly all third-party Anthropic-compatible services, sends `Authorization: Bearer` |
| Bearer + Empty API_KEY | OpenRouter, Ollama and similar, which must not fall back to an Anthropic key |
| Write token to both variables | Services like Hugging Face Router that check both |
| Write dummy to both variables | Local vLLM-style services that only need placeholder auth |

Presets pick the right one. If you're guessing, start with Bearer Token and switch to API Key if you get a 401.

**Enable Tool Search** (on by default) — loads MCP tools and part of the tool definitions on demand, saving a large chunk of schema tokens on the first turn. It depends on the model supporting `tool_reference`. **Turn it off for weaker models, or for providers that reject this request shape.**

**Disable experimental beta headers** — sets `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` for this provider. Some third-party gateways error out on beta-shaped API requests; checking this stops the headers being sent. **Try this first when you see a 400 or an "unsupported parameter" error.**

**API Key** (required except for local models) — copied from the provider's console. Watch for leading or trailing whitespace when pasting. The key stays on your machine.

**Model Mapping** — four slots, each taking a **model ID**, not a product name:

- **Main Model** (required) — the model used for conversation. It must support tool calling.
- **Haiku Model** — leave blank to follow the main model. This slot handles lightweight work like title generation and file summaries; mapping it to a cheap small model saves real money.
- **Sonnet Model / Opus Model** — leave blank to follow the main model. Fill these in only when you actually want tiering.

Each slot has a `1M` checkbox. Tick it only if that model genuinely supports a one-million-token context window.

**API Format** — this field only appears when you pick the `Custom` preset or edit an existing provider. Three options: Anthropic Messages (native), OpenAI Chat Completions (proxied), and OpenAI Responses API (proxied). The proxied formats are translated by a loopback proxy the app starts locally — you don't deploy anything. Every built-in preset uses Anthropic native, which is why the field is hidden for them.

Click "Add" when you're done.

## After saving

Back in the provider list, on the entry you just created:

1. Click "Test". Anthropic-native providers run one step, "① Connectivity"; OpenAI formats add "② Proxy pipeline". Both must pass.
2. Click "Set default" so new sessions use it.
3. Multiple providers can be dragged to reorder. Order only affects how the list is displayed.

Then start a new session and **pick the specific model from the model selector at the bottom right of the composer** — that list reflects what the active provider actually offers. The control next to it sets reasoning effort; leave it at the default if you're unsure.

:::tip
A passing test isn't a guarantee. It proves the endpoint is reachable and the credentials work — not that the model can sustain tool calls and long context. The real check is asking for a task that edits a file, and seeing whether it actually does.
:::

Getting a 401, a connection failure, or an empty model list? See the model section of [Won't install, won't open, won't connect](./troubleshooting.md).

With a model connected, go [run your first session](./first-session.md).
