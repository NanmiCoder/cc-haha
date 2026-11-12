# System Push and Live Activities

The phone's foreground connection and system push are two independent paths. The computer periodically reads the real run state: when it enters a waiting state it alerts for approvals, questions, or plans; when it receives a new persisted success result it alerts for completion; when it goes from running to failed it alerts for errors. Stopped, offline, and unknown states are never treated as success, and historical successes found on first discovery only establish a baseline. After successful delivery, the same state isn't sent again. Temporary failures are retried at most 3 times (at 5-second and 10-second intervals), re-checking the current state and device authorization each time; expired approvals are not replayed. When a run makes no progress for more than 5 minutes, the errors preference can trigger one alert; waiting for user approval doesn't count as no progress. Historical failures or idle states found on first discovery never produce fake new notifications.

## Three delivery channels

Ordinary users' computers don't have the publisher's APNs / FCM private keys, and shouldn't. So push takes one of three paths based on the `provider` chosen when the phone registers; the phone picks based on the capabilities returned by `GET`:

| Channel | `provider` | Who holds credentials | Use |
| --- | --- | --- | --- |
| Expo relay | `expo` | The Expo push service (APNs Key uploaded to the EAS project) | iOS (TestFlight / App Store), zero configuration on the computer |
| Phone pull | `desktop` | No credentials needed: the phone's foreground service long-polls this computer | Android, any brand, no dependency on Google services, no store listing needed |
| Direct from computer | default | This computer's own APNs / FCM environment variables | The publisher's own computer; Live Activities only use this path |

Selection rules (`mobile/src/state/pushProvider.ts`): on Android, use `desktop` if available; otherwise, if the computer has credentials for that platform, connect directly; iOS then falls back to `expo`. Older computers don't return `providers`, so the phone registers via the original direct flow without sending the `provider` field.

**Prerequisites for the Expo relay** (a one-time publisher task, not in the repository): configure the APNs Push Key for `com.yunce.cchaha.mobile` in the project credentials on expo.dev (`bunx eas-cli credentials --platform ios`), and keep Expo's Enhanced Push Security off — when on, sending requires an Expo access token, and that token cannot be put into computers distributed to users. With it off, anyone holding the phone's Expo token can send notifications to that phone; the token is only registered on paired computers and stored encrypted. The computer sends notifications to `https://exp.host/--/api/v2/push/send` (through the proxy in cc-haha's network settings); notification titles and bodies pass through Expo and Apple, so users who don't want raw commands to pass through third parties can turn off "Show commands on Lock Screen". The computer deletes the registration only when Expo returns `DeviceNotRegistered`; other errors are retried as delivery failures. The reason for the most recent Expo send failure is reported to the phone via `relayErrors.expo` in `GET` and cleared after the next successful send; the phone's settings screen uses it to show "Push delivery failed" and suggest configuring a network proxy. The computer's push polling uses two channels that don't wait on each other: phone pull only enqueues, while Expo / APNs / FCM wait on the network (up to 15 seconds each time when unreachable), so a stuck relay doesn't slow down Android alerts.

**Phone pull**: Android generates a random pull token per computer (32 bytes, stored in SecureStore; each computer only knows its own, and it's deleted when the computer is removed). After each successful registration, the app hands this computer's address, auth headers, and token individually to the foreground service in the local module `mobile/modules/cchaha-duty` (type `specialUse`, with a persistent "On watch" notification); the service keeps its own computer list, and the app only adds or removes single computers, so computers temporarily unreachable at startup aren't pushed out of the list. The service loops `POST /api/sessions/mobile-push/pull` for each computer; the computer holds the request for up to 25 seconds and returns immediately when there's a notification. The phone de-duplicates by id and `ack`s in the next request; the computer deletes acknowledged entries, and keeps unacknowledged ones for 10 minutes, up to 32 per token. For battery, the service only holds a wake lock between being woken (reply arrives, retry is due, half-open connection abandoned) and sending the next pull; while a pull is held by the computer, the computer's reply wakes the phone. Connection failures retry with exponential backoff starting at 2 seconds, up to 30 seconds; once a computer has been unreachable for 5 consecutive minutes (network changed, lid closed), it switches to trying every 5 minutes, and reconnects immediately when the app opens or the network changes. Thread timers don't advance while the CPU sleeps, so the service also has a system alarm roughly every minute (`setAndAllowWhileIdle`, stretched under Doze): it only handles retries that are due and half-open connections with no response for over 40 seconds, and holds no lock otherwise. Configuration is stored encrypted with the Android Keystore and restored automatically after boot and app updates. Only two answers from the computer itself make the service stop pulling that computer: 401 (pairing credential rejected) and 404 `NO_REGISTRATION` (the computer has no registration for this phone), until the app registers again; 403/5xx returned by tunnels or proxies are retried as network errors. Chinese OEM ROMs may still kill background work: the settings screen guides users to "Allow background activity" (battery optimization exemption) and to enable auto-start in app settings.

## Computer configuration

With no configuration at all, newer computers can push through the Expo relay and phone pull; `platforms` only describes this computer's own APNs / FCM credentials. When an older computer has no credentials, the API returns `notConfigured` and the phone shows "Computer has not configured system push", which doesn't affect chat, manual refresh, or foreground alerts.

Direct iOS delivery requires an APNs configuration matching the installed app's bundle ID and signing environment. It reads only from explicitly set environment variables; it never scans the keychain or developer directories.

```sh
CC_HAHA_APNS_KEY_PATH=/absolute/path/AuthKey.p8
CC_HAHA_APNS_KEY_ID=YOUR_KEY_ID
CC_HAHA_APNS_TEAM_ID=YOUR_TEAM_ID
CC_HAHA_APNS_TOPIC=com.yunce.cchaha.mobile
CC_HAHA_APNS_SANDBOX=false
```

`SANDBOX=true` is for the development APNs environment; Ad Hoc / TestFlight / production distribution usually uses production. Go by the actual signing entitlement, never by phone model. Ordinary notifications use the bundle topic; Live Activities automatically use the `.push-type.liveactivity` suffix. Live Activities require user permission, system support, and a native build with the correct entitlement.

Android uses `GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/service-account.json`. Currently explicit service-account ADC files are supported; gcloud user logins and cloud machine metadata are not read automatically. The phone must be configured with a native FCM file from the same Firebase project and obtain a device token. The notification channel defaults to `cc-haha`; when the registration carries `delivery.channels: 'split'`, `cc-haha-decisions` / `cc-haha-completed` / `cc-haha-errors` are used by event. Without this configuration you cannot claim background push works.

The computer must stay running and be able to reach Apple / Google. System Do Not Disturb, device network, notification permission, and system throttling still affect display; the API's `configured` only indicates config files exist and doesn't prove a real device received anything. Delivery failures show diagnostics without credentials, and tokens reported as invalid by APNs / FCM are removed.

## Phone API

All requests reuse the current host's LAN or remote pairing authentication. Owner/device IDs cannot be submitted in requests; remote device ownership comes from the pairing credential verified by the server.

- `GET /api/sessions/mobile-push` → `{ platforms: { ios, android }, providers: { expo, desktop }, status: 'configured' | 'notConfigured', error?, relayErrors?: { expo } }`. `platforms` is the computer's direct credentials, `providers` is the credential-free channels; older computers have no `providers`. Devices and tokens are not listed.
- `POST /api/sessions/mobile-push/pull`, body `{ token: pullToken, ack?: lastNotificationId }` → `{ notifications: [{ id, title, body, data, category, channelId }] }`; with no new notifications it holds for up to 25 seconds and then returns an empty array. Only a caller who registered that token with `provider: 'desktop'` (on LAN, the token owner; remotely, the verified paired device) can read it; otherwise 404 `NO_REGISTRATION`. This route is excluded from slow-request diagnostics.
- `PUT /api/sessions/mobile-push` → `{ registered, status: 'registered' | 'notConfigured', id?, expiresAt? }`.
- `DELETE /api/sessions/mobile-push`, body `{ token: ordinaryDevicePushToken, hostId }` → `{ removed: number }`, idempotently deletes this phone's ordinary notification and associated Live Activity registrations on this host. Old registrations can be deleted even with no provider configured.
- `DELETE /api/sessions/mobile-push/:id`, body `{ token }` keeps single-item unregistration; returns 404 on mismatch.
- `POST /api/sessions/mobile-push/test`, body `{ token: ordinaryDevicePushToken, hostId?: string }` → `{ status: 'sent' | 'notConfigured' | 'noRegistration' | 'failed', error? }`. Only matches the current caller's own ordinary notification registration (on LAN, the owner of that token; remotely, the verified paired device), and doesn't accept owner/device IDs; when `hostId` is given, only that host's registration is sent. The title sent is "Test notification · cc-haha" and the body is "Computer push works: this was sent from your computer to your phone.", with APNs category `cchahaResult` and data `{ hostId, eventType: 'test' }` (no sessionId). This is a user-initiated test and is not subject to notification category preferences or Do Not Disturb. The test is meant to show a banner: with split channels, Android uses the high-importance `cc-haha-decisions` (the "Task completed" channel is default importance and only sounds without a banner), and the test notification is shown even when the app is in the foreground (other alerts only go to the notification shade while in the foreground). `notConfigured` means the computer has no APNs / FCM configuration for that platform, `noRegistration` means no matching registration, and `failed`'s `error` contains no token or credentials.

Ordinary registration body:

```ts
{
  platform: 'ios' | 'android',
  provider?: 'expo' | 'desktop',  // default: direct from computer; only sent when listed in the computer's providers
  token: nativeDevicePushToken,   // expo: ExponentPushToken[…]; desktop: the phone's pull token (43+ char base64url, Android only)
  hostId: phoneLocalHostId,
  hostName: optionalDisplayName,
  kind: 'notification',
  preferences: { decisions: true, completed: true, errors: true },
  quietHours: { enabled: false, start: '22:00', end: '08:00' },
  timeZone: 'Asia/Shanghai'
}
```

Optional `delivery` (both ordinary notification and Live Activity registrations may carry it; omitting it keeps the old behavior):

```ts
delivery?: {
  channels?: 'split',                       // Android: split notification channels by event
  timeSensitive?: boolean,                  // iOS: decision pushes use the time-sensitive level
  liveActivity?: 'running' | 'decisions',   // scope of remote Live Activity updates
  showCommand?: boolean                     // false: Live Activity doesn't carry the raw command / preview
}
```

- Each field's type is strictly validated and unknown fields are rejected; it's saved with the registration, and re-registering replaces it entirely (a registration without `delivery` clears the old value). Old data without this field still loads as-is.
- `channels: 'split'`: FCM `channel_id` is chosen by event — waiting for approval / question / plan is `cc-haha-decisions`, completion is `cc-haha-completed`, failure and no progress are `cc-haha-errors`; otherwise always `cc-haha`. The phone needs to create these three channels itself.
- `timeSensitive: true`: aps for decision pushes carries `"interruption-level": "time-sensitive"`; other types keep the default `active`.
- `liveActivity: 'decisions'`: the Live Activity is only updated remotely while waiting for a decision; the running state doesn't send `update`, but instead sends `end` to activities that are only running and removes the registration, so remote push doesn't bring them back up. Omitted or `'running'` keeps the original behavior.
- `showCommand: false`: the Live Activity `detail` doesn't include the raw command / preview: a waiting Bash shows "Open the app to view the command", other waits show "Needs your decision", running is empty, and ended shows "This run has ended".

`hostId` is only used for host navigation after returning to the phone and cannot establish or change authorization. The client needs to securely store the registration ID and original token so it can revoke old registrations after restart, when removing a host, or when the token rotates. When revoking for reasons such as turning off notification permission, an offline unregistration cannot be reported as success, and a pending-unregistration record should be kept for retry. Removing a computer is the exception: it must be possible to remove a computer even when it's unreachable, so revocation is attempted only once (waiting at most 3 seconds), and failure neither blocks removal nor is retried — the connection credentials are deleted with the removal, and undelivered registrations stay on the computer until they expire or pairing is revoked. Registrations are valid for 30 days and never exceed the actual remote pairing lifetime; Live Activity registrations last at most 8 hours.

Live Activities only use direct delivery from the computer (the Expo relay doesn't support ActivityKit push), so their registration cannot carry `provider`. A Live Activity adds `{ kind: 'liveActivity', sessionId, activityId, name: 'CCHahaTaskActivity', deviceToken: ordinaryDevicePushToken }`, with `token` being ActivityKit's dedicated push token; only a digest of `deviceToken` is stored, used to link to the ordinary device registration and for whole-device unregistration. The server sends `aps.event=update/end`, `timestamp`, `stale-date`, and `content-state: { name, props: JSON.stringify(props) }`. Activities that are continuously running or waiting are refreshed every 60 seconds, with stale-date extended to 90 seconds after this delivery; while the computer is offline, no fresh state is faked. After the real session ends, end is sent and the registration is removed. The client should still revoke the registration when it ends the activity locally.

Ordinary notification data is `{ hostId, sessionId, requestId?, eventType }`. The APNs category is `cchahaTool`, `cchahaDecision`, or `cchahaResult`. Only ordinary tool permissions offer allow/deny actions (the phone pull channel's foreground service shows the same two buttons, which open the app when tapped); questions, plans, and Computer Use must be handled in the app. When an action reaches the app, it must re-check the original host, original session, and still-pending request ID; the push itself never approves permissions.

## Persistence and revocation

`cc-haha/mobile-push.json` in the config directory stores token digests, device ownership, preferences, and AES-GCM ciphertext; the adjacent `.key` file is a random local encryption key. Both have 0600 permissions. No file is created when nothing is registered. Empty v0 data migrates to v1, unknown extension fields are preserved, and future schemas refuse writes. Do not add these files to Git or sync them to public storage.

After pairing is revoked or expires, the server deletes that remote device's registrations. While the remote entry is temporarily closed (including the brief listening stop during cloudflared reconnects), delivery is only paused and registrations are kept; once the entry is back, states that still hold are delivered. This way, every tunnel reconnect doesn't require all phones to re-register. When migrating or shutting down the service, polling stops and in-flight work is awaited, to avoid writing data back mid-migration.

References: [Apple APNs token authentication](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns), [ActivityKit push updates](https://developer.apple.com/documentation/activitykit/starting-and-updating-live-activities-with-activitykit-push-notifications), [FCM HTTP v1](https://firebase.google.com/docs/cloud-messaging/send/v1-api).
