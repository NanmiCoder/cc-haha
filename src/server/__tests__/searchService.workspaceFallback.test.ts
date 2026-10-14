import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { SearchService } from '../services/searchService.js'

let workDir: string | null = null

afterEach(async () => {
  if (workDir) await fs.rm(workDir, { recursive: true, force: true })
  workDir = null
})

describe('SearchService.searchWorkspace without ripgrep', () => {
  it.skipIf(process.platform === 'win32')('looks up grep and finds matches with it', async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-search-fallback-'))
    await fs.writeFile(path.join(workDir, 'notes.txt'), 'first line\nneedle-1489 here\n')
    const service = new SearchService({
      resolveRipgrepCommand: () => ({ rgPath: '', rgArgs: [] }),
    })

    const results = await service.searchWorkspace('needle-1489', { cwd: workDir })

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ line: 2, text: 'needle-1489 here' })
    expect(results[0]?.file).toContain('notes.txt')
  })
})
