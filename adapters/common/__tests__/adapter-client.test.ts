import { afterEach, describe, expect, it, mock } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAdapterClient } from '../adapter-client.js'
import { loadConfig } from '../config.js'

const ADAPTERS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PLATFORMS = ['telegram', 'feishu', 'wechat', 'dingtalk', 'whatsapp'] as const
const HOME = fs.realpathSync(os.homedir())

const ORIGINAL_ENV = {
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  ADAPTER_ALLOWED_PROJECT_ROOTS: process.env.ADAPTER_ALLOWED_PROJECT_ROOTS,
  ADAPTER_DEFAULT_PROJECT_DIR: process.env.ADAPTER_DEFAULT_PROJECT_DIR,
  CLAUDE_ADAPTER_DEFAULT_WORK_DIR: process.env.CLAUDE_ADAPTER_DEFAULT_WORK_DIR,
  PWD: process.env.PWD,
}
const ORIGINAL_CWD = process.cwd()
const ORIGINAL_FETCH = globalThis.fetch

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  process.chdir(ORIGINAL_CWD)
  globalThis.fetch = ORIGINAL_FETCH
})

/** Boot an adapter config from a throwaway config dir with a clean env. */
function bootConfig(file: Record<string, unknown>): ReturnType<typeof loadConfig> {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-client-cfg-'))
  fs.writeFileSync(path.join(configDir, 'adapters.json'), JSON.stringify(file))
  process.env.CLAUDE_CONFIG_DIR = configDir
  delete process.env.ADAPTER_ALLOWED_PROJECT_ROOTS
  delete process.env.ADAPTER_DEFAULT_PROJECT_DIR
  delete process.env.CLAUDE_ADAPTER_DEFAULT_WORK_DIR
  return loadConfig()
}

/** What the bot would actually show for /projects, given what the server returns. */
async function listedProjects(
  client: { listRecentProjects: () => Promise<{ projectName: string }[]> },
  projects: { projectName: string; realPath: string }[],
): Promise<string[]> {
  globalThis.fetch = mock(() => Promise.resolve(Response.json({ projects }))) as any
  return (await client.listRecentProjects()).map((p) => p.projectName)
}

describe('createAdapterClient', () => {
  // The regression that started #1191, now pinned behaviourally rather than by
  // grepping the entrypoints.
  it('keeps every project under home reachable when a default project is set', async () => {
    const base = fs.mkdtempSync(path.join(HOME, '.cc-haha-test-'))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-haha-outside-'))
    try {
      const myApp = path.join(base, 'work', 'my-app')
      const sibling = path.join(base, 'side', 'blog')
      for (const dir of [myApp, sibling]) fs.mkdirSync(dir, { recursive: true })

      for (const platform of PLATFORMS) {
        const config = bootConfig({ defaultProjectDir: myApp })
        const { httpClient, defaultWorkDir } = createAdapterClient(config, config[platform])

        expect(defaultWorkDir).toBe(fs.realpathSync(myApp))
        const names = await listedProjects(httpClient, [
          { projectName: 'my-app', realPath: myApp },
          { projectName: 'blog', realPath: sibling },
          { projectName: 'not-mine', realPath: outside },
        ])
        expect(names).toEqual(['my-app', 'blog'])
      }
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  // A GUI-launched sidecar inherits cwd "/" (Electron passes no cwd). Inheriting
  // that as a boundary would allow the whole filesystem while the docs and the
  // settings UI both promise "your home directory".
  it('never inherits a filesystem root as the boundary', async () => {
    process.chdir('/')
    delete process.env.PWD

    for (const platform of PLATFORMS) {
      const config = bootConfig({})
      const { httpClient, defaultWorkDir } = createAdapterClient(config, config[platform])

      const names = await listedProjects(httpClient, [
        { projectName: 'etc', realPath: '/etc' },
        { projectName: 'home-project', realPath: HOME },
      ])
      expect(names).toEqual(['home-project'])
      expect(defaultWorkDir).toBe(HOME)
    }
  })

  // Narrowing the roots must not brick /new: the client rejects a workDir outside
  // the boundary, and every adapter passes defaultWorkDir straight to createSession.
  it('always yields a default work dir inside the allowed roots', async () => {
    const allowed = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-haha-allowed-'))
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-haha-elsewhere-'))
    try {
      process.chdir('/')
      delete process.env.PWD

      for (const platform of PLATFORMS) {
        // Boundary narrowed to one dir, default project pointing somewhere else.
        const config = bootConfig({ allowedProjectRoots: [allowed], defaultProjectDir: elsewhere })
        const { httpClient, defaultWorkDir } = createAdapterClient(config, config[platform])

        expect(defaultWorkDir).toBe(fs.realpathSync(allowed))
        globalThis.fetch = mock(() => Promise.resolve(Response.json({ sessionId: 'ok' }))) as any
        await expect(httpClient.createSession(defaultWorkDir)).resolves.toBe('ok')
      }
    } finally {
      fs.rmSync(allowed, { recursive: true, force: true })
      fs.rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it('honours an explicitly narrowed boundary', async () => {
    const allowed = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-haha-allowed-'))
    const denied = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-haha-denied-'))
    try {
      const config = bootConfig({ allowedProjectRoots: [allowed] })
      const { httpClient } = createAdapterClient(config, config.feishu)

      const names = await listedProjects(httpClient, [
        { projectName: 'allowed', realPath: allowed },
        { projectName: 'denied', realPath: denied },
        { projectName: 'home', realPath: HOME },
      ])
      expect(names).toEqual(['allowed'])
    } finally {
      fs.rmSync(allowed, { recursive: true, force: true })
      fs.rmSync(denied, { recursive: true, force: true })
    }
  })
})

/**
 * Structural guard for the five entrypoints. They boot a live bot on import
 * (credentials are read and process.exit is called), so they cannot be imported
 * in a test. The behaviour above is covered by exercising the factory directly;
 * this only pins that each entrypoint actually delegates to it.
 */
describe('IM adapter entrypoint wiring', () => {
  for (const platform of PLATFORMS) {
    it(`${platform} builds its client through createAdapterClient`, () => {
      const source = fs.readFileSync(path.join(ADAPTERS_DIR, platform, 'index.ts'), 'utf-8')
        // Strip comments so a mention in prose cannot satisfy the assertions.
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')

      expect(source).toMatch(
        new RegExp(`createAdapterClient\\s*\\(\\s*config\\s*,\\s*config\\.${platform}\\s*\\)`),
      )
      // Constructing a client here would bypass the resolved boundary entirely,
      // which is exactly how all five adapters shared the #1191 defect.
      expect(source).not.toMatch(/new\s+AdapterHttpClient/)
      // Nor may an entrypoint re-derive the boundary or the work dir itself.
      expect(source).not.toMatch(/resolveAllowedProjectRoots|getConfiguredWorkDir/)
    })
  }
})
