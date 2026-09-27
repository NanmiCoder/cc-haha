import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadAgentFromFile } from './loadPluginAgents.js'

test('plugin agent source identity hashes the exact file that produced its compiled prompt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-agent-source-'))
  const file = join(root, 'worker.md')
  const content = '---\nname: worker\ndescription: Fixture worker\n---\nRead the fixture only.\n'
  try {
    await writeFile(file, content)
    const agent = await loadAgentFromFile(file, 'fixture', [], 'fixture@local', root, { name: 'fixture' }, new Set())
    expect(agent).toMatchObject({ agentType: 'fixture:worker', source: 'plugin', rawSystemPrompt: 'Read the fixture only.', sourceFilePath: file, sourceContentHash: createHash('sha256').update(content).digest('hex') })
    expect(agent?.getSystemPrompt({ toolUseContext: { options: {} } } as never)).toContain('Read the fixture only.')
  } finally { await rm(root, { recursive: true, force: true }) }
})
