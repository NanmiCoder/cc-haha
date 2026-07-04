import { describe, expect, test } from 'bun:test'

async function runIsolated(script: string) {
  const proc = Bun.spawn(['bun', '-e', script], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

describe('getImageProcessor', () => {
  test('does not fall back to external sharp in bundled mode when native processor is unavailable', async () => {
    const result = await runIsolated(String.raw`
      import { mock } from 'bun:test'

      let sharpImportAttempted = false

      mock.module('./src/utils/bundledMode.js', () => ({
        isInBundledMode: () => true,
        isRunningWithBun: () => true,
      }))

      mock.module('image-processor-napi', () => {
        throw new Error('native module missing')
      })

      mock.module('sharp', () => {
        sharpImportAttempted = true
        return {
          default: () => ({
            metadata: async () => ({ width: 1, height: 1, format: 'png' }),
            resize() { return this },
            jpeg() { return this },
            png() { return this },
            webp() { return this },
            toBuffer: async () => Buffer.from('sharp'),
          }),
        }
      })

      const modulePath = './src/tools/FileReadTool/' + 'imageProcessor.js'
      const { getImageProcessor, resetImageProcessorForTests } = await import(modulePath)
      resetImageProcessorForTests()

      try {
        await getImageProcessor()
        throw new Error('expected getImageProcessor to reject')
      } catch (error) {
        if (!String(error?.message ?? error).includes('Native image processor module not available in bundled mode')) {
          throw error
        }
      }

      if (sharpImportAttempted) {
        throw new Error('sharp import was attempted')
      }
    `)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
  })
})
