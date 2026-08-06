/**
 * Adapter 配置加载
 *
 * 优先级：环境变量 > ~/.claude/adapters.json > 默认值
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export type PairedUser = {
  userId: string | number
  displayName: string
  pairedAt: number
}

export type PairingState = {
  code: string | null
  expiresAt: number | null
  createdAt: number | null
}

export type TelegramConfig = {
  botToken: string
  allowedUsers: number[]
  pairedUsers: PairedUser[]
  defaultWorkDir: string
  allowedProjectRoots: string[]
}

export type FeishuConfig = {
  appId: string
  appSecret: string
  encryptKey: string
  verificationToken: string
  allowedUsers: string[]
  pairedUsers: PairedUser[]
  defaultWorkDir: string
  streamingCard: boolean
  allowedProjectRoots: string[]
}

export type WechatConfig = {
  accountId: string
  botToken: string
  baseUrl: string
  userId: string
  allowedUsers: string[]
  pairedUsers: PairedUser[]
  defaultWorkDir: string
  allowedProjectRoots: string[]
}

export type DingtalkConfig = {
  clientId: string
  clientSecret: string
  allowedUsers: string[]
  pairedUsers: PairedUser[]
  defaultWorkDir: string
  endpoint: string
  permissionCardTemplateId: string
  allowedProjectRoots: string[]
}

export type WhatsAppConfig = {
  accountJid: string
  authDir: string
  allowedUsers: string[]
  pairedUsers: PairedUser[]
  defaultWorkDir: string
  allowedProjectRoots: string[]
}

export type AdapterConfig = {
  serverUrl: string
  defaultProjectDir: string
  pairing: PairingState
  allowedProjectRoots: string[]
  telegram: TelegramConfig
  feishu: FeishuConfig
  wechat: WechatConfig
  dingtalk: DingtalkConfig
  whatsapp: WhatsAppConfig
}

export type AdapterPlatformConfig =
  | TelegramConfig
  | FeishuConfig
  | WechatConfig
  | DingtalkConfig
  | WhatsAppConfig

function getConfigPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  return path.join(configDir, 'adapters.json')
}

function loadFile(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'))
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      console.warn(`[Config] Failed to parse ${getConfigPath()}, using defaults`)
    }
    return {}
  }
}

export function loadConfig(): AdapterConfig {
  const file = loadFile()
  const tg = file.telegram ?? {}
  const fs_ = file.feishu ?? {}
  const wc = file.wechat ?? {}
  const dt = file.dingtalk ?? {}
  const wa = file.whatsapp ?? {}
  const pairing = file.pairing ?? {}
  const fallbackWorkDir = resolveUserDefaultWorkDir()
  const whatsappAuthDir = resolveConfiguredPath(
    process.env.WHATSAPP_AUTH_DIR || wa.authDir || defaultWhatsAppAuthDir(),
  )

  return {
    serverUrl: process.env.ADAPTER_SERVER_URL || file.serverUrl || 'ws://127.0.0.1:3456',
    defaultProjectDir: file.defaultProjectDir || '',
    pairing: {
      code: pairing.code ?? null,
      expiresAt: pairing.expiresAt ?? null,
      createdAt: pairing.createdAt ?? null,
    },
    // File scope only. ADAPTER_ALLOWED_PROJECT_ROOTS is applied by
    // resolveAllowedProjectRoots so this field keeps one meaning.
    allowedProjectRoots: readProjectRoots(file.allowedProjectRoots),
    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN || tg.botToken || '',
      allowedUsers: tg.allowedUsers ?? [],
      pairedUsers: tg.pairedUsers ?? [],
      defaultWorkDir: tg.defaultWorkDir || fallbackWorkDir,
      allowedProjectRoots: readProjectRoots(tg.allowedProjectRoots),
    },
    feishu: {
      appId: process.env.FEISHU_APP_ID || fs_.appId || '',
      appSecret: process.env.FEISHU_APP_SECRET || fs_.appSecret || '',
      encryptKey: process.env.FEISHU_ENCRYPT_KEY || fs_.encryptKey || '',
      verificationToken: process.env.FEISHU_VERIFICATION_TOKEN || fs_.verificationToken || '',
      allowedUsers: fs_.allowedUsers ?? [],
      pairedUsers: fs_.pairedUsers ?? [],
      defaultWorkDir: fs_.defaultWorkDir || fallbackWorkDir,
      streamingCard: fs_.streamingCard ?? false,
      allowedProjectRoots: readProjectRoots(fs_.allowedProjectRoots),
    },
    wechat: {
      accountId: process.env.WECHAT_ACCOUNT_ID || wc.accountId || '',
      botToken: process.env.WECHAT_BOT_TOKEN || wc.botToken || '',
      baseUrl: process.env.WECHAT_BASE_URL || wc.baseUrl || 'https://ilinkai.weixin.qq.com',
      userId: process.env.WECHAT_USER_ID || wc.userId || '',
      allowedUsers: wc.allowedUsers ?? [],
      pairedUsers: wc.pairedUsers ?? [],
      defaultWorkDir: wc.defaultWorkDir || fallbackWorkDir,
      allowedProjectRoots: readProjectRoots(wc.allowedProjectRoots),
    },
    dingtalk: {
      clientId: process.env.DINGTALK_CLIENT_ID || dt.clientId || '',
      clientSecret: process.env.DINGTALK_CLIENT_SECRET || dt.clientSecret || '',
      allowedUsers: dt.allowedUsers ?? [],
      pairedUsers: dt.pairedUsers ?? [],
      defaultWorkDir: dt.defaultWorkDir || fallbackWorkDir,
      endpoint: process.env.DINGTALK_STREAM_ENDPOINT || dt.endpoint || 'https://api.dingtalk.com',
      permissionCardTemplateId: process.env.DINGTALK_PERMISSION_CARD_TEMPLATE_ID || dt.permissionCardTemplateId || '',
      allowedProjectRoots: readProjectRoots(dt.allowedProjectRoots),
    },
    whatsapp: {
      accountJid: process.env.WHATSAPP_ACCOUNT_JID || wa.accountJid || '',
      authDir: whatsappAuthDir,
      allowedUsers: wa.allowedUsers ?? [],
      pairedUsers: wa.pairedUsers ?? [],
      defaultWorkDir: wa.defaultWorkDir || fallbackWorkDir,
      allowedProjectRoots: readProjectRoots(wa.allowedProjectRoots),
    },
  }
}

export function getConfiguredWorkDir(config: AdapterConfig, platformConfig: AdapterPlatformConfig): string {
  return config.defaultProjectDir || platformConfig.defaultWorkDir
}

/**
 * Resolve the directories an IM adapter is allowed to reach.
 *
 * This is deliberately NOT derived from `defaultWorkDir` (#1191). That field is
 * documented as the *default* work dir for new IM sessions, not a boundary, and
 * using it as the sole allowed root broke both directions:
 *
 *   - configured → /projects listed only that one project, and picking any other
 *     recent project by name or path failed;
 *   - blank      → it falls back to PWD/cwd(), which for a Finder-launched .app
 *     is "/", so the boundary silently allowed the entire filesystem.
 *
 * Precedence: ADAPTER_ALLOWED_PROJECT_ROOTS > platform-specific roots > global
 * roots > default (home ∪ default work dir). The pairing gate is the primary
 * authorization control; these roots are defense-in-depth, so a misconfigured
 * value falls back to the default with a warning instead of bricking the bot.
 *
 * Explicitly configured roots are honoured verbatim — if someone types "/" they
 * own the machine and mean it. The *default* branch refuses to inherit such a
 * root, because that is how the boundary silently became vacuous before.
 */
export function resolveAllowedProjectRoots(
  config: AdapterConfig,
  platformConfig: AdapterPlatformConfig,
): string[] {
  // Env wins over both file scopes, matching how every other field in this
  // module resolves.
  const configured = readEnvProjectRoots()
    ?? (platformConfig.allowedProjectRoots.length > 0
      ? platformConfig.allowedProjectRoots
      : config.allowedProjectRoots)

  if (configured.length > 0) {
    const candidates = configured.map(resolveExistingDirectory)
    // Count the misses before dedup — duplicates are not missing directories.
    const missing = candidates.filter((value) => !value).length
    const resolved = dedupePaths(candidates)
    if (resolved.length > 0) {
      if (missing > 0) {
        console.warn(
          missing === 1
            ? '[Config] Ignoring 1 allowedProjectRoots entry that does not exist'
            : `[Config] Ignoring ${missing} allowedProjectRoots entries that do not exist`,
        )
      }
      return resolved
    }
    console.warn(
      '[Config] None of the configured allowedProjectRoots exist; ' +
      'falling back to the default roots (home directory + default project dir)',
    )
  }

  const home = resolveExistingDirectory(os.homedir())
  const defaults = dedupePaths([
    home,
    // Only inherit the default work dir as a boundary when it is a real project
    // directory. "/" and "/Users" reach every project on the machine, so taking
    // them from the PWD/cwd() fallback would make the boundary meaningless.
    usableAsBoundary(resolveExistingDirectory(getConfiguredWorkDir(config, platformConfig))),
  ])
  if (defaults.length > 0) return defaults
  // Only reachable if the home directory itself does not resolve. The adapter
  // client drops unresolvable roots, so this is a best effort, not a guarantee.
  return [os.homedir()]
}

/**
 * Directories the IM boundary must never inherit implicitly: a filesystem root,
 * or any strict ancestor of the home directory (`/`, `/Users`, `/home`).
 */
function usableAsBoundary(dir: string | null): string | null {
  if (!dir) return null
  if (path.parse(dir).root === dir) return null
  return isStrictAncestor(dir, os.homedir()) ? null : dir
}

function isStrictAncestor(candidate: string, target: string): boolean {
  const relative = path.relative(candidate, target)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/**
 * The work dir a new IM session starts in, paired with the boundary it must sit
 * inside. Resolving them together is the point: the two are configured
 * separately, and a default project outside the allowed roots would otherwise
 * make every `/new` (and every first message in a fresh chat) fail the client's
 * own boundary check.
 */
export function resolveAdapterWorkspace(
  config: AdapterConfig,
  platformConfig: AdapterPlatformConfig,
): { defaultWorkDir: string; allowedProjectRoots: string[] } {
  const allowedProjectRoots = resolveAllowedProjectRoots(config, platformConfig)
  const configured = resolveExistingDirectory(getConfiguredWorkDir(config, platformConfig))

  if (configured && isPathWithinRoots(configured, allowedProjectRoots)) {
    return { defaultWorkDir: configured, allowedProjectRoots }
  }

  const fallback = allowedProjectRoots[0] ?? os.homedir()
  if (configured) {
    console.warn(
      `[Config] Default project ${configured} is outside the allowed project roots; ` +
      `new sessions will start in ${fallback}`,
    )
  }
  return { defaultWorkDir: fallback, allowedProjectRoots }
}

function isPathWithinRoots(target: string, roots: string[]): boolean {
  return roots.some((root) => {
    const relative = path.relative(root, target)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  })
}

function readProjectRoots(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
}

function readEnvProjectRoots(): string[] | null {
  const raw = process.env.ADAPTER_ALLOWED_PROJECT_ROOTS?.trim()
  if (!raw) return null
  const roots = readProjectRoots(raw.split(path.delimiter))
  // A delimiter-only value (an unset "$A:$B" in a launcher script) must not read
  // as "the env configured an empty boundary" and discard the file config.
  return roots.length > 0 ? roots : null
}

function dedupePaths(values: (string | null)[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

function resolveUserDefaultWorkDir(): string {
  const candidates = [
    process.env.ADAPTER_DEFAULT_PROJECT_DIR,
    process.env.CLAUDE_ADAPTER_DEFAULT_WORK_DIR,
    process.env.PWD,
    process.cwd(),
  ]

  for (const candidate of candidates) {
    // A GUI-launched sidecar inherits cwd "/" (Electron passes no cwd), which is
    // useless as a place to start a session and unusable as a boundary.
    const resolved = usableAsBoundary(resolveExistingDirectory(candidate))
    if (resolved) return resolved
  }

  return resolveExistingDirectory(os.homedir()) ?? os.homedir()
}

function resolveExistingDirectory(value: string | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null

  const expanded = trimmed === '~'
    ? os.homedir()
    : trimmed.startsWith('~/')
      ? path.join(os.homedir(), trimmed.slice(2))
      : trimmed

  // Relative entries would resolve against the sidecar's cwd ("/" for a packaged
  // app), making the boundary depend on how the app was launched.
  if (!path.isAbsolute(expanded)) return null

  try {
    const realPath = fs.realpathSync(expanded)
    return fs.statSync(realPath).isDirectory() ? realPath : null
  } catch {
    return null
  }
}

function defaultWhatsAppAuthDir(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  return path.join(configDir, 'whatsapp-auth', 'default')
}

function resolveConfiguredPath(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return defaultWhatsAppAuthDir()
  const expanded = trimmed === '~'
    ? os.homedir()
    : trimmed.startsWith('~/')
      ? path.join(os.homedir(), trimmed.slice(2))
      : trimmed
  return path.resolve(expanded)
}
