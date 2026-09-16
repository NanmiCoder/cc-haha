import { describe, expect, it } from 'bun:test'
import {
  buildSlackAppManifest,
  buildSlackCreateAppUrl,
  buildSlackManifestJson,
  SLACK_BOT_SCOPES,
} from '../manifest.js'

describe('buildSlackAppManifest', () => {
  // Socket Mode is what removes the need for a public request URL; without it
  // a desktop-local bot cannot receive anything at all.
  it('enables Socket Mode and subscribes to direct messages', () => {
    const manifest = buildSlackAppManifest() as any

    expect(manifest.settings.socket_mode_enabled).toBe(true)
    expect(manifest.settings.event_subscriptions.bot_events).toEqual(['message.im'])
  })

  it('requests exactly the scopes the adapter calls', () => {
    const manifest = buildSlackAppManifest() as any

    expect(manifest.oauth_config.scopes.bot).toEqual([...SLACK_BOT_SCOPES])
    expect(manifest.oauth_config.scopes.bot).toEqual([
      'chat:write',
      'im:history',
      'files:write',
      'files:read',
      'users:read',
    ])
  })

  it('enables the messages tab so a user can DM the bot at all', () => {
    const manifest = buildSlackAppManifest() as any

    expect(manifest.features.app_home.messages_tab_enabled).toBe(true)
    expect(manifest.features.app_home.messages_tab_read_only_enabled).toBe(false)
  })

  it('uses the caller-supplied app name in both places Slack shows it', () => {
    const manifest = buildSlackAppManifest('My Bot') as any

    expect(manifest.display_information.name).toBe('My Bot')
    expect(manifest.features.bot_user.display_name).toBe('My Bot')
  })
})

describe('buildSlackCreateAppUrl', () => {
  it('opens the create-app dialog with the manifest pre-filled', () => {
    const url = new URL(buildSlackCreateAppUrl())

    expect(url.origin + url.pathname).toBe('https://api.slack.com/apps')
    expect(url.searchParams.get('new_app')).toBe('1')
    expect(JSON.parse(url.searchParams.get('manifest_json')!)).toEqual(buildSlackAppManifest())
  })
})

describe('buildSlackManifestJson', () => {
  it('is valid JSON a user can paste into Slack by hand', () => {
    expect(JSON.parse(buildSlackManifestJson())).toEqual(buildSlackAppManifest())
  })
})
