import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { getConfiguredWorkDir, loadConfig } from '../config.js'

describe('adapter config defaults', () => {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  const originalAdapterDefaultWorkDir = process.env.CLAUDE_ADAPTER_DEFAULT_WORK_DIR
  const originalAdapterDefaultProjectDir = process.env.ADAPTER_DEFAULT_PROJECT_DIR
  const originalDingtalkPermissionCardTemplateId = process.env.DINGTALK_PERMISSION_CARD_TEMPLATE_ID
  const originalPwd = process.env.PWD

  afterEach(() => {
    restoreEnv('CLAUDE_CONFIG_DIR', originalConfigDir)
    restoreEnv('CLAUDE_ADAPTER_DEFAULT_WORK_DIR', originalAdapterDefaultWorkDir)
    restoreEnv('ADAPTER_DEFAULT_PROJECT_DIR', originalAdapterDefaultProjectDir)
    restoreEnv('DINGTALK_PERMISSION_CARD_TEMPLATE_ID', originalDingtalkPermissionCardTemplateId)
    restoreEnv('PWD', originalPwd)
  })

  it('uses the user shell working directory when no default project is configured', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-config-'))
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-workdir-'))
    try {
      process.env.CLAUDE_CONFIG_DIR = configDir
      delete process.env.CLAUDE_ADAPTER_DEFAULT_WORK_DIR
      process.env.PWD = workDir

      const config = loadConfig()

      expect(config.telegram.defaultWorkDir).toBe(fs.realpathSync(workDir))
      expect(config.feishu.defaultWorkDir).toBe(fs.realpathSync(workDir))
      expect(config.wechat.defaultWorkDir).toBe(fs.realpathSync(workDir))
      expect(config.dingtalk.defaultWorkDir).toBe(fs.realpathSync(workDir))
      expect(config.whatsapp.defaultWorkDir).toBe(fs.realpathSync(workDir))
      expect(getConfiguredWorkDir(config, config.wechat)).toBe(fs.realpathSync(workDir))
      expect(getConfiguredWorkDir(config, config.dingtalk)).toBe(fs.realpathSync(workDir))
      expect(getConfiguredWorkDir(config, config.whatsapp)).toBe(fs.realpathSync(workDir))
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true })
      fs.rmSync(workDir, { recursive: true, force: true })
    }
  })

  it('keeps the explicit default project ahead of the platform default work dir', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-config-'))
    const defaultProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-project-'))
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-workdir-'))
    try {
      fs.writeFileSync(
        path.join(configDir, 'adapters.json'),
        JSON.stringify({ defaultProjectDir }),
      )
      process.env.CLAUDE_CONFIG_DIR = configDir
      process.env.CLAUDE_ADAPTER_DEFAULT_WORK_DIR = workDir

      const config = loadConfig()

      expect(getConfiguredWorkDir(config, config.wechat)).toBe(defaultProjectDir)
      expect(getConfiguredWorkDir(config, config.dingtalk)).toBe(defaultProjectDir)
      expect(getConfiguredWorkDir(config, config.whatsapp)).toBe(defaultProjectDir)
      expect(config.wechat.defaultWorkDir).toBe(fs.realpathSync(workDir))
      expect(config.dingtalk.defaultWorkDir).toBe(fs.realpathSync(workDir))
      expect(config.whatsapp.defaultWorkDir).toBe(fs.realpathSync(workDir))
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true })
      fs.rmSync(defaultProjectDir, { recursive: true, force: true })
      fs.rmSync(workDir, { recursive: true, force: true })
    }
  })

  it('accepts ADAPTER_DEFAULT_PROJECT_DIR as a sidecar-friendly default work dir override', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-config-'))
    const defaultProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-project-'))
    try {
      process.env.CLAUDE_CONFIG_DIR = configDir
      process.env.ADAPTER_DEFAULT_PROJECT_DIR = defaultProjectDir
      delete process.env.CLAUDE_ADAPTER_DEFAULT_WORK_DIR
      delete process.env.PWD

      const config = loadConfig()

      expect(getConfiguredWorkDir(config, config.wechat)).toBe(fs.realpathSync(defaultProjectDir))
      expect(getConfiguredWorkDir(config, config.dingtalk)).toBe(fs.realpathSync(defaultProjectDir))
      expect(getConfiguredWorkDir(config, config.whatsapp)).toBe(fs.realpathSync(defaultProjectDir))
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true })
      fs.rmSync(defaultProjectDir, { recursive: true, force: true })
    }
  })

  it('loads DingTalk permission card template id from file or env', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-config-'))
    try {
      fs.writeFileSync(
        path.join(configDir, 'adapters.json'),
        JSON.stringify({ dingtalk: { permissionCardTemplateId: 'file-template' } }),
      )
      process.env.CLAUDE_CONFIG_DIR = configDir
      delete process.env.DINGTALK_PERMISSION_CARD_TEMPLATE_ID
      expect(loadConfig().dingtalk.permissionCardTemplateId).toBe('file-template')

      process.env.DINGTALK_PERMISSION_CARD_TEMPLATE_ID = 'env-template'
      expect(loadConfig().dingtalk.permissionCardTemplateId).toBe('env-template')
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true })
    }
  })

  it('loads WhatsApp auth dir from file or env', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-config-'))
    const originalWhatsAppAuthDir = process.env.WHATSAPP_AUTH_DIR
    try {
      fs.writeFileSync(
        path.join(configDir, 'adapters.json'),
        JSON.stringify({ whatsapp: { authDir: '~/custom-whatsapp-auth', accountJid: '15551234567@s.whatsapp.net' } }),
      )
      process.env.CLAUDE_CONFIG_DIR = configDir
      delete process.env.WHATSAPP_AUTH_DIR
      expect(loadConfig().whatsapp.authDir).toBe(path.join(os.homedir(), 'custom-whatsapp-auth'))
      expect(loadConfig().whatsapp.accountJid).toBe('15551234567@s.whatsapp.net')

      process.env.WHATSAPP_AUTH_DIR = path.join(configDir, 'wa-auth')
      expect(loadConfig().whatsapp.authDir).toBe(path.join(configDir, 'wa-auth'))
    } finally {
      restoreEnv('WHATSAPP_AUTH_DIR', originalWhatsAppAuthDir)
      fs.rmSync(configDir, { recursive: true, force: true })
    }
  })
})

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}
