/**
 * Slack app manifest for Claude Code Desktop.
 *
 * Slack has no scan-to-create flow, so its closest equivalent is a manifest:
 * the user opens Slack's "create an app" page with the whole configuration
 * pre-filled — Socket Mode on, DM events subscribed, exactly the scopes this
 * adapter calls — and only has to approve and install it.
 *
 * Keeping the manifest here rather than in the docs means the scopes the app
 * requests and the API methods the adapter calls are edited together.
 */

const CREATE_APP_URL = 'https://api.slack.com/apps'

/** Scopes map 1:1 to the Web API calls in `api.ts`. Nothing speculative. */
export const SLACK_BOT_SCOPES = [
  // chat.postMessage / chat.update
  'chat:write',
  // message.im events
  'im:history',
  // files.getUploadURLExternal + files.completeUploadExternal
  'files:write',
  // downloading an inbound file with the bot token
  'files:read',
  // resolving a display name for the paired-users list
  'users:read',
] as const

export type SlackManifest = Record<string, unknown>

export function buildSlackAppManifest(appName = 'Claude Code Haha'): SlackManifest {
  return {
    display_information: {
      name: appName,
      description: 'Drive a local Claude Code session from Slack direct messages.',
      background_color: '#1a1a1a',
    },
    features: {
      bot_user: {
        display_name: appName,
        always_online: false,
      },
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
    },
    oauth_config: {
      scopes: {
        bot: [...SLACK_BOT_SCOPES],
      },
    },
    settings: {
      event_subscriptions: {
        bot_events: ['message.im'],
      },
      interactivity: {
        is_enabled: false,
      },
      org_deploy_enabled: false,
      // Socket Mode is what removes the need for a public request URL.
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  }
}

/** Pretty-printed manifest for the "paste a manifest" path. */
export function buildSlackManifestJson(appName?: string): string {
  return JSON.stringify(buildSlackAppManifest(appName), null, 2)
}

/**
 * Deep link that opens Slack's create-app dialog with the manifest pre-filled.
 *
 * Slack ignores the parameter if it ever stops supporting it, in which case the
 * page still opens on the normal create flow — which is why the settings UI
 * also shows the manifest itself.
 */
export function buildSlackCreateAppUrl(appName?: string): string {
  const url = new URL(CREATE_APP_URL)
  url.searchParams.set('new_app', '1')
  url.searchParams.set('manifest_json', buildSlackManifestJson(appName))
  return url.toString()
}
