import path from 'node:path'

export const DEFAULT_RENDERER_URL = 'http://localhost:1420'
export const LOCAL_NO_PROXY_ENTRIES = ['localhost', '127.0.0.1', '::1']

export function mergeNoProxy(existing: string | undefined, required = LOCAL_NO_PROXY_ENTRIES) {
  const entries = new Set(
    (existing ?? '')
      .split(',')
      .map(entry => entry.trim())
      .filter(Boolean),
  )
  for (const entry of required) entries.add(entry)
  return Array.from(entries).join(',')
}

export function createElectronDevEnv(env: NodeJS.ProcessEnv = process.env) {
  const rendererUrl = env.ELECTRON_RENDERER_URL ?? DEFAULT_RENDERER_URL
  const noProxy = mergeNoProxy(env.NO_PROXY ?? env.no_proxy)
  return {
    ...env,
    ELECTRON_RENDERER_URL: rendererUrl,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  }
}

async function waitForRenderer(rendererUrl: string) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(rendererUrl)
      if (response.ok) return
    } catch {
      await Bun.sleep(250)
    }
  }
  throw new Error(`Timed out waiting for Vite renderer at ${rendererUrl}`)
}

async function main() {
  // import.meta.dirname resolves to a native OS path. The previous
  // `new URL('..', import.meta.url).pathname` produced a malformed cwd on
  // Windows (e.g. `/D:/.../desktop/`) which made Bun.spawn fail with ENOENT.
  const desktopRoot = path.resolve(import.meta.dirname, '..')
  const childEnv = createElectronDevEnv()
  const rendererUrl = childEnv.ELECTRON_RENDERER_URL
  process.env.NO_PROXY = childEnv.NO_PROXY
  process.env.no_proxy = childEnv.no_proxy

  // Use process.execPath (absolute path to the running bun) instead of the
  // bare 'bun' command. Bun.spawn resolves bare names via PATH, which is
  // unreliable on Windows when bun is reached through an npm .cmd shim that
  // the child process does not inherit — it fails with ENOENT on 'bun'.
  // process.execPath always resolves because it is the currently running binary.
  const vite = Bun.spawn([process.execPath, 'run', 'dev'], {
    cwd: desktopRoot,
    env: childEnv,
    stdout: 'inherit',
    stderr: 'inherit',
  })

  function stopVite() {
    vite.kill()
  }

  process.on('SIGINT', () => {
    stopVite()
    process.exit(130)
  })
  process.on('SIGTERM', () => {
    stopVite()
    process.exit(143)
  })

  await waitForRenderer(rendererUrl)

  const electron = Bun.spawn([process.execPath, 'x', 'electron', './electron-dist/main.cjs'], {
    cwd: desktopRoot,
    env: childEnv,
    stdout: 'inherit',
    stderr: 'inherit',
  })

  const exitCode = await electron.exited
  stopVite()
  process.exit(exitCode)
}

if (import.meta.main) {
  await main()
}
