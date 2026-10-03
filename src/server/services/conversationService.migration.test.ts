import { expect, spyOn, test } from 'bun:test'
import { ConversationService } from './conversationService.js'
import { migrationMaintenance } from '../migrationMaintenance.js'

test('migration ends the CLI over its control stream, then waits for exit and output writes', async () => {
  const service = new ConversationService() as any
  let releaseExit!: (code: number) => void
  let releaseWrites!: () => void
  const exited = new Promise<number>(resolve => { releaseExit = resolve })
  const outputDrain = new Promise<void>(resolve => { releaseWrites = resolve })
  service.sessions.set('active', {
    proc: { exitCode: null, exited, kill: () => { throw new Error('Unsafe force termination') } },
    outputDrain,
  })
  const control = spyOn(service, 'requestControl').mockResolvedValue({})
  let stopped = false
  const stopping = service.stopForMigration().then(() => { stopped = true })
  try {
    await Promise.resolve()
    expect(control).toHaveBeenCalledWith('active', { subtype: 'end_session', reason: 'data_migration' }, 10_000)
    expect(stopped).toBe(false)
    releaseExit(0)
    await Promise.resolve()
    expect(stopped).toBe(false)
    releaseWrites()
    await stopping
    expect(service.getActiveSessions()).toEqual([])
  } finally {
    releaseExit(0)
    releaseWrites()
    control.mockRestore()
  }
})

test('migration refuses to finish when a CLI graceful-control request fails', async () => {
  const service = new ConversationService() as any
  service.sessions.set('active', { proc: { exitCode: null }, outputDrain: Promise.resolve() })
  const control = spyOn(service, 'requestControl').mockRejectedValue(new Error('CLI control unavailable'))
  try {
    await expect(service.stopForMigration()).rejects.toThrow('CLI control unavailable')
    expect(service.getActiveSessions()).toEqual(['active'])
  } finally {
    control.mockRestore()
  }
})

test('migration rejects new sends and revokes a send already waiting for attachment preparation', async () => {
  const service = new ConversationService() as any
  let release!: () => void
  const prepared = new Promise<void>(resolve => { release = resolve })
  const content = spyOn(service, 'buildUserContent').mockImplementation(async () => {
    await prepared
    return [{ type: 'text', text: 'Fixture prompt' }]
  })
  const send = spyOn(service, 'sendSdkMessage').mockReturnValue(true)
  try {
    const pending = service.sendMessage('fixture', 'Fixture prompt')
    migrationMaintenance.begin()
    expect(await service.sendMessage('fixture', 'Should never prepare')).toBe(false)
    expect(content).toHaveBeenCalledTimes(1)
    release()
    expect(await pending).toBe(false)
    expect(send).not.toHaveBeenCalled()
  } finally {
    release()
    migrationMaintenance.resetForTests()
    content.mockRestore()
    send.mockRestore()
  }
})
