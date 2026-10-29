import { expect, test } from 'bun:test'
import { ApiClient } from './client'
import { connectHost, pairingMessage, type ConnectPhase } from './connectHost'
import { buildSocketOptions } from './connection'

function fixture(
  replies: unknown[],
  requests: { path: string; body?: unknown; authorization?: string }[]
) {
  return (
    host: ConstructorParameters<typeof ApiClient>[0],
    credential: string
  ) =>
    new ApiClient(host, credential, {
      fetch: async (url, init) => {
        requests.push({
          path: new URL(url).pathname,
          body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
          authorization: init.headers.Authorization,
        })
        return {
          ok: true,
          status: 200,
          redirected: false,
          url,
          text: async () => JSON.stringify(replies.shift()),
        }
      },
    })
}
const input = () => ({
  value: 'https://fixture.invalid/#pair=fake-secret',
  token: '',
  name: 'Office',
  id: 'b',
  platform: 'ios',
  signal: new AbortController().signal,
  onStatus: () => {},
})

test('LAN connection uses the verification contract and separates credentials from metadata', async () => {
  const requests: Parameters<typeof fixture>[1] = []
  const phases: ConnectPhase[] = []
  const result = await connectHost(
    {
      ...input(),
      value: 'http://192.168.1.2:3456/?h5Token=fake-lan',
      onStatus: (_value, phase) => phases.push(phase),
    },
    { client: fixture([{ ok: true }], requests) }
  )
  // LAN never enters the approval phase, so the form keeps its inline progress.
  expect(phases).toEqual(['verifying'])
  expect(requests).toEqual([
    {
      path: '/api/h5-access/verify',
      body: undefined,
      authorization: 'Bearer fake-lan',
    },
  ])
  expect(result.host).toEqual({
    id: 'b',
    name: 'Office',
    auth: 'lan',
    url: 'http://192.168.1.2:3456',
  })
  expect(result.credential).toBe('fake-lan')
})

test('native pairing waits for approval and accepts only the native Bearer contract', async () => {
  const requests: Parameters<typeof fixture>[1] = []
  const phases: { phase: ConnectPhase; requests: number }[] = []
  const result = await connectHost(
    {
      ...input(),
      onStatus: (_value, phase) =>
        phases.push({ phase, requests: requests.length }),
    },
    {
      now: () => 100,
      wait: async () => {},
      client: fixture(
        [
          { id: 'pair', claimSecret: 'claim' },
          { status: 'pending' },
          {
            status: 'approved',
            token: 'native_fake',
            tokenType: 'Bearer',
            deviceId: 'device',
            expiresAt: 200,
          },
        ],
        requests
      ),
    }
  )
  // The approval page appears only after the desktop accepted the pair request.
  expect(phases).toEqual([
    { phase: 'requesting', requests: 0 },
    { phase: 'approval', requests: 1 },
  ])
  expect(requests[0].body).toEqual({
    secret: 'fake-secret',
    name: 'cc-haha App · ios',
    clientType: 'native',
  })
  expect(requests[1].body).toEqual({ id: 'pair', claimSecret: 'claim' })
  expect(result.credential).toBe('native_fake')
  expect(JSON.stringify(result.host)).not.toContain('fake-secret')
})

test.each(['ios', 'android'])('Tailscale Serve on a custom HTTPS port preserves native pairing and socket authorization on %s', async (platform) => {
  const origin = 'https://workstation.fixture.ts.net:8443'
  const requests: Parameters<typeof fixture>[1] = []
  const phases: ConnectPhase[] = []
  const result = await connectHost({
    ...input(), platform, value: `${origin}/remote#pair=fake-secret`,
    onStatus: (_value, phase) => phases.push(phase),
  }, {
    now: () => 100,
    client: fixture([
      { id: 'pair', claimSecret: 'claim' },
      { status: 'approved', token: 'native_fake', tokenType: 'Bearer', deviceId: 'device', expiresAt: 200 },
    ], requests),
  })
  expect(phases).toEqual(['requesting', 'approval'])
  expect(requests.map(request => request.path)).toEqual(['/api/public-access/pair', '/api/public-access/claim'])
  expect(requests[0].body).toMatchObject({ clientType: 'native', name: `cc-haha App · ${platform}` })
  expect(result.host).toMatchObject({ url: origin, auth: 'remote' })
  expect(JSON.stringify(result.host)).not.toContain('fake-secret')
  expect(buildSocketOptions(result.host, result.credential, 'session', 'native')).toEqual({
    url: 'wss://workstation.fixture.ts.net:8443/ws/session',
    headers: { Authorization: 'Bearer native_fake', Origin: origin },
  })
})

test('Tailscale HTTP addresses and a bare Serve origin cannot bypass device pairing', async () => {
  const client = () => { throw new Error('must not contact') }
  for (const value of ['http://100.101.102.103:17463', 'http://workstation.fixture.ts.net']) {
    await expect(connectHost({ ...input(), value }, { client })).rejects.toThrow('HTTPS')
  }
  await expect(connectHost({ ...input(), value: 'https://workstation.fixture.ts.net' }, { client })).rejects.toThrow('完整配对链接')
})

test.each([
  { status: 'rejected' },
  {
    status: 'approved',
    token: 'browser_token',
    tokenType: 'Bearer',
    deviceId: 'device',
    expiresAt: 200,
  },
  {
    status: 'approved',
    token: 'native_fake',
    tokenType: 'Bearer',
    deviceId: 'device',
    expiresAt: 50,
  },
])(
  'rejected or expired pairing never yields savable credentials',
  async (claim) => {
    await expect(
      connectHost(input(), {
        now: () => 100,
        client: fixture([{ id: 'pair', claimSecret: 'claim' }, claim], []),
      })
    ).rejects.toThrow()
  }
)

test('cancelling while waiting prevents another claim and prevents saving', async () => {
  const controller = new AbortController()
  const requests: Parameters<typeof fixture>[1] = []
  await expect(
    connectHost(
      { ...input(), signal: controller.signal },
      {
        now: () => 100,
        wait: async () => {
          controller.abort()
        },
        client: fixture(
          [{ id: 'pair', claimSecret: 'claim' }, { status: 'pending' }],
          requests
        ),
      }
    )
  ).rejects.toThrow('取消')
  expect(requests).toHaveLength(2)
})

test('bare public origins and browser remote pairing never contact a host', async () => {
  const client = () => {
    throw new Error('must not contact')
  }
  await expect(
    connectHost({ ...input(), value: 'https://fixture.invalid' }, { client })
  ).rejects.toThrow('完整配对链接')
  await expect(
    connectHost({ ...input(), platform: 'web' }, { client })
  ).rejects.toThrow('原生 App')
  expect(pairingMessage(new Error('offline'))).toBe('offline')
})
