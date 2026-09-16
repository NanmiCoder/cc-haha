import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDF_MAX_PAGES_PER_READ } from '../../constants/apiLimits.js'
import type { ToolUseContext } from '../../Tool.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { FileReadTool, readImageWithTokenBudget } from './FileReadTool.js'
import { getImageCreator, getImageProcessor } from './imageProcessor.js'
import * as imageResizer from '../../utils/imageResizer.js'

function makeToolUseContext(): ToolUseContext {
  return {
    readFileState: new Map(),
    abortController: new AbortController(),
    getAppState: () => ({
      toolPermissionContext: getEmptyToolPermissionContext(),
    }),
  } as unknown as ToolUseContext
}

const temporaryDirectories: string[] = []

test('uses the shared image processor for the final image compression fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-haha-read-image-fallback-'))
  temporaryDirectories.push(root)
  const filePath = join(root, 'fixture.png')
  const creator = await getImageCreator()
  const processor = await getImageProcessor()
  const image = await creator({ create: {
    width: 4, height: 3, channels: 3, background: { r: 20, g: 40, b: 60 },
  } }).png().toBuffer()
  await writeFile(filePath, image)
  const resize = spyOn(imageResizer, 'maybeResizeAndDownsampleImageBuffer').mockResolvedValue({
    buffer: image, mediaType: 'png', dimensions: { originalWidth: 1000, originalHeight: 1000, displayWidth: 1000, displayHeight: 1000 },
  })
  const downsample = spyOn(imageResizer, 'downsampleImageBufferToVisionTokenBudget')
    .mockRejectedValue(new Error('fixture downsample failure'))
  const compress = spyOn(imageResizer, 'compressImageBufferWithTokenLimit')
    .mockRejectedValue(new Error('fixture compression failure'))
  try {
    const result = await readImageWithTokenBudget(filePath, 1)
    expect(downsample).toHaveBeenCalledTimes(1)
    expect(compress).toHaveBeenCalledTimes(1)
    expect(result.file.type).toBe('image/jpeg')
    expect(await processor(Buffer.from(result.file.base64, 'base64')).metadata())
      .toMatchObject({ width: 4, height: 3, format: 'jpeg' })
  } finally {
    resize.mockRestore()
    downsample.mockRestore()
    compress.mockRestore()
  }
})

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(path =>
      rm(path, { recursive: true, force: true }),
    ),
  )
})

describe('FileReadTool pages validation', () => {
  test('ignores invalid PDF pages values for non-PDF files', async () => {
    const context = makeToolUseContext()

    await expect(
      FileReadTool.validateInput(
        { file_path: '/tmp/screenshot.png', pages: '0' },
        context,
      ),
    ).resolves.toEqual({ result: true })

    await expect(
      FileReadTool.validateInput(
        { file_path: '/tmp/example.ts', pages: '' },
        context,
      ),
    ).resolves.toEqual({ result: true })

    await expect(
      FileReadTool.validateInput(
        { file_path: 'C:\\tmp\\SCREENSHOT.PNG', pages: '0' },
        context,
      ),
    ).resolves.toEqual({ result: true })
  })

  test('keeps PDF pages validation strict', async () => {
    const context = makeToolUseContext()

    await expect(
      FileReadTool.validateInput(
        { file_path: '/tmp/document.pdf', pages: '0' },
        context,
      ),
    ).resolves.toMatchObject({
      result: false,
      errorCode: 7,
    })

    await expect(
      FileReadTool.validateInput(
        {
          file_path: '/tmp/document.pdf',
          pages: `1-${PDF_MAX_PAGES_PER_READ + 1}`,
        },
        context,
      ),
    ).resolves.toMatchObject({
      result: false,
      errorCode: 8,
    })
  })
})

describe('FileReadTool Windows text fidelity', () => {
  test('preserves Unicode paths and literal tabs in model-facing output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-haha-read-'))
    temporaryDirectories.push(root)
    const directory = join(root, '中文目录')
    const filePath = join(directory, 'Tab 样例.txt')
    const content = '\t\t中文目标\n    空格目标\n'
    await mkdir(directory)
    await writeFile(filePath, content, 'utf8')

    const result = await FileReadTool.call(
      { file_path: filePath },
      makeToolUseContext(),
    )

    expect(result.data.type).toBe('text')
    if (result.data.type !== 'text') return
    expect(result.data.file.filePath).toBe(filePath)
    expect(result.data.file.content).toContain('\t\t中文目标')

    const block = FileReadTool.mapToolResultToToolResultBlockParam(
      result.data,
      'read-tabs',
    )
    expect(block.content).toContain('1\t\t\t中文目标')
  })
})
