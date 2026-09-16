/**
 * Minimal Slack Web API client.
 *
 * Only the calls this adapter needs: posting and editing messages, opening a
 * Socket Mode connection, and the three-step external file upload. Slack's
 * official SDK would pull in a large dependency tree for that surface, and the
 * error handling we care about (`ok: false` plus an `error` code) is uniform
 * across every endpoint.
 */

const SLACK_API_BASE = 'https://slack.com/api/'
const SLACK_FILE_HOST = 'files.slack.com'
const REQUEST_TIMEOUT_MS = 30_000
const UPLOAD_TIMEOUT_MS = 120_000

export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(`Slack ${method} failed: ${code}`)
    this.name = 'SlackApiError'
  }
}

type SlackResponse = { ok?: boolean; error?: string; [key: string]: unknown }

/**
 * Slack serves private files from `files.slack.com` only.
 *
 * The URL arrives inside an event payload, so treating it as a fetchable
 * address without pinning the host would let anyone in the workspace steer an
 * authenticated request — the bot token travels on this call.
 */
export function assertSlackFileUrl(value: string | undefined): URL {
  if (!value) throw new Error('Slack file has no download URL')
  const url = new URL(value)
  const safePort = !url.port || url.port === '443'
  if (
    url.protocol !== 'https:'
    || url.hostname !== SLACK_FILE_HOST
    || !safePort
    || url.username
    || url.password
  ) {
    throw new Error('Slack file URL is not hosted by Slack')
  }
  url.hash = ''
  return url
}

/** Slack returns the external upload target on its own file host. */
export function assertSlackUploadUrl(value: string | undefined): URL {
  if (!value) throw new Error('Slack returned no upload URL')
  const url = new URL(value)
  const safePort = !url.port || url.port === '443'
  if (
    url.protocol !== 'https:'
    || url.hostname !== SLACK_FILE_HOST
    || !safePort
    || url.username
    || url.password
  ) {
    throw new Error('Slack returned an unsafe upload URL')
  }
  url.hash = ''
  return url
}

export class SlackApiClient {
  constructor(
    private readonly botToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl: string = SLACK_API_BASE,
  ) {}

  /** POST a JSON body to a Web API method. */
  async call<T extends SlackResponse>(
    method: string,
    body: Record<string, unknown>,
    token = this.botToken,
  ): Promise<T> {
    const response = await this.fetchImpl(new URL(method, this.baseUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const data = (await response.json().catch(() => null)) as T | null
    if (!data || data.ok !== true) {
      throw new SlackApiError(method, data?.error ?? `http_${response.status}`, response.status)
    }
    return data
  }

  /** GET a Web API method with query parameters. */
  async get<T extends SlackResponse>(
    method: string,
    query: Record<string, string | number>,
  ): Promise<T> {
    const url = new URL(method, this.baseUrl)
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, String(value))
    }
    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${this.botToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const data = (await response.json().catch(() => null)) as T | null
    if (!data || data.ok !== true) {
      throw new SlackApiError(method, data?.error ?? `http_${response.status}`, response.status)
    }
    return data
  }

  async postMessage(channel: string, text: string, threadTs?: string): Promise<string> {
    const body: Record<string, unknown> = { channel, text }
    if (threadTs) body.thread_ts = threadTs
    const data = await this.call<{ ts?: string }>('chat.postMessage', body)
    if (!data.ts) throw new SlackApiError('chat.postMessage', 'missing_ts')
    return data.ts
  }

  async updateMessage(channel: string, ts: string, text: string): Promise<void> {
    await this.call('chat.update', { channel, ts, text })
  }

  /** Identity of the bot user, used to ignore the bot's own messages. */
  async authTest(): Promise<{ userId: string; teamId?: string; botId?: string }> {
    const data = await this.call<{ user_id?: string; team_id?: string; bot_id?: string }>(
      'auth.test',
      {},
    )
    return { userId: data.user_id ?? '', teamId: data.team_id, botId: data.bot_id }
  }

  /** Open a Socket Mode WebSocket URL using the app-level token. */
  async openSocketConnection(appToken: string): Promise<string> {
    const data = await this.call<{ url?: string }>('apps.connections.open', {}, appToken)
    const raw = data.url
    if (!raw) throw new SlackApiError('apps.connections.open', 'missing_url')
    const url = new URL(raw)
    if (url.protocol !== 'wss:') {
      throw new SlackApiError('apps.connections.open', 'insecure_socket_url')
    }
    return url.toString()
  }

  /** Download a private file with the bot token attached. */
  async downloadFile(urlPrivateDownload: string | undefined): Promise<Buffer> {
    const url = assertSlackFileUrl(urlPrivateDownload)
    const response = await this.fetchImpl(url, {
      headers: { authorization: `Bearer ${this.botToken}` },
      redirect: 'follow',
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    })
    if (!response.ok) {
      throw new Error(`Slack file download failed: ${response.status} ${response.statusText}`)
    }
    return Buffer.from(await response.arrayBuffer())
  }

  /**
   * Slack's three-step external upload: reserve a URL, PUT the bytes, then
   * publish the file into a channel.
   */
  async uploadFile(options: {
    channel: string
    buffer: Buffer
    filename: string
    title?: string
    threadTs?: string
  }): Promise<void> {
    const reserved = await this.get<{ upload_url?: string; file_id?: string }>(
      'files.getUploadURLExternal',
      { filename: options.filename, length: options.buffer.length },
    )
    const uploadUrl = assertSlackUploadUrl(reserved.upload_url)
    const fileId = reserved.file_id
    if (!fileId) throw new SlackApiError('files.getUploadURLExternal', 'missing_file_id')

    const upload = await this.fetchImpl(uploadUrl, {
      method: 'POST',
      body: new Uint8Array(options.buffer),
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    })
    if (!upload.ok) {
      throw new Error(`Slack file upload failed: ${upload.status} ${upload.statusText}`)
    }

    const complete: Record<string, unknown> = {
      files: [{ id: fileId, title: options.title ?? options.filename }],
      channel_id: options.channel,
    }
    if (options.threadTs) complete.thread_ts = options.threadTs
    await this.call('files.completeUploadExternal', complete)
  }
}
