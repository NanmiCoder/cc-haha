/** Compiled fixture executable. It models a button and never calls a desktop API. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'

const config = process.env.CLAUDE_CONFIG_DIR
const home = process.env.AGENT_DESKTOP_HOME
const log = process.env.MOCK_AGENT_DESKTOP_LOG
const cwd = process.env.MOCK_AGENT_DESKTOP_CWD
if (!config || !home || !log || !cwd || relative(config, home).startsWith('..')
  || isAbsolute(relative(config, home)) || relative(config, log).startsWith('..')
  || isAbsolute(relative(config, log))) {
  throw new Error('Native fixture requires isolated state and the calling Agent working directory')
}
const argv = process.argv.slice(2)
let cursor = 0
let session: string | undefined
let agent: string | undefined
let headed = false
while (argv[cursor]?.startsWith('--')) {
  const flag = argv[cursor++]
  if (flag === '--session') session = argv[cursor++]
  else if (flag === '--agent-id') agent = argv[cursor++]
  else if (flag === '--headed') headed = true
  else throw new Error(`Unexpected host global option: ${flag}`)
}
const command = argv[cursor++]
const args = argv.slice(cursor)
const teardown = (command === 'cursor-overlay' && args[0] === 'disable') || (command === 'session' && args[0] === 'end')
if (realpathSync(process.cwd()) !== realpathSync(teardown ? home : cwd)) {
  throw new Error('Native fixture did not retain the expected action or cleanup working directory')
}
const record = (event: string) => appendFileSync(log, `${JSON.stringify({
  event, pid: process.pid, command, args, session, agent, headed, cwd: process.cwd(),
  stateRoot: home, inheritedSession: process.env.AGENT_DESKTOP_SESSION,
})}\n`)
record('dispatch')
const output = (data: unknown) => console.log(JSON.stringify({ version: '2.5', ok: true, command, data }))
const statePath = join(home, 'fixture-button.json')
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { saved: false }
if (command === 'session') {
  if (args[0] === 'start') mkdirSync(home, { recursive: true, mode: 0o700 })
  output(args[0] === 'start' ? { session_id: 'fixture-native-session' } : { ended: true })
} else if (command === 'cursor-overlay') {
  output({ cursor_overlay: { enabled: args[0] === 'enable' } })
} else if (command === 'snapshot') {
  const snapshotId = state.saved ? 'safter' : 'sbefore'
  output({
    snapshot_id: snapshotId, ref_count: 1, complete: true,
    tree: { role: 'window', name: 'Fixture', children: [{
      role: 'button', name: state.saved ? 'Saved' : 'Save', ref_id: `@${snapshotId}:e1`,
    }] },
  })
} else if (command === 'click') {
  if (args[0] !== '@sbefore:e1' || state.saved) {
    console.log(JSON.stringify({ version: '2.5', ok: false, command, error: {
      code: 'STALE_REF', message: 'Fixture element no longer matches the observed snapshot',
      disposition: { delivery: 'not_delivered', retry: 'safe' },
    } }))
    process.exitCode = 1
  } else {
    writeFileSync(statePath, JSON.stringify({ saved: true }))
    if (process.env.AGENT_DESKTOP_CURSOR_FEEDBACK === '1') {
      console.error('CC_HAHA_CURSOR_FEEDBACK {"acknowledged":true,"warning":null}')
    }
    output({ disposition: { delivery: 'delivered_verified', retry: 'unsafe' } })
  }
} else if (command === 'wait') {
  process.on('SIGTERM', () => {
    record('terminated')
    if (args[0] === '100001') setTimeout(() => { record('input-released'); process.exit(0) }, 2_050)
    else process.exit(0)
  })
  record('waiting')
  await Bun.sleep(100_000)
  record('unexpected-wait-completed')
  output({ completed: true })
} else if (command === 'status') {
  const checkStorage = args.includes('--check-session-storage')
  if (checkStorage) mkdirSync(home, { recursive: true, mode: 0o700 })
  output({
    platform: process.env.MOCK_AGENT_DESKTOP_PLATFORM,
    supported_surfaces: ['window'],
    permissions: { accessibility: { state: 'granted' } },
    ...(checkStorage ? { session_storage: { ready: true } } : {}),
  })
} else if (command === 'skills') {
  output({ content: 'Fixture native desktop workflow: snapshot, act on the qualified ref, verify.' })
} else {
  throw new Error(`Unexpected native fixture command: ${command}`)
}
