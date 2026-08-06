import { afterEach, expect, test } from 'bun:test'
import { shouldSkipPluginAutoupdate } from './config.js'

const originalEnv = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
  DISABLE_AUTOUPDATER: process.env.DISABLE_AUTOUPDATER,
  FORCE_AUTOUPDATE_PLUGINS: process.env.FORCE_AUTOUPDATE_PLUGINS,
  NODE_ENV: process.env.NODE_ENV,
}

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

test('plugin autoupdate keeps the administrator env override semantics', () => {
  process.env.NODE_ENV = 'test'
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  delete process.env.DISABLE_AUTOUPDATER
  delete process.env.FORCE_AUTOUPDATE_PLUGINS

  expect(shouldSkipPluginAutoupdate()).toBe(true)

  process.env.FORCE_AUTOUPDATE_PLUGINS = 'true'
  expect(shouldSkipPluginAutoupdate()).toBe(false)
})
