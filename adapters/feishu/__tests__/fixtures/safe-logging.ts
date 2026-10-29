// Only fixture credentials and an in-memory transport. No SDK request reaches
// a socket, and the parent starts this child with a disposable user-state root.
import * as Lark from '@larksuiteoapi/node-sdk'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { enqueue } from '../../../common/chat-queue.js'

const require = createRequire(import.meta.url)
const { AxiosError } = createRequire(require.resolve('@larksuiteoapi/node-sdk'))('axios')
const configDir = process.env.CLAUDE_CONFIG_DIR!
await mkdir(configDir, { recursive: true })
await writeFile(join(configDir, 'adapters.json'), JSON.stringify({
  feishu: { allowedUsers: ['fixture-user'], defaultWorkDir: process.env.HOME },
}))
globalThis.fetch = (() => { throw new Error('External network is forbidden in this fixture') }) as typeof fetch

type LoggedClient = { logger: { error(...args: unknown[]): void } }
let startupWs!: LoggedClient
let dispatcher!: LoggedClient
let started!: () => void
const ready = new Promise<void>(resolve => { started = resolve })
const originalRequest = Lark.Client.prototype.request
Lark.Client.prototype.request = (async () => ({ code: 0, bot: { open_id: 'fixture-bot' } })) as typeof originalRequest
Lark.WSClient.prototype.start = async function (options) {
  startupWs = this as unknown as LoggedClient
  dispatcher = options.eventDispatcher as unknown as LoggedClient
  started()
}
process.argv.push('--feishu')
const feishu = await import('../../index.js')
await ready
Lark.Client.prototype.request = originalRequest

const requestConfig = {
  method: 'post',
  url: 'https://fixture.invalid/open-apis/auth/v3/tenant_access_token/internal?token=fixture-url-query',
  headers: { Authorization: 'Bearer fixture-authorization' },
  data: JSON.stringify({ app_id: process.env.FEISHU_APP_ID, app_secret: process.env.FEISHU_APP_SECRET }),
}
const error = new AxiosError('Request failed with status code 400', 'ERR_BAD_REQUEST', requestConfig,
  { body: 'fixture-request-body' },
  { status: 400, data: { detail: 'fixture-response-body' }, config: requestConfig },
)
let tokenRequests = 0
Lark.defaultHttpInstance.request = (async (options: { url?: string }) => {
  if (!options.url?.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
    throw new Error('Unexpected fixture transport request')
  }
  tokenRequests++
  throw error
}) as typeof Lark.defaultHttpInstance.request

try {
  await feishu.larkClient.request({ method: 'GET', url: '/open-apis/bot/v3/info' })
  throw new Error('Expected the SDK token request to reject')
} catch (caught) {
  if (!(caught instanceof TypeError) || !caught.message.includes('tenant_access_token')) throw caught
}
startupWs.logger.error('ws fixture', error)
dispatcher.logger.error('dispatcher fixture', error, process.env.FEISHU_ENCRYPT_KEY, process.env.FEISHU_VERIFICATION_TOKEN)

// Exercise the SDK's alternate error shape: generated API methods convert an
// AxiosError to [HTTP summary, response.data] before passing it to their logger.
const generatedClient = new Lark.Client({
  appId: process.env.FEISHU_APP_ID!, appSecret: process.env.FEISHU_APP_SECRET!,
  disableTokenCache: true,
  logger: (feishu.larkClient as unknown as LoggedClient).logger as any,
  httpInstance: { request: async () => { throw error } } as unknown as Lark.HttpInstance,
})
try { await generatedClient.im.message.create({ data: { receive_id: 'fixture', msg_type: 'text', content: '{}' } }) }
catch (caught) { if (caught !== error) throw caught }

feishu.larkClient.im.message.create = async () => { throw error }
await feishu.handleMessage({
  sender: { sender_id: { open_id: 'fixture-user' } },
  message: { message_id: 'fixture-message', chat_id: 'fixture-chat', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: '/help' }) },
})
await enqueue('fixture-chat', async () => {})
feishu.bridge.destroy()
feishu.dedup.destroy()
console.log(`TOKEN_REQUESTS=${tokenRequests}`)
// The SDK's internal cache owns a referenced cleanup interval.
process.exit(0)
