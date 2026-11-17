import { describe, expect, it } from 'vitest'
import { hasProxyManagedOnlyUserSettings } from './settingsStore'

describe('proxy-managed user settings warning', () => {
  it('recognizes a proxy-only takeover placeholder', () => {
    expect(hasProxyManagedOnlyUserSettings({
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721',
        ANTHROPIC_API_KEY: 'PROXY_MANAGED',
      },
    })).toBe(true)
  })

  it('does not flag a normal local model endpoint', () => {
    expect(hasProxyManagedOnlyUserSettings({
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434',
        ANTHROPIC_API_KEY: 'local-model-key',
      },
    })).toBe(false)
  })

  it('does not flag a proxy placeholder when other user settings remain', () => {
    expect(hasProxyManagedOnlyUserSettings({
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721',
        ANTHROPIC_AUTH_TOKEN: 'PROXY_MANAGED',
      },
      language: 'Chinese',
    })).toBe(false)
  })

  it('recognizes a CC Switch proxy snapshot that includes standard Claude schema and template keys', () => {
    expect(hasProxyManagedOnlyUserSettings({
      $schema: 'https://json.schemastore.org/claude-code-settings.json',
      cleanupPeriodDays: 36500,
      env: {
        ANTHROPIC_API_KEY: 'PROXY_MANAGED',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721',
      },
      hooks: {},
      includeCoAuthoredBy: false,
      outputStyle: 'engineer-professional',
      permissions: { allow: ['Bash', 'Read'], deny: [] },
      statusLine: { command: '~/.claude/ccline/ccline', padding: 0, type: 'command' },
      leanModeEnabled: false,
      autoUpdateEnabled: true,
      agentTeamsEnabled: true,
      maxConcurrentSubagents: null,
    })).toBe(true)
  })

  it('does not flag a CC Switch template when non-default cc-haha General settings are present', () => {
    expect(hasProxyManagedOnlyUserSettings({
      $schema: 'https://json.schemastore.org/claude-code-settings.json',
      env: {
        ANTHROPIC_API_KEY: 'PROXY_MANAGED',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721',
      },
      effort: 'xhigh',
    })).toBe(false)

    expect(hasProxyManagedOnlyUserSettings({
      env: {
        ANTHROPIC_API_KEY: 'PROXY_MANAGED',
      },
      leanModeEnabled: true,
    })).toBe(false)
  })

  it('keeps the takeover warning active when effort and language were hydrated from cc-haha/settings.json fallback', () => {
    expect(hasProxyManagedOnlyUserSettings({
      $schema: 'https://json.schemastore.org/claude-code-settings.json',
      cleanupPeriodDays: 36500,
      env: {
        ANTHROPIC_API_KEY: 'PROXY_MANAGED',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721',
      },
      hooks: {},
      includeCoAuthoredBy: false,
      outputStyle: 'engineer-professional',
      permissions: { allow: ['Bash', 'Read'], deny: [] },
      statusLine: { command: '~/.claude/ccline/ccline', padding: 0, type: 'command' },
      effort: 'xhigh',
      language: 'chinese',
      ccHahaFallbackKeys: ['language', 'effort'],
      leanModeEnabled: false,
      autoUpdateEnabled: true,
      agentTeamsEnabled: true,
      maxConcurrentSubagents: null,
    })).toBe(true)

    // If an actual non-fallback setting remains in ~/.claude/settings.json, do not warn.
    expect(hasProxyManagedOnlyUserSettings({
      env: {
        ANTHROPIC_API_KEY: 'PROXY_MANAGED',
      },
      language: 'chinese',
      ccHahaFallbackKeys: ['language'],
      alwaysThinkingEnabled: false,
    })).toBe(false)
  })
})
