import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isCompiledImageProcessorUrl } from './imageProcessor'

const originalExecutable = process.execPath
const originalEmbeddedFiles = Bun.embeddedFiles
const directories: string[] = []

afterEach(async () => {
  Object.defineProperty(process, 'execPath', { value: originalExecutable })
  Bun.embeddedFiles = originalEmbeddedFiles
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('image processor module loading', () => {
  test.each([
    ['file:///B:/%7EBUN/root/claude-sidecar.exe', true],
    ['file:///B:/%7eBUN/root/claude-sidecar.exe', true],
    ['file:///B:/~BUN/root/claude-sidecar.exe', true],
    ['file:///$bunfs/root/claude-sidecar', true],
    ['file:///%24bunfs/root/claude-sidecar', true],
    ['file:///D:/中文%20项目/src/tools/FileReadTool/imageProcessor.ts', false],
    ['file:///home/user/project/src/tools/FileReadTool/imageProcessor.ts', false],
    ['file:///D:/project/~BUN-tools/imageProcessor.ts', false],
  ])('detects compiled image module URL %s as %s', (moduleUrl, expected) => {
    expect(isCompiledImageProcessorUrl(moduleUrl)).toBe(expected)
  })

  test('processes and creates images with the source-install sharp dependency', async () => {
    const sourceModule = './imageProcessor.js?source-test'
    const { getImageCreator, getImageProcessor } = await import(sourceModule)
    const creator = await getImageCreator()
    const processor = await getImageProcessor()
    const buffer = await creator({ create: {
      width: 4, height: 3, channels: 3, background: { r: 20, g: 40, b: 60 },
    } }).png().toBuffer()
    expect(await processor(buffer).metadata()).toMatchObject({ width: 4, height: 3, format: 'png' })
    expect(await getImageCreator()).toBe(creator)
    expect(await getImageProcessor()).toBe(processor)
  })

  test('loads both bundled image APIs from the executable installation instead of the project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-haha-image-module-'))
    directories.push(root)
    const moduleDirectory = join(root, 'app.asar.unpacked', 'node_modules', 'sharp')
    const executable = join(root, 'app.asar.unpacked', 'src-tauri', 'binaries', 'claude-sidecar')
    await mkdir(moduleDirectory, { recursive: true })
    await mkdir(join(root, 'app.asar.unpacked', 'src-tauri', 'binaries'), { recursive: true })
    await writeFile(join(moduleDirectory, 'package.json'), JSON.stringify({ name: 'sharp', main: 'index.cjs' }))
    await writeFile(join(moduleDirectory, 'index.cjs'), "module.exports = () => 'packaged-sharp-fixture'\n")
    Object.defineProperty(process, 'execPath', { value: executable })
    Bun.embeddedFiles = [new Blob(['compiled fixture'])] as typeof Bun.embeddedFiles

    const bundledModule = './imageProcessor.js?bundled-test'
    const { getImageCreator, getImageProcessor } = await import(bundledModule)
    const processor = await getImageProcessor()
    const creator = await getImageCreator()
    expect(processor(Buffer.alloc(0))).toBe('packaged-sharp-fixture')
    expect(creator({ create: {
      width: 1, height: 1, channels: 3, background: { r: 0, g: 0, b: 0 },
    } })).toBe('packaged-sharp-fixture')
  })
})
