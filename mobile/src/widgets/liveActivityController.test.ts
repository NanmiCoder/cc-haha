import { expect, test } from 'bun:test'
import {
  TaskActivityController,
  type ActivityFactory,
  type ActivityInstance,
} from './liveActivityController'
import { taskActivityData, type TaskActivityProps } from './activityData'
import type { Host, Session } from '../core/types'
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

function endingFactory(log: string[], ends: { policy: unknown; props?: TaskActivityProps }[]) {
  const source = factory(log)
  const create = source.start
  source.start = (value, url, date) => ({
    ...create(value, url, date),
    end: async (policy, finalProps) => {
      ends.push({ policy, props: finalProps })
      log.push(`end:${value.sessionId}`)
    },
  })
  return source
}
const finishedProps = (sessionId: string, status: 'completed' | 'failed'): TaskActivityProps => ({
  ...props('a'),
  sessionId,
  status,
  detail: '',
  summary: status === 'completed' ? '完成 · 用时 1:00' : '出错停下',
})

test('a tracked task that finishes shows its outcome until the dismissal date and revokes its push registration', async () => {
  const log: string[] = []
  const ends: { policy: unknown; props?: TaskActivityProps }[] = []
  const controller = new TaskActivityController(endingFactory(log, ends), () => 1_000)
  const register = async () => async () => {
    log.push('revoke')
  }
  await controller.sync(props('a'), register, 'a')
  const done = { props: finishedProps('session', 'completed'), dismissAt: 61_000 }
  await controller.sync(null, register, 'a', [done])
  expect(ends).toEqual([{ policy: { after: new Date(61_000) }, props: done.props }])
  expect(log).toEqual(['start:a', 'end:session', 'revoke'])
  // The concluded card is not restarted by later snapshots that still report the outcome.
  await controller.sync(null, register, 'a', [done])
  expect(log).toEqual(['start:a', 'end:session', 'revoke'])
})

test('an outcome already past its window ends immediately and a different running task starts afterwards', async () => {
  const log: string[] = []
  const ends: { policy: unknown; props?: TaskActivityProps }[] = []
  const controller = new TaskActivityController(endingFactory(log, ends), () => 100_000)
  await controller.sync(props('a'), async () => undefined, 'a')
  const other = { ...props('a'), sessionId: 'other' }
  await controller.sync(other, async () => undefined, 'a', [
    { props: finishedProps('session', 'failed'), dismissAt: 50_000 },
  ])
  expect(ends[0]).toEqual({ policy: 'immediate', props: undefined })
  expect(log).toEqual(['start:a', 'end:session', 'start:a'])
})

test('finished entries for other sessions, or a session that is live again, do not end the tracked card', async () => {
  const log: string[] = []
  const ends: { policy: unknown; props?: TaskActivityProps }[] = []
  const controller = new TaskActivityController(endingFactory(log, ends), () => 1_000)
  await controller.sync(props('a'), async () => undefined, 'a')
  await controller.sync(props('a'), async () => undefined, 'a', [
    { props: finishedProps('elsewhere', 'completed'), dismissAt: 9_000 },
    { props: finishedProps('session', 'completed'), dismissAt: 9_000 },
  ])
  expect(ends).toEqual([])
  expect(log).toEqual(['start:a', 'update:a'])
  // Never starts an activity just to announce an outcome.
  const fresh = new TaskActivityController(endingFactory(log, ends), () => 1_000)
  await fresh.sync(null, async () => undefined, 'a', [
    { props: finishedProps('session', 'completed'), dismissAt: 9_000 },
  ])
  expect(log).toEqual(['start:a', 'update:a'])
})

test('decisions mode ends the lock-screen activity once the approval is handled and the task keeps running', async () => {
  const log: string[] = []
  const controller = new TaskActivityController(factory(log), () => 100)
  const host: Host = { id: 'a', name: 'a', auth: 'lan', url: 'http://127.0.0.1:3456' }
  const sessions = [{ id: 'session', title: 'task' }] as Session[]
  const options = { mode: 'decisions' as const }
  const register = async () => {
    log.push('register')
    return async () => {
      log.push('unregister')
    }
  }
  const waiting = taskActivityData(
    host,
    sessions,
    [{ id: 'session', activityState: 'waiting', requestId: 'r', toolName: 'Bash' }],
    true,
    100,
    options
  )
  await controller.sync(waiting, register, 'k')
  const running = taskActivityData(
    host,
    sessions,
    [{ id: 'session', activityState: 'running', startedAt: 1 }],
    true,
    100,
    options
  )
  expect(running).toBeNull()
  await controller.sync(running, register, 'k')
  expect(log).toEqual(['start:a', 'register', 'end:a', 'unregister'])
})
