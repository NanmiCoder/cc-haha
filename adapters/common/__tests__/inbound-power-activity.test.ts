import { describe, expect, it } from 'bun:test'
import { currentInboundPowerLease, enqueueInboundPowerActivity } from '../inbound-power-activity.js'

function clientFixture() {
  const acquired: string[] = []
  const released: string[] = []
  return {
    acquired, released,
    acquirePowerActivityLease: async (id: string) => { acquired.push(id); return true },
    releasePowerActivityLease: async (id: string) => { released.push(id) },
  }
}

describe('inbound power activity queue', () => {
  it('preserves one lease through nested authorized middleware and commands without deadlocking', async () => {
    const client = clientFixture()
    let calls = 0
    await enqueueInboundPowerActivity(client, 'nested', async () => {
      await Promise.resolve()
      const parent = currentInboundPowerLease('nested')
      expect(parent?.id).toBe(client.acquired[0])
      expect(currentInboundPowerLease('different')).toBeUndefined()
      await enqueueInboundPowerActivity(client, 'nested', async () => {
        expect(currentInboundPowerLease('nested')).toBe(parent)
        calls += 1
      })
    })
    expect(calls).toBe(1)
    expect(client.acquired).toHaveLength(1)
    expect(client.released).toEqual(client.acquired)
    expect(currentInboundPowerLease('nested')).toBeUndefined()
  })

  it('isolates concurrent chat contexts and retains only transferred messages', async () => {
    const client = clientFixture()
    const first: string[] = []
    await Promise.all(['one', 'two'].map(chatId => enqueueInboundPowerActivity(client, chatId, async () => {
      const lease = currentInboundPowerLease(chatId)!
      await new Promise(resolve => setTimeout(resolve, 1))
      expect(currentInboundPowerLease(chatId)).toBe(lease)
      if (chatId === 'one') { lease.transferred = true; first.push(lease.id) }
    })))
    expect(client.acquired).toHaveLength(2)
    expect(client.released).toEqual(client.acquired.filter(id => !first.includes(id)))
  })

  it('releases failing commands and continues the same queue after acquisition errors', async () => {
    const client = clientFixture()
    const errors: string[] = []
    const onError = async (error: unknown) => { errors.push(String(error)) }
    await enqueueInboundPowerActivity(client, 'failure', async () => { throw new Error('command failed') }, onError)
    expect(client.released).toEqual(client.acquired)
    client.acquirePowerActivityLease = async () => { throw new Error('cannot acquire') }
    let ran = false
    await enqueueInboundPowerActivity(client, 'failure', async () => { ran = true }, onError)
    expect(ran).toBe(false)
    expect(errors).toEqual(['Error: command failed', 'Error: cannot acquire'])
  })
})
