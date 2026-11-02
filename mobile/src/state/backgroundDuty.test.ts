import { expect, test } from 'bun:test'
import { BackgroundDuty, type DutyHost } from './backgroundDuty'

const host = (id: string): DutyHost => ({
  hostId: id,
  hostName: `Mac ${id}`,
  origin: 'http://192.168.1.8:3456',
  headers: { Authorization: 'Bearer fixture' },
  token: 'p'.repeat(43),
})

function fixture(failures = 0) {
  const calls: string[] = []
  let remaining = failures
  const fail = () => {
    if (remaining-- > 0) throw new Error('service unavailable')
  }
  const duty = new BackgroundDuty({
    setHost: (json) => { fail(); calls.push(`set:${JSON.parse(json).hostId}`) },
    removeHost: (id) => { fail(); calls.push(`remove:${id}`) },
    retainHosts: (json) => { fail(); calls.push(`retain:${JSON.parse(json).join(',')}`) },
    setAppActive: (active) => calls.push(`active:${active}`),
  })
  return { duty, calls }
}

test('each registration result touches only its own computer', () => {
  // At launch, home answers first while the office computer is still offline:
  // the office stays in the service's own list instead of being overwritten.
  const f = fixture()
  f.duty.set('home', host('home'))
  f.duty.set('office', undefined)
  expect(f.calls).toEqual(['set:home', 'remove:office'])
})

test('an unchanged re-registration is sent again so the service can restore a dropped computer', () => {
  const f = fixture()
  f.duty.set('home', host('home'))
  f.duty.set('home', host('home'))
  expect(f.calls).toEqual(['set:home', 'set:home'])
})

test('the host list is pruned to the computers the phone still has', () => {
  const f = fixture()
  f.duty.retain(['home', 'office'])
  expect(f.calls).toEqual(['retain:home,office'])
})

test('a failing or missing native module never throws into registration', () => {
  const f = fixture(3)
  expect(() => {
    f.duty.set('home', host('home'))
    f.duty.set('home', undefined)
    f.duty.retain([])
  }).not.toThrow()
  const absent = new BackgroundDuty(null)
  expect(() => {
    absent.set('home', host('home'))
    absent.retain(['home'])
    absent.setAppActive(true)
  }).not.toThrow()
})
