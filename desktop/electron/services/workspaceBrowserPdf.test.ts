import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { saveWorkspaceBrowserPdf } from './workspaceBrowserPdf'
import { workspaceBrowserPdfFilename } from './workspaceBrowser'

const directories: string[] = []
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cc-haha-pdf-'))
  directories.push(directory)
  return directory
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

it('preserves an existing document and reports the actual collision-safe path', async () => {
  const directory = await fixture()
  const original = path.join(directory, 'Quarterly-Report.pdf')
  await writeFile(original, 'original user document')
  const saved = await saveWorkspaceBrowserPdf(new Uint8Array([1, 2, 3]), async () => original)
  expect(await readFile(original, 'utf8')).toBe('original user document')
  expect(saved).toBe(path.join(directory, 'Quarterly-Report (1).pdf'))
  expect(await readFile(saved!)).toEqual(Buffer.from([1, 2, 3]))
})

it('reserves concurrent same-title exports atomically, including colliding sanitized titles', async () => {
  const directory = await fixture()
  const titles = ['Quarterly Report', 'Quarterly/Report', '中文', '日本語', '中文']
  const paths = await Promise.all(titles.map((title, index) => saveWorkspaceBrowserPdf(
    new Uint8Array([index]),
    async () => path.join(directory, workspaceBrowserPdfFilename('https://example.test/', title)),
  )))
  expect(new Set(paths).size).toBe(titles.length)
  for (const [index, saved] of paths.entries()) expect(await readFile(saved!)).toEqual(Buffer.from([index]))
})

it('writes nothing when saving is cancelled', async () => {
  const directory = await fixture()
  expect(await saveWorkspaceBrowserPdf(new Uint8Array([1]), async () => null)).toBeNull()
  expect(await readdir(directory)).toEqual([])
})
