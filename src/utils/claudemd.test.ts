import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

let root: string
let cwd: string
let mode: string | undefined
let excludes: string[]
let additional: string[]
let disabledSources: Set<string>
let memory: typeof import('./claudemd.js')
let config: typeof import('./config.js')
let state: typeof import('../bootstrap/state.js')
let settings: typeof import('./settings/settings.js')
let sources: typeof import('./settings/constants.js')
let fsOperations: typeof import('./fsOperations.js')
let autoMem: typeof import('../memdir/paths.js')
let hooks: typeof import('./hooks.js')
const spies: Array<{ mockRestore(): void }> = []
const envKeys = ['HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD'] as const
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))

function put(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'agents-md-memory-')))
  process.env.HOME = join(root, 'home')
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  ;[config, state, settings, sources, fsOperations, autoMem, hooks] = await Promise.all([
    import('./config.js'), import('../bootstrap/state.js'), import('./settings/settings.js'),
    import('./settings/constants.js'), import('./fsOperations.js'), import('../memdir/paths.js'), import('./hooks.js'),
  ])
  memory = await import('./claudemd.js')
})

beforeEach(() => {
  cwd = join(root, 'project', 'child')
  rmSync(join(root, 'project'), { recursive: true, force: true })
  mkdirSync(cwd, { recursive: true })
  mode = undefined
  excludes = []
  additional = []
  disabledSources = new Set()
  delete process.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD
  const userSettings = () => ({ pluginConfigs: { 'agents-md@builtin': { options: { instructionFiles: mode } } } })
  spies.push(
    spyOn(state, 'getOriginalCwd').mockImplementation(() => cwd),
    spyOn(state, 'getAdditionalDirectoriesForClaudeMd').mockImplementation(() => additional),
    spyOn(config, 'getCurrentProjectConfig').mockReturnValue({} as ReturnType<typeof config.getCurrentProjectConfig>),
    spyOn(config, 'getMemoryPath').mockImplementation(type => join(root, 'policy', type, 'CLAUDE.md')),
    spyOn(config, 'getManagedClaudeRulesDir').mockReturnValue(join(root, 'policy', 'managed-rules')),
    spyOn(config, 'getUserClaudeRulesDir').mockReturnValue(join(root, 'policy', 'user-rules')),
    spyOn(settings, 'getInitialSettings').mockImplementation(() => ({ ...userSettings(), claudeMdExcludes: excludes })),
    spyOn(settings, 'getSettingsForSource').mockImplementation(source => source === 'userSettings' ? userSettings() : {}),
    spyOn(sources, 'isSettingSourceEnabled').mockImplementation(source => !disabledSources.has(source)),
    spyOn(autoMem, 'isAutoMemoryEnabled').mockReturnValue(false),
    spyOn(hooks, 'hasInstructionsLoadedHook').mockReturnValue(false),
  )
  // Real fixture reads, but never inspect instructions from host ancestors.
  const fs = fsOperations.getFsImplementation()
  spies.push(spyOn(fsOperations, 'getFsImplementation').mockReturnValue({
    ...fs,
    readFile: async (path, options) => {
      if (!path.startsWith(root + '/')) throw Object.assign(new Error('Outside fixture'), { code: 'ENOENT' })
      return fs.readFile(path, options)
    },
    readdir: async path => path.startsWith(root + '/') ? fs.readdir(path) : [],
  }))
  memory.clearMemoryFileCaches()
})

afterEach(() => {
  memory.clearMemoryFileCaches()
  for (const spy of spies.splice(0).reverse()) spy.mockRestore()
  rmSync(join(root, 'policy'), { recursive: true, force: true })
})

afterAll(() => {
  for (const key of envKeys) {
    const value = originalEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
})

const contents = async () => (await memory.getMemoryFiles()).map(file => file.content)
const nestedContents = async (dir = join(cwd, 'nested')) =>
  (await memory.getMemoryFilesForNestedDirectory(dir, join(dir, 'file.ts'), new Set())).map(file => file.content)

test('loads ancestor and dot-directory AGENTS instructions without CLAUDE instructions', async () => {
  put(join(dirname(cwd), 'AGENTS.md'), 'ancestor')
  put(join(cwd, 'AGENTS.md'), 'project')
  put(join(cwd, '.claude', 'AGENTS.md'), 'dot directory')
  expect(await contents()).toEqual(['ancestor', 'project', 'dot directory'])
})

test.each(['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'])('loaded ancestor %s suppresses all startup fallback', async name => {
  put(join(dirname(cwd), name), 'claude')
  put(join(cwd, 'AGENTS.md'), 'agents')
  expect(await contents()).toEqual(['claude'])
})

test('empty CLAUDE file does not suppress AGENTS fallback', async () => {
  put(join(cwd, 'CLAUDE.md'), '')
  put(join(cwd, 'AGENTS.md'), 'agents')
  expect(await contents()).toEqual(['agents'])
})

test('both mode deduplicates imported paths and equal contents', async () => {
  mode = 'claude-md-and-agents-md'
  put(join(cwd, 'CLAUDE.md'), '@./AGENTS.md\nclaude')
  put(join(cwd, 'AGENTS.md'), 'agents')
  put(join(cwd, '.claude', 'AGENTS.md'), 'additional agents')
  put(join(dirname(cwd), 'AGENTS.md'), 'agents')
  const loaded = await contents()
  expect(loaded.filter(content => content === 'agents')).toHaveLength(1)
  expect(loaded).toContain('additional agents')
  expect(loaded).toHaveLength(3)
})

test('claude-only mode ignores AGENTS files', async () => {
  mode = 'claude-md'
  put(join(cwd, 'AGENTS.md'), 'agents')
  expect(await contents()).toEqual([])
})

test('managed-only preserves managed memory and excludes project, local, and nested rules', async () => {
  mode = 'managed-only'
  put(join(root, 'policy', 'Managed', 'CLAUDE.md'), 'managed')
  const autoPath = join(root, 'policy', 'MEMORY.md')
  put(autoPath, 'auto memory')
  spies.push(
    spyOn(autoMem, 'isAutoMemoryEnabled').mockReturnValue(true),
    spyOn(autoMem, 'getAutoMemEntrypoint').mockReturnValue(autoPath),
  )
  put(join(root, 'policy', 'User', 'CLAUDE.md'), 'user')
  for (const dir of [cwd, join(cwd, 'nested')]) {
    for (const file of ['CLAUDE.md', 'AGENTS.md', 'CLAUDE.local.md', '.claude/rules/test.md']) put(join(dir, file), file)
  }
  expect(await contents()).toEqual(['managed', 'auto memory'])
  expect(await nestedContents()).toEqual([])
})

test('nested AGENTS loads unless session or directory CLAUDE instructions apply', async () => {
  put(join(cwd, 'nested', 'AGENTS.md'), 'nested agents')
  expect(await nestedContents()).toEqual(['nested agents'])
  put(join(cwd, 'CLAUDE.md'), 'session claude')
  memory.clearMemoryFileCaches()
  expect(await nestedContents()).toEqual([])
  rmSync(join(cwd, 'CLAUDE.md'))
  put(join(cwd, 'nested', 'CLAUDE.md'), 'nested claude')
  memory.clearMemoryFileCaches()
  expect(await nestedContents()).toEqual(['nested claude'])
})

test('AGENTS imports retain excludes and project source gating', async () => {
  put(join(cwd, 'AGENTS.md'), '@./detail.md\nproject')
  put(join(cwd, 'detail.md'), 'included')
  expect(await contents()).toEqual(['@./detail.md\nproject', 'included'])
  excludes = ['**/AGENTS.md']
  memory.clearMemoryFileCaches()
  expect(await contents()).toEqual([])
  excludes = []
  disabledSources.add('projectSettings')
  memory.clearMemoryFileCaches()
  expect(await contents()).toEqual([])
})

test('explicit additional directories discover AGENTS when project sources are disabled', async () => {
  additional = [join(cwd, 'extra')]
  put(join(additional[0]!, 'AGENTS.md'), 'additional agents')
  process.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = '1'
  disabledSources.add('projectSettings')
  expect((await memory.getMemoryFiles(true)).map(file => file.content)).toEqual(['additional agents'])
})

test('recognizes AGENTS files for memory change tracking without broadening unrelated paths', () => {
  expect(memory.isMemoryFilePath(join(cwd, 'AGENTS.md'))).toBe(true)
  expect(memory.isMemoryFilePath(join(cwd, '.claude', 'AGENTS.md'))).toBe(true)
  expect(memory.isMemoryFilePath(join(cwd, 'agents.md'))).toBe(false)
  expect(memory.isMemoryFilePath(join(cwd, 'AGENTS.local.md'))).toBe(false)
})


test('user CLAUDE memory does not disable project AGENTS fallback', async () => {
  put(join(root, 'policy', 'User', 'CLAUDE.md'), 'user')
  put(join(cwd, 'AGENTS.md'), 'project agents')
  expect(await contents()).toEqual(['user', 'project agents'])
})

test('excluded CLAUDE instructions do not suppress fallback', async () => {
  put(join(cwd, 'CLAUDE.md'), 'excluded claude')
  put(join(cwd, 'AGENTS.md'), 'agents')
  excludes = ['**/CLAUDE.md']
  expect(await contents()).toEqual(['agents'])
})

test('AGENTS external includes require the existing approval gate', async () => {
  const external = join(root, 'policy', 'external.md')
  put(external, 'external')
  const text = `@${external}\nproject`
  put(join(cwd, 'AGENTS.md'), text)
  expect(await contents()).toEqual([text])
  expect((await memory.getMemoryFiles(true)).map(file => file.content)).toEqual([text, 'external'])
})

test('disabled project source excludes nested AGENTS and project rules', async () => {
  const dir = join(cwd, 'nested')
  put(join(dir, 'AGENTS.md'), 'nested agents')
  put(join(dir, '.claude', 'rules', 'test.md'), 'nested rule')
  disabledSources.add('projectSettings')
  expect(await nestedContents()).toEqual([])
})

test('user context follows instruction settings changes without clearing prompt caches', async () => {
  const { getUserContext } = await import('../context.js')
  getUserContext.cache.clear?.()
  put(join(cwd, 'CLAUDE.md'), 'Claude context fixture')
  put(join(cwd, 'AGENTS.md'), 'Agents context fixture')
  try {
    mode = 'claude-md'
    expect((await getUserContext()).claudeMd).toContain('Claude context fixture')
    expect((await getUserContext()).claudeMd).not.toContain('Agents context fixture')
    mode = 'claude-md-and-agents-md'
    expect((await getUserContext()).claudeMd).toContain('Agents context fixture')
    mode = 'managed-only'
    expect((await getUserContext()).claudeMd).toBeUndefined()
    expect(state.getCachedClaudeMdContent()).toBeNull()
    mode = 'claude-md'
    expect((await getUserContext()).claudeMd).toContain('Claude context fixture')
    expect(state.getCachedClaudeMdContent()).toContain('Claude context fixture')
    expect(state.getCachedClaudeMdContent()).not.toContain('Agents context fixture')
  } finally {
    getUserContext.cache.clear?.()
  }
})

test('additional directories make independent fallback decisions', async () => {
  additional = [join(cwd, 'extra')]
  process.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = '1'
  put(join(cwd, 'AGENTS.md'), 'project agents')
  put(join(additional[0]!, 'CLAUDE.md'), 'additional claude')
  put(join(additional[0]!, 'AGENTS.md'), 'additional agents')
  expect(await contents()).toEqual(['project agents', 'additional claude'])
  mode = 'claude-md-and-agents-md'
  expect(await contents()).toEqual(['project agents', 'additional claude', 'additional agents'])
})

test('both mode inserts AGENTS after same-directory instructions and before descendants', async () => {
  mode = 'claude-md-and-agents-md'
  put(join(dirname(cwd), 'CLAUDE.md'), 'parent claude')
  put(join(dirname(cwd), 'CLAUDE.local.md'), 'parent local')
  put(join(dirname(cwd), '.claude/rules/rule.md'), 'parent rule')
  put(join(dirname(cwd), 'AGENTS.md'), 'parent agents')
  put(join(cwd, 'CLAUDE.md'), 'child claude')
  expect(await contents()).toEqual(['parent claude', 'parent rule', 'parent local', 'parent agents', 'child claude'])
})

test('nested AGENTS does not repeat instructions already in initial context', async () => {
  put(join(cwd, 'AGENTS.md'), 'shared instructions')
  put(join(cwd, 'nested', 'AGENTS.md'), 'shared instructions')
  expect(await contents()).toEqual(['shared instructions'])
  expect(await nestedContents()).toEqual([])
})

test('nested worktrees skip checked-in parent instructions when deciding fallback', async () => {
  const git = await import('./git.js')
  const mainRoot = join(root, 'project')
  cwd = join(mainRoot, '.claude', 'worktrees', 'fixture')
  put(join(mainRoot, 'CLAUDE.md'), 'main checkout only')
  put(join(cwd, 'AGENTS.md'), 'worktree instructions')
  spies.push(
    spyOn(git, 'findGitRoot').mockReturnValue(cwd),
    spyOn(git, 'findCanonicalGitRoot').mockReturnValue(mainRoot),
  )
  expect(await contents()).toEqual(['worktree instructions'])
})
