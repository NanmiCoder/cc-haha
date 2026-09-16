/**
 * Config loading for the platforms added alongside the QR bot flows.
 *
 * `loadConfig` is the single place where env vars, the config file and the
 * defaults meet, and every adapter's credential gate reads its result — so the
 * precedence rule is worth pinning per platform rather than assuming the new
 * blocks copied the old ones correctly.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { loadConfig, resolveAllowedProjectRoots } from '../config.js'
import { isPaired, type ImPlatform } from '../pairing.js'

let tmpDir: string
let originalConfigDir: string | undefined
const touchedEnv: string[] = []

function writeConfig(config: Record<string, unknown>): void {
  fs.writeFileSync(path.join(tmpDir, 'adapters.json'), JSON.stringify(config, null, 2))
}

function setEnv(key: string, value: string): void {
  touchedEnv.push(key)
  process.env[key] = value
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapters-config-test-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
})

afterEach(() => {
  if (originalConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  else delete process.env.CLAUDE_CONFIG_DIR
  for (const key of touchedEnv.splice(0)) delete process.env[key]
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('loadConfig for WeCom / QQ / Slack', () => {
  it('reads credentials from the config file', () => {
    writeConfig({
      wecom: { botId: 'bot-1', secret: 'secret-1' },
      qq: { appId: 'app-1', appSecret: 'secret-2' },
      slack: { botToken: 'xoxb-1', appToken: 'xapp-1' },
    })

    const config = loadConfig()

    expect(config.wecom).toMatchObject({ botId: 'bot-1', secret: 'secret-1' })
    expect(config.qq).toMatchObject({ appId: 'app-1', appSecret: 'secret-2' })
    expect(config.slack).toMatchObject({ botToken: 'xoxb-1', appToken: 'xapp-1' })
  })

  // Standalone runs configure the adapter purely through env; the file is the
  // desktop's channel. Env must win, exactly as it does for the older
  // platforms.
  it.each([
    ['WECOM_BOT_ID', 'wecom', 'botId'],
    ['WECOM_BOT_SECRET', 'wecom', 'secret'],
    ['QQ_APP_ID', 'qq', 'appId'],
    ['QQ_APP_SECRET', 'qq', 'appSecret'],
    ['SLACK_BOT_TOKEN', 'slack', 'botToken'],
    ['SLACK_APP_TOKEN', 'slack', 'appToken'],
  ] as const)('lets %s override the file value', (envKey, platform, field) => {
    writeConfig({ [platform]: { [field]: 'from-file' } })
    setEnv(envKey, 'from-env')

    expect((loadConfig()[platform] as unknown as Record<string, string>)[field]).toBe('from-env')
  })

  it('defaults every new platform to empty credentials and closed access', () => {
    const config = loadConfig()

    for (const platform of ['wecom', 'qq', 'slack'] as const) {
      expect(config[platform].allowedUsers).toEqual([])
      expect(config[platform].pairedUsers).toEqual([])
      expect(config[platform].defaultWorkDir).toBeTruthy()
    }
    expect(config.wecom.botId).toBe('')
    expect(config.qq.appId).toBe('')
    expect(config.slack.botToken).toBe('')
  })

  it('honours a per-platform project boundary that replaces the global one', () => {
    const scoped = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-'))
    try {
      writeConfig({
        allowedProjectRoots: [tmpDir],
        slack: { allowedProjectRoots: [scoped] },
      })
      const config = loadConfig()

      expect(resolveAllowedProjectRoots(config, config.slack)).toEqual([fs.realpathSync(scoped)])
      expect(resolveAllowedProjectRoots(config, config.qq)).toEqual([fs.realpathSync(tmpDir)])
    } finally {
      fs.rmSync(scoped, { recursive: true, force: true })
    }
  })
})

describe('pairing for WeCom / QQ / Slack', () => {
  // Deny-by-default is the whole authorization model: an unconfigured platform
  // must not be open, and a paired user must be recognised.
  it.each(['wecom', 'qq', 'slack'] as const)('is closed by default for %s', (platform: ImPlatform) => {
    expect(isPaired(platform, 'someone', { [platform]: { pairedUsers: [], allowedUsers: [] } }))
      .toBe(false)
  })

  it.each(['wecom', 'qq', 'slack'] as const)('recognises a paired %s user', (platform: ImPlatform) => {
    expect(
      isPaired(platform, 'someone', {
        [platform]: {
          pairedUsers: [{ userId: 'someone', displayName: 'Someone', pairedAt: 1 }],
          allowedUsers: [],
        },
      }),
    ).toBe(true)
  })

  it.each(['wecom', 'qq', 'slack'] as const)('recognises an allowlisted %s user', (platform: ImPlatform) => {
    expect(isPaired(platform, 'allowed', { [platform]: { pairedUsers: [], allowedUsers: ['allowed'] } }))
      .toBe(true)
  })
})

describe('loadConfig Feishu tenant domain', () => {
  // The scan flow can provision a bot on either brand, and the adapter picks
  // its API origin from this value — a wrong default cannot authenticate.
  it('defaults to feishu when nothing is configured', () => {
    expect(loadConfig().feishu.domain).toBe('feishu')
  })

  it('reads lark from the config file', () => {
    writeConfig({ feishu: { domain: 'lark' } })

    expect(loadConfig().feishu.domain).toBe('lark')
  })

  it('lets FEISHU_DOMAIN override the file', () => {
    writeConfig({ feishu: { domain: 'lark' } })
    setEnv('FEISHU_DOMAIN', 'feishu')

    expect(loadConfig().feishu.domain).toBe('feishu')
  })

  it('falls back to feishu for an unrecognised value rather than passing it through', () => {
    writeConfig({ feishu: { domain: 'example.com' } })

    expect(loadConfig().feishu.domain).toBe('feishu')
  })
})
