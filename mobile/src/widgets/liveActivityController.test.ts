import { expect, test } from 'bun:test'
import {
  TaskActivityController,
  type ActivityFactory,
  type ActivityInstance,
} from './liveActivityController'
import type { TaskActivityProps } from './activityData'
const props = (hostId: string): TaskActivityProps => ({
  hostId,
  sessionId: 'session',
  hostName: hostId,
  title: 'task',
  detail: 'working',
  status: 'running',
  activeCount: 1,
  openUrl: `cchaha:///chat/session?host=${hostId}`,
})
function factory(log: string[]): ActivityFactory {
  return {
    getInstances: () => [],
    start: (value) => {
      log.push(`start:${value.hostId}`)
      return {
        getId: () => value.hostId,
        update: async (next) => {
          log.push(`update:${next.hostId}`)
        },
        end: async () => {
          log.push(`end:${value.hostId}`)
        },
        getPushToken: async () => 'fake-token',
        addPushTokenListener: () => ({ remove() {} }),
      }
    },
  }
}
test('native activity switches host ownership serially and never repoints its immutable deep link', async () => {
  const log: string[] = []
  const controller = new TaskActivityController(factory(log), () => 100)
  const register = async (id: string) => {
    log.push(`register:${id}`)
    return async () => {
      log.push(`unregister:${id}`)
    }
  }
  await Promise.all([
    controller.sync(props('a'), register, 'a'),
    controller.sync(props('b'), register, 'b'),
  ])
  expect(log).toEqual([
    'start:a',
    'register:a',
    'end:a',
    'unregister:a',
    'start:b',
    'register:b',
  ])
  await controller.sync(null, register, 'b')
  expect(log.slice(-2)).toEqual(['end:b', 'unregister:b'])
})
test('refresh updates stale date without repeatedly registering a token', async () => {
  const log: string[] = []
  const controller = new TaskActivityController(factory(log), () => 100)
  const register = async () => {
    log.push('register')
    return undefined
  }
  await controller.sync(props('a'), register, 'same')
  await controller.sync(props('a'), register, 'same')
  expect(log).toEqual(['start:a', 'register', 'update:a'])
})
test('process-recovered activities are retired before a new verified snapshot starts', async () => {
  const log: string[] = []
  const source = factory(log)
  source.getInstances = () => [
    {
      end: async () => {
        log.push('retire-old')
      },
    } as ActivityInstance,
  ]
  const controller = new TaskActivityController(source)
  await controller.sync(props('a'), async () => undefined, 'a')
  expect(log).toEqual(['retire-old', 'start:a'])
})

test('preference updates delete the old registration before replacing a potentially identical server id', async () => {
  const log: string[] = []
  const controller = new TaskActivityController(factory(log), () => 100)
  const register = async () => {
    log.push('put:same-id')
    return async () => {
      log.push('delete:same-id')
    }
  }
  await controller.sync(props('a'), register, 'decisions-on')
  await controller.sync(props('a'), register, 'decisions-off')
  expect(log.slice(-3)).toEqual(['update:a', 'delete:same-id', 'put:same-id'])
})

test('a rotated push token uses the latest preferences rather than the callback captured at activity creation', async () => {
  const log: string[] = []
  let listener!: (event: { pushToken: string }) => void
  const source = factory(log)
  const create = source.start
  source.start = (value, url, staleDate) => ({
    ...create(value, url, staleDate),
    addPushTokenListener: (callback) => {
      listener = callback
      return { remove() {} }
    },
  })
  const controller = new TaskActivityController(source, () => 100)
  const first = async () => {
    log.push('preferences:old')
    return async () => {}
  }
  const latest = async (_id: string, token: string) => {
    log.push(`preferences:new:${token}`)
    return async () => {}
  }
  await controller.sync(props('a'), first, 'old')
  await controller.sync(props('a'), latest, 'new')
  listener({ pushToken: 'rotated-token' })
  await controller.retireHost('a')
  expect(log.filter((value) => value.startsWith('preferences:'))).toEqual([
    'preferences:old',
    'preferences:new:fake-token',
    'preferences:new:rotated-token',
  ])
})

test('host removal ends its native activity after bulk revoke without issuing another HTTP registration cleanup', async () => {
  const log: string[] = []
  const controller = new TaskActivityController(factory(log))
  await controller.sync(
    props('a'),
    async () => async () => {
      log.push('http-revoke')
    },
    'a'
  )
  await controller.retireHost('b')
  expect(log).toEqual(['start:a'])
  await controller.retireHost('a')
  expect(log).toEqual(['start:a', 'end:a'])
})

test('removing a host before its first fresh snapshot retires process-recovered native cards', async () => {
  const log: string[] = []
  const source = factory(log)
  source.getInstances = () => [
    {
      end: async () => {
        log.push('retire-old')
      },
    } as ActivityInstance,
  ]
  await new TaskActivityController(source).retireHost('a')
  expect(log).toEqual(['retire-old'])
})

test('foreground offline removes approval links immediately even when HTTP token registration is delayed', async () => {
  const log: string[] = [],
    updates: { props: TaskActivityProps; staleDate?: Date }[] = []
  let release!: () => void, started!: () => void
  const entered = new Promise<void>((resolve) => {
    started = resolve
  })
  const delayed = new Promise<void>((resolve) => {
    release = resolve
  })
  const source = factory(log),
    create = source.start
  source.start = (value, url, date) => ({
    ...create(value, url, date),
    update: async (next, staleDate) => {
      updates.push({ props: next, staleDate })
    },
  })
  const controller = new TaskActivityController(source, () => 100)
  const waiting = {
    ...props('a'),
    status: 'waiting' as const,
    allowUrl: 'cchaha:///allow',
    denyUrl: 'cchaha:///deny',
  }
  const register = async () => {
    started()
    await delayed
    return async () => {
      log.push('revoke')
    }
  }
  const syncing = controller.sync(waiting, register, 'a')
  await entered
  await controller.markStale()
  expect(updates[0]?.props.allowUrl).toBeUndefined()
  expect(updates[0]?.props.denyUrl).toBeUndefined()
  expect(updates[0]?.props.connectionState).toBe('stale')
  expect(updates[0]?.staleDate?.getTime()).toBe(99)
  expect(log).not.toContain('revoke')
  release()
  await syncing
  await controller.sync(waiting, register, 'a')
  expect(updates.at(-1)?.props.allowUrl).toBe(waiting.allowUrl)
  expect(updates.at(-1)?.props.connectionState).toBeUndefined()
  expect(updates.at(-1)?.staleDate?.getTime()).toBe(90100)
})

test('foreground offline before the first snapshot retires unknown recovered activity cards', async () => {
  const log: string[] = []
  const source = factory(log)
  source.getInstances = () => [
    {
      end: async () => {
        log.push('retire-old')
      },
    } as ActivityInstance,
  ]
  const controller = new TaskActivityController(source)
  await controller.markStale()
  expect(log).toEqual(['retire-old'])
})
