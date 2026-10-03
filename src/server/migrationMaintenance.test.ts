import { expect, test } from 'bun:test'
import { MigrationMaintenance } from './migrationMaintenance.js'

test('migration closes admission immediately and waits for work beyond a disconnected response', async () => {
  const maintenance = new MigrationMaintenance()
  let finish!: () => void
  maintenance.track(new Promise<void>(resolve => { finish = resolve }))
  maintenance.begin()
  expect(() => maintenance.assertAvailable()).toThrow('Data migration')
  let drained = false
  const drain = maintenance.drain().then(() => { drained = true })
  await Promise.resolve()
  expect(drained).toBe(false)
  finish()
  await drain
  expect(drained).toBe(true)
})

test('migration drains follow-up writes started by existing work', async () => {
  const maintenance = new MigrationMaintenance()
  let finish!: () => void
  const write = new Promise<void>(resolve => { finish = resolve })
  maintenance.track(Promise.resolve().then(() => { maintenance.track(write) }))
  const drain = maintenance.drain()
  finish()
  await drain
})
