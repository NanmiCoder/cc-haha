import { expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import { installAdapterMigrationControl } from '../migration-control.js'

test('authenticated inherited pipe drains writes before acknowledgement and clean exit', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  let release!: () => void
  let didExit!: (code: number) => void
  const exited = new Promise<number>(resolve => { didExit = resolve })
  const write = new Promise<void>(resolve => { release = resolve })
  let messages = ''
  let drains = 0
  output.on('data', chunk => { messages += chunk })
  installAdapterMigrationControl({ token: 'isolated-secret', input, output, quiesce: async () => { drains++; await write }, exit: didExit })
  input.write(JSON.stringify({ type: 'migration_quiesce', requestId: 'wrong', token: 'wrong' }) + '\n')
  expect(drains).toBe(0)
  input.write(JSON.stringify({ type: 'migration_quiesce', requestId: 'right', token: 'isolated-secret' }) + '\n')
  await Promise.resolve()
  expect(messages).toBe('')
  release()
  expect(await exited).toBe(0)
  expect(JSON.parse(messages)).toEqual({ type: 'migration_quiesced', requestId: 'right' })
  input.destroy()
  output.destroy()
})

test('failed credential drain cannot emit a successful migration acknowledgement', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  let didExit!: (code: number) => void
  const exited = new Promise<number>(resolve => { didExit = resolve })
  let messages = ''
  output.on('data', chunk => { messages += chunk })
  installAdapterMigrationControl({ token: 'isolated-secret', input, output, quiesce: async () => { throw new Error('Disk full') }, exit: didExit })
  input.write(JSON.stringify({ type: 'migration_quiesce', requestId: 'failure', token: 'isolated-secret' }) + '\n')
  expect(await exited).toBe(1)
  expect(JSON.parse(messages).type).toBe('migration_quiesce_failed')
  input.destroy()
  output.destroy()
})
