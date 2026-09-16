// @vitest-environment node

import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createPackageWithOptions } from '@electron/asar'
import { expect, it } from 'vitest'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment'

const desktopRoot = path.resolve(import.meta.dirname, '..')
const repoRoot = path.resolve(desktopRoot, '..')
const desktopRequire = createRequire(path.join(desktopRoot, 'package.json'))

async function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  if (code !== 0) throw new Error(`${command} exited ${code}: ${stderr}\n${stdout}`)
  return stdout
}

it.each([false, true])('creates and resizes packaged images from a user project (embedded assets: %s)', async embeddedAssets => {
  const root = await mkdtemp(path.join(tmpdir(), 'cc-haha-packaged-images-'))
  try {
    const appDirectory = path.join(root, 'app')
    const resources = path.join(root, '中文 安装目录', 'resources')
    const binaryName = process.platform === 'win32' ? 'claude-sidecar.exe' : 'claude-sidecar'
    const relativeBinary = path.join('src-tauri', 'binaries', binaryName)
    const buildBinary = path.join(appDirectory, relativeBinary)
    const project = path.join(root, '中文 用户项目')
    const env = createSandboxedTestEnvironment(path.join(root, 'home'))
    await Promise.all([
      mkdir(path.dirname(buildBinary), { recursive: true }),
      mkdir(resources, { recursive: true }),
      mkdir(project, { recursive: true }),
    ])

    // Stage the installed production dependency tree; the ASAR options below
    // decide which files are available to the non-Electron Bun executable.
    for (const name of ['sharp', 'detect-libc', 'semver']) {
      const packagePath = desktopRequire.resolve(`${name}/package.json`)
      await cp(path.dirname(packagePath), path.join(appDirectory, 'node_modules', name), {
        recursive: true, dereference: true,
      })
    }
    const sharpPackagePath = desktopRequire.resolve('sharp/package.json')
    await cp(path.resolve(sharpPackagePath, '../../@img'), path.join(appDirectory, 'node_modules', '@img'), {
      recursive: true, dereference: true,
    })
    await writeFile(path.join(appDirectory, 'package.json'), '{"name":"packaged-image-fixture"}')

    const marker = path.join(root, 'embedded.txt')
    await writeFile(marker, 'compiled-sidecar-resource')
    const entry = path.join(root, 'image-smoke.ts')
    const processorSource = path.join(repoRoot, 'src/tools/FileReadTool/imageProcessor.ts')
    await writeFile(entry, `
${embeddedAssets ? `import resource from ${JSON.stringify(marker)} with { type: 'file' }` : ''}
import { getImageCreator, getImageProcessor } from ${JSON.stringify(processorSource)}
${embeddedAssets ? "if (await Bun.file(resource).text() !== 'compiled-sidecar-resource') throw new Error('missing embedded resource')" : ''}
const create = await getImageCreator()
const processImage = await getImageProcessor()
const original = await create({ create: { width: 12, height: 8, channels: 3, background: { r: 20, g: 40, b: 60 } } }).png().toBuffer()
const resized = await processImage(original).resize(3, 2).jpeg({ quality: 80 }).toBuffer()
const metadata = await processImage(resized).metadata()
console.log(JSON.stringify({ width: metadata.width, height: metadata.height, format: metadata.format }))
`)
    await run('bun', ['build', '--compile', '--compile-autoload-package-json', '--compile-autoload-tsconfig', '--external', 'sharp', '--external', 'image-processor-napi', entry, '--outfile', buildBinary], root, env)
    if (process.platform === 'darwin') {
      // Match build-sidecars.ts: remove Bun's incomplete signature before signing.
      await run('codesign', ['--remove-signature', buildBinary], root, env)
      await run('codesign', ['--sign', '-', '--force', buildBinary], root, env)
    }

    const packageJson = JSON.parse(await readFile(path.join(desktopRoot, 'package.json'), 'utf8')) as {
      build: { asarUnpack: string[] }
    }
    const archive = path.join(resources, 'app.asar')
    await createPackageWithOptions(appDirectory, archive, {
      unpackDir: `{${packageJson.build.asarUnpack.map(pattern => pattern.replace(/\/\*\*$/, '')).join(',')}}`,
    })
    expect(JSON.parse(await readFile(path.join(`${archive}.unpacked`, 'node_modules/sharp/package.json'), 'utf8')).name).toBe('sharp')
    expect((await readFile(path.join(`${archive}.unpacked`, 'node_modules/sharp/lib/index.js'), 'utf8')).length).toBeGreaterThan(0)
    // Remove staging so a missing packaged dependency cannot fall back to it.
    await rm(appDirectory, { recursive: true, force: true })
    const executable = path.join(`${archive}.unpacked`, relativeBinary)
    const result = await run(executable, [], project, env)
    expect(JSON.parse(result.trim())).toEqual({ width: 3, height: 2, format: 'jpeg' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
