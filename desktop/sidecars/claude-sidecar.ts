/**
 * Claude Code 桌面端合并 sidecar 入口。
 *
 * 历史上 server / cli / IM adapters 是各自独立的进程。每个 bun-compile
 * 二进制都要带一份 ~55MB 的 bun runtime，光这一项就重复占了 100MB+。
 * 把所有运行模式合并到同一个二进制里，runtime 只保留一份；调用方通过
 * 第一个 positional 参数选择模式：
 *
 *   claude-sidecar server   --app-root <path> --host 127.0.0.1 --port 12345
 *   claude-sidecar cli      --app-root <path> [其它 CLI 参数...]
 *   claude-sidecar adapters --app-root <path> [--feishu] [--telegram] [--wechat]
 *                           [--dingtalk] [--whatsapp] [--wecom] [--qq] [--slack]
 *
 * 任何模式都必须先做 process.env / process.argv 设置，再 await 进入相应的
 * 子模块树。原因：src/server/index.ts、src/entrypoints/cli.tsx、以及
 * adapters/feishu/index.ts 等顶层都会立即读 process.argv / process.env，
 * 必须在它们求值前 splice 掉 --app-root、mode 和各 adapter 的 flag 这些
 * launcher-only 参数。
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
    // 副作用 import：feishu/index.ts 顶层会自动 new WSClient + start()
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
  // adapters 模式的参数解析独立于 server/cli —— 这里只接受 ADAPTERS 里的
  // flag 选择启用哪个适配器，再加可选的 --app-root（透传给
  // adapters/common/config.ts 内的 process.env 读取）。
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

  // 在 import adapter 之前先用同一份 loadConfig() 检查凭据。adapter 的
  // top-level 代码里已经有 if (!cred) process.exit(1)，但那会把整个
  // 进程拖死 —— 包括另一个本来正常的 adapter。这里提前 gate 一下，
  // 缺凭据的 adapter 直接跳过、不 import。
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
    console.error(
      '[claude-sidecar] no adapter could be started — check credentials in env or ~/.claude/adapters.json',
    )
    process.exit(1)
  }

  // 让进程保持存活：每个 adapter 都通过 long-lived WebSocket（Lark WSClient
  // / grammY long-polling / Socket Mode 等）持有 event loop，自然不会退出。
  // 这里不需要额外 setInterval 兜底。adapter 自己注册的 SIGINT handler 都会触发。
}
