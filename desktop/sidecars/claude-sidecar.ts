/**
 * Merged sidecar entry point for the Claude Code desktop app.
 *
 * server / cli / IM adapters used to be separate processes. Each bun-compiled
 * binary carried its own ~55MB bun runtime, duplicating 100MB+ on that alone.
 * Merging every mode into one binary keeps a single runtime; callers pick the
 * mode with the first positional argument:
 *
 *   claude-sidecar server   --app-root <path> --host 127.0.0.1 --port 12345
 *   claude-sidecar cli      --app-root <path> [other CLI args...]
 *   claude-sidecar adapters --app-root <path> [--feishu] [--telegram] [--wechat]
 *                           [--dingtalk] [--whatsapp] [--wecom] [--qq] [--slack]
 *
 * Every mode must set up process.env / process.argv before awaiting its module
 * tree. src/server/index.ts, src/entrypoints/cli.tsx, adapters/feishu/index.ts
 * and others read process.argv / process.env at top level, so the launcher-only
 * arguments (--app-root, the mode, adapter flags) must be spliced out before
 * those modules evaluate.
 */

import { parseLauncherArgs, resolveSidecarInvocation } from './launcherRouting'

// The compiled Computer Use runtime relaunches this executable directly. Its
// isolated worker has no app-root and must not load preload, CLI configuration,
// providers, or any desktop mode before serving the JSON-only kernel protocol.
if (process.argv[2] === '--computer-use-repl-worker') {
  const { runComputerUseReplWorker } = await import('../../src/utils/computerUse/replWorker')
  await runComputerUseReplWorker()
  process.exit(0)
}

// Local speech recognition runs in this same executable, relaunched by the
// server's voice recognizer. Like the worker above it must stay isolated: it
// reads its private configuration from the environment, loads the downloaded
// sherpa-onnx runtime by absolute path, and needs none of the desktop modes.
if (process.argv[2] === '--voice-worker') {
  const { runVoiceWorker } = await import('../../src/server/services/voice/sherpa/worker')
  await runVoiceWorker()
  process.exit(0)
}

type AdapterConfigShape = Awaited<
  ReturnType<typeof import('../../adapters/common/config.ts')['loadConfig']>
>

/**
 * One row per IM adapter: its CLI flag, how to tell whether it is configured,
 * and how to start it.
 *
 * Every adapter previously carried its own copy of the flag parse, the
 * credential gate and the side-effect import. That is exactly the shape where
 * the next copy forgets the gate — and a missing gate lets one unconfigured
 * adapter's `process.exit(1)` take down every other adapter in the sidecar.
 *
 * Declared above the mode dispatch on purpose: `runAdapters` is hoisted and
 * runs at module top level, so a table declared below it would still be in its
 * temporal dead zone when the adapters mode reads it.
 */
const ADAPTERS: ReadonlyArray<{
  flag: string
  label: string
  missingCredentials: string
  isConfigured: (config: AdapterConfigShape) => boolean | Promise<boolean>
  start: () => Promise<unknown>
}> = [
  {
    flag: '--feishu',
    label: 'Feishu',
    missingCredentials: 'FEISHU_APP_ID / FEISHU_APP_SECRET missing',
    isConfigured: (config) => Boolean(config.feishu.appId && config.feishu.appSecret),
    // Side-effect import: feishu/index.ts creates a WSClient and calls start() at top level
    start: () => import('../../adapters/feishu/index.ts'),
  },
  {
    flag: '--telegram',
    label: 'Telegram',
    missingCredentials: 'TELEGRAM_BOT_TOKEN missing',
    isConfigured: (config) => Boolean(config.telegram.botToken),
    start: () => import('../../adapters/telegram/index.ts'),
  },
  {
    flag: '--wechat',
    label: 'WeChat',
    missingCredentials: 'no QR-bound WeChat account found',
    isConfigured: (config) => Boolean(config.wechat.accountId && config.wechat.botToken),
    start: () => import('../../adapters/wechat/index.ts'),
  },
  {
    flag: '--dingtalk',
    label: 'DingTalk',
    missingCredentials: 'DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET missing',
    isConfigured: (config) => Boolean(config.dingtalk.clientId && config.dingtalk.clientSecret),
    start: () => import('../../adapters/dingtalk/index.ts'),
  },
  {
    flag: '--whatsapp',
    label: 'WhatsApp',
    missingCredentials: 'no QR-linked WhatsApp account found',
    isConfigured: async (config) => {
      const { hasWhatsAppAuth } = await import('../../adapters/whatsapp/session.ts')
      return hasWhatsAppAuth(config.whatsapp.authDir)
    },
    start: () => import('../../adapters/whatsapp/index.ts'),
  },
  {
    flag: '--wecom',
    label: 'WeCom',
    missingCredentials: 'WECOM_BOT_ID / WECOM_BOT_SECRET missing',
    isConfigured: (config) => Boolean(config.wecom.botId && config.wecom.secret),
    start: () => import('../../adapters/wecom/index.ts'),
  },
  {
    flag: '--qq',
    label: 'QQ',
    missingCredentials: 'QQ_APP_ID / QQ_APP_SECRET missing',
    isConfigured: (config) => Boolean(config.qq.appId && config.qq.appSecret),
    start: () => import('../../adapters/qq/index.ts'),
  },
  {
    flag: '--slack',
    label: 'Slack',
    missingCredentials: 'SLACK_BOT_TOKEN / SLACK_APP_TOKEN missing',
    isConfigured: (config) => Boolean(config.slack.botToken && config.slack.appToken),
    start: () => import('../../adapters/slack/index.ts'),
  },
]

const rawArgs = process.argv.slice(2)
const invocation = resolveSidecarInvocation(rawArgs)
if (!invocation.mode) {
  console.error('claude-sidecar: missing mode argument (expected "server", "cli" or "adapters")')
  process.exit(2)
}
const mode = invocation.mode
const restArgs = invocation.restArgs

if (mode === 'adapters') {
  await runAdapters(restArgs)
} else {
  const { appRoot, args } = parseLauncherArgs(restArgs, invocation.defaultAppRoot)

  process.env.CLAUDE_APP_ROOT = appRoot
  process.env.CALLER_DIR ||= process.cwd()
  process.argv = [process.argv[0]!, process.argv[1]!, ...args]

  await import('../../preload.ts')

  if (mode === 'server') {
    console.log(`[claude-sidecar] starting server mode (${process.platform}/${process.arch})`)
    const { startServer } = await import('../../src/server/index.ts')
    startServer()
  } else if (mode === 'cli') {
    await import('../../src/entrypoints/cli.tsx')
  } else {
    console.error(`claude-sidecar: unknown mode "${mode}" (expected "server", "cli" or "adapters")`)
    process.exit(2)
  }
}

async function runAdapters(rawArgs: string[]): Promise<void> {
  // Adapter-mode argument parsing is separate from server/cli: it only accepts
  // flags from ADAPTERS to choose which adapters run, plus an optional --app-root
  // (passed through to the process.env reads in adapters/common/config.ts).
  let appRoot: string | null = process.env.CLAUDE_APP_ROOT ?? null
  const enabled = new Set<string>()
  const knownFlags = new Set(ADAPTERS.map((adapter) => adapter.flag))

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i]
    if (arg === '--app-root') {
      appRoot = rawArgs[i + 1] ?? null
      i += 1
      continue
    }
    if (arg && knownFlags.has(arg)) {
      enabled.add(arg)
      continue
    }
    console.warn(`claude-sidecar adapters: ignoring unknown arg "${arg}"`)
  }

  if (enabled.size === 0) {
    console.error(
      `claude-sidecar adapters: must enable at least one of ${[...knownFlags].join(' / ')}`,
    )
    process.exit(2)
  }

  if (appRoot) {
    process.env.CLAUDE_APP_ROOT = appRoot
  }
  process.env.CALLER_DIR ||= process.cwd()

  await import('../../preload.ts')

  // Check credentials with the same loadConfig() before importing an adapter.
  // Adapter top-level code already does if (!cred) process.exit(1), but that
  // kills the whole process, including any other adapter that was fine. Gating
  // here skips an adapter with missing credentials without importing it.
  const { loadConfig } = await import('../../adapters/common/config.ts')
  const config = loadConfig()

  let started = 0
  for (const adapter of ADAPTERS) {
    if (!enabled.has(adapter.flag)) continue
    if (!(await adapter.isConfigured(config))) {
      console.warn(
        `[claude-sidecar] ${adapter.flag} requested but ${adapter.missingCredentials} in env or ~/.claude/adapters.json — skipping`,
      )
      continue
    }
    console.log(`[claude-sidecar] starting ${adapter.label} adapter`)
    await adapter.start()
    started += 1
  }

  if (started === 0) {
    if (process.env.CC_HAHA_MIGRATION_CONTROL === '1') {
      // No platform module was imported, so this process owns no adapter writes.
      // Publish that fact before exit: the host may already be requesting drain.
      process.stdout.write(JSON.stringify({ type: 'migration_adapter_inactive' }) + '\n', () => process.exit(0))
      return
    }
    console.error(
      '[claude-sidecar] no adapter could be started — check credentials in env or ~/.claude/adapters.json',
    )
    process.exit(1)
  }

  if (process.env.CC_HAHA_MIGRATION_CONTROL === '1' && process.env.CC_HAHA_LOCAL_ACCESS_TOKEN) {
    const { installAdapterMigrationControl } = await import('../../adapters/common/migration-control.js')
    installAdapterMigrationControl({ token: process.env.CC_HAHA_LOCAL_ACCESS_TOKEN })
  }

  // Each adapter's WebSocket / long polling holds the event loop, keeping the process alive.
}
