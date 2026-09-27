import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadMarkdownFilesForSubdir } from './markdownConfigLoader.js'
import { parseAgentFromMarkdown } from '../tools/AgentTool/loadAgentsDir.js'

test('markdown agent hash follows the parsed bytes through the common loader', async () => {
  const root = await mkdtemp(join(tmpdir(), 'markdown-agent-source-'))
  const oldConfig = process.env.CLAUDE_CONFIG_DIR, oldHome = process.env.HOME, oldNative = process.env.CLAUDE_CODE_USE_NATIVE_FILE_SEARCH
  process.env.HOME = root
  process.env.CLAUDE_CONFIG_DIR = join(root, 'user')
  process.env.CLAUDE_CODE_USE_NATIVE_FILE_SEARCH = '1'
  const project = join(root, 'project'), dir = join(project, '.claude', 'agents')
  const content = '---\nname: fixture\ndescription: Fixture agent\n---\nOriginal instructions.\n'
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'fixture.md'), content)
    loadMarkdownFilesForSubdir.cache.clear?.()
    const file = (await loadMarkdownFilesForSubdir('agents', project)).find(item => item.filePath === join(dir, 'fixture.md'))
    expect(file?.sourceContentHash).toBe(createHash('sha256').update(content).digest('hex'))
    const parsed = parseAgentFromMarkdown(file!.filePath, file!.baseDir, file!.frontmatter, file!.content, file!.source, file!.sourceContentHash)
    expect(parsed?.sourceContentHash).toBe(file!.sourceContentHash)
    expect(parsed?.rawSystemPrompt).toBe('Original instructions.')
  } finally {
    loadMarkdownFilesForSubdir.cache.clear?.()
    if (oldConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = oldConfig
    if (oldHome === undefined) delete process.env.HOME
    else process.env.HOME = oldHome
    if (oldNative === undefined) delete process.env.CLAUDE_CODE_USE_NATIVE_FILE_SEARCH
    else process.env.CLAUDE_CODE_USE_NATIVE_FILE_SEARCH = oldNative
    await rm(root, { recursive: true, force: true })
  }
})
