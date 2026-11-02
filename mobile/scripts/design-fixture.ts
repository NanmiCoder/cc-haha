/**
 * DESIGN ACCEPTANCE TEST SERVICE ONLY. Two isolated in-memory hosts, no model,
 * child process, user configuration, repository files, push delivery or persistence.
 * Run from mobile/: bun scripts/design-fixture.ts [--port=3457] [--second-port=3458]
 * Restart to reset all samples. These are not live-backend or provider evidence.
 *
 * Seed: fixture-approval/question (waiting), fixture-plan/bench (running),
 * fixture-release/settings (idle/completed). Open the QR task's activity sheet
 * to stop its 3 tasks; use its chat stop button to stop the whole turn.
 * For a plan screen without changing the six-session seed, POST
 * /__fixture/scenario {sessionId:'fixture-plan',kind:'plan'} with the fake bearer.
 * Other scenario kinds: approval, question, idle. Every request gets a fresh ID.
 */
import { FIXTURE_TOKEN, startFixtureServer } from './fixture-server'

function port(name: string, fallback: number) {
  const argument = process.argv.find((value) => value.startsWith(`--${name}=`))
  return argument ? Number(argument.slice(name.length + 3)) : fallback
}

if (import.meta.main) {
  const first = startFixtureServer({
    port: port('port', 3457),
    design: true,
    hostName: 'MacBook Pro · Fixture A',
  })
  let second: ReturnType<typeof startFixtureServer>
  try {
    second = startFixtureServer({
      port: port('second-port', 3458),
      design: true,
      hostName: 'Mac mini · Fixture B',
    })
  } catch (error) {
    await first.close()
    throw error
  }
  for (const fixture of [first, second]) {
    const base = `http://127.0.0.1:${fixture.server.port}`
    console.log(
      `Pairing QR payload: ${base}/?${new URLSearchParams({ serverUrl: base, h5Token: FIXTURE_TOKEN })}`
    )
  }
  const shutdown = () => {
    void Promise.all([first.close(), second.close()]).then(() =>
      process.exit(0)
    )
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}
