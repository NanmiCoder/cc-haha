import { expect, test } from 'bun:test'
import { FIXTURE_TOKEN, startFixtureServer } from '../../scripts/fixture-server'
import { ApiClient } from './client'
import type { BackgroundSnapshot } from './operations'
import { SessionTransport, type SocketLike } from './sessionTransport'
import type { ServerEvent } from './types'

async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`)
    await Bun.sleep(5)
  }
}

test('chat observes single and all background stops sent from a separate activity socket', async () => {
  const fixture = startFixtureServer({ port: 0, quiet: true, design: true })
  const client = new ApiClient(
    {
      id: 'task-lifecycle-fixture',
      name: 'Isolated task lifecycle fixture',
      url: `http://127.0.0.1:${fixture.server.port}`,
      auth: 'lan',
    },
    FIXTURE_TOKEN
  )
  const errors: Error[] = []
  const chat = new SessionTransport({
    client,
    credential: FIXTURE_TOKEN,
    sessionId: 'fixture-plan',
    platform: 'web',
    socketFactory: ({ url }) => new WebSocket(url) as unknown as SocketLike,
    onState() {},
    onConnection() {},
    onError: (error) => errors.push(error),
  })
  let activity: WebSocket | undefined
  try {
    chat.start()
    await until(() => chat.connection === 'ready', 'chat ready')
    const taskIds = [...chat.state.backgroundTaskIds]
    expect(taskIds).toHaveLength(3)
    const terminalEvents: string[] = []
    activity = new WebSocket(
      `${client.host.url.replace('http:', 'ws:')}/ws/fixture-plan?token=${FIXTURE_TOKEN}`
    )
    activity.onmessage = ({ data }) => {
      const event = JSON.parse(String(data)) as ServerEvent
      if (
        event.type === 'system_notification' &&
        event.subtype === 'task_notification'
      ) {
        const task = event.data as { task_id: string; status: string }
        if (task.status === 'stopped') terminalEvents.push(task.task_id)
      }
    }
    await until(() => activity?.readyState === 1, 'activity connected')
    activity.send(
      JSON.stringify({ type: 'stop_background_task', taskId: taskIds[0] })
    )
    await until(() => terminalEvents.includes(taskIds[0]), 'single stop ack')
    // The activity API is authoritative; the still-mounted chat must agree
    // without reconnecting or receiving another session_state snapshot.
    const afterSingle = await client.get<BackgroundSnapshot>(
      '/api/sessions/fixture-plan/background-tasks'
    )
    expect(
      afterSingle.tasks.filter((task) => task.status === 'running')
    ).toHaveLength(2)
    await until(
      () => !chat.state.backgroundTaskIds.includes(taskIds[0]),
      'chat consumes single stop'
    )
    expect(chat.state.backgroundTaskIds).toEqual(taskIds.slice(1))
    for (const taskId of taskIds.slice(1)) {
      activity.send(JSON.stringify({ type: 'stop_background_task', taskId }))
    }
    await until(() => terminalEvents.length === 3, 'all stops acknowledged')
    const afterAll = await client.get<BackgroundSnapshot>(
      '/api/sessions/fixture-plan/background-tasks'
    )
    expect(
      afterAll.tasks.filter((task) => task.status === 'running')
    ).toHaveLength(0)
    await until(
      () => chat.state.backgroundTaskIds.length === 0,
      'chat consumes remaining stops'
    )
    expect(chat.state.backgroundTaskIds).toEqual([])
    expect(errors).toEqual([])
  } finally {
    activity?.close()
    chat.dispose()
    await fixture.close()
  }
})
