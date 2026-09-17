import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

if (process.platform !== 'win32') {
  console.log('SKIPPED: M2 native fixture targets Windows 10/11 only')
  process.exit(0)
}
const desktop = path.resolve(import.meta.dir, '..')
const source = path.join(import.meta.dir, 'fixtures', 'managed-resources-ui')
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-m2-native-'))
const output = path.resolve(process.argv[2] ?? path.join(desktop, '..', 'runtime', 'agent-supervision', 'managed-resources', 'remediations', 'm2-rework-20260912', 'native-evidence'))
let result = 1
try {
  await build({
    configFile: false, root: source, base: './', plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': path.join(desktop, 'src') } },
    build: { outDir: path.join(sandbox, 'ui'), emptyOutDir: false, target: 'es2021', chunkSizeWarningLimit: 3000 },
  })
  for (const file of ['main', 'preload']) {
    const built = await Bun.build({ entrypoints: [path.join(source, file + '.ts')], target: 'node', format: 'cjs', naming: file + '.cjs', outdir: sandbox, external: ['electron', 'node-pty'] })
    if (!built.success) throw new Error('Native fixture bundle failed: ' + file)
  }
  for (const directory of ['roaming', 'local', 'temp']) await fs.mkdir(path.join(sandbox, directory), { recursive: true })
  const env = { ...process.env, M2_SMOKE_SANDBOX: sandbox, M2_SMOKE_OUTPUT: output, NODE_PATH: path.join(desktop, 'node_modules'), HOME: sandbox, USERPROFILE: sandbox, APPDATA: path.join(sandbox, 'roaming'), LOCALAPPDATA: path.join(sandbox, 'local'), TEMP: path.join(sandbox, 'temp'), TMP: path.join(sandbox, 'temp'), CLAUDE_CONFIG_DIR: path.join(sandbox, 'config') }
  delete env.ELECTRON_RUN_AS_NODE
  const processHandle = Bun.spawn([path.join(desktop, 'node_modules', 'electron', 'dist', 'electron.exe'), path.join(sandbox, 'main.cjs')], { cwd: desktop, env, stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => {
    // Stop only this fixture's process tree, including a startup-error dialog.
    Bun.spawn(['taskkill', '/PID', String(processHandle.pid), '/T', '/F'], { stdout: 'ignore', stderr: 'ignore' })
  }, 175_000)
  const [code, stdout, stderr] = await Promise.all([processHandle.exited, new Response(processHandle.stdout).text(), new Response(processHandle.stderr).text()])
  clearTimeout(timer)
  await fs.mkdir(output, { recursive: true })
  await fs.writeFile(path.join(output, 'process.log'), stdout + stderr)
  if (code !== 0 && !(await fs.stat(path.join(output, 'result.json')).catch(() => null))) {
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'failed', stage: 'electron startup or timeout', exitCode: code, testedAt: new Date().toISOString() }, null, 2) + '\n')
  }
  console.log(stdout.trim())
  if (code !== 0) console.error(stderr.slice(-5000))
  result = code
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
} finally {
  // Only this run's uniquely-created sandbox is ever removed.
  await fs.rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
}
process.exit(result)
