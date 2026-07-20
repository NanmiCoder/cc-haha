import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, type ViteDevServer } from 'vite'

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

export function resolveElectronExecutable(desktopRoot: string, platform = process.platform) {
  const candidates = platform === 'win32'
    ? [path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe')]
    : platform === 'darwin'
      ? [path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')]
      : [path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron')]

  const electronPath = candidates.find(candidate => existsSync(candidate))
  if (!electronPath) {
    throw new Error(`Electron executable not found under ${path.join(desktopRoot, 'node_modules', 'electron', 'dist')}. Run "cd desktop && bun install" first.`)
  }
  return electronPath
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

async function startVite(desktopRoot: string) {
  const server = await createServer({
    root: desktopRoot,
    configFile: path.join(desktopRoot, 'vite.config.ts'),
  })
  await server.listen()
  server.printUrls()
  return server
}

async function closeVite(server: ViteDevServer) {
  await server.close().catch(() => undefined)
}

async function main() {
  const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const childEnv = createElectronDevEnv()
  const rendererUrl = childEnv.ELECTRON_RENDERER_URL
  process.env.NO_PROXY = childEnv.NO_PROXY
  process.env.no_proxy = childEnv.no_proxy

  const vite = await startVite(desktopRoot)

  async function stopVite() {
    await closeVite(vite)
  }

  process.on('SIGINT', () => {
    void stopVite().finally(() => process.exit(130))
  })
  process.on('SIGTERM', () => {
    void stopVite().finally(() => process.exit(143))
  })

  await waitForRenderer(rendererUrl)

  const electron = spawn(resolveElectronExecutable(desktopRoot), ['./electron-dist/main.cjs'], {
    cwd: desktopRoot,
    env: childEnv,
    stdio: 'inherit',
    windowsHide: true,
  })

  const exitCode = await new Promise<number>((resolve, reject) => {
    electron.once('error', reject)
    electron.once('exit', code => resolve(code ?? 0))
  })
  await stopVite()
  process.exit(exitCode)
}

if (import.meta.main) {
  await main()
}