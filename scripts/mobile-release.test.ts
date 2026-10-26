import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { buildMessage, deliverBuild, EAS_CLI_VERSION, findReusableBuild, fingerprintInputs, isBuildInput, parseDelivery, planDelivery, selectReusableBuild, submissionAlreadyFinished, type Delivery } from './mobile-release'

const commit = 'a'.repeat(40)
const fingerprint = 'b'.repeat(64)
const buildId = '12345678-1234-1234-1234-123456789abc'
const delivery: Delivery = { schemaVersion: 1, platform: 'ios', tag: 'v1.2.0', commit, fingerprint, version: '0.1.0', buildId, destination: 'app-store-connect', deliveredAt: '2026-10-25T12:00:00Z' }
const input = { platform: 'ios' as const, tag: 'v1.3.0', commit: 'c'.repeat(40), fingerprint, version: '0.1.0', deliveries: [delivery] }

describe('mobile release planning', () => {
  test('desktop-only shared changes skip mobile while transitive runtime dependencies require a release', () => {
    const sources: Record<string, string> = {
      'mobile/src/app/index.tsx': 'export { value } from "../../../src/shared/mobileEntry"',
      'mobile/src/app/index.test.ts': 'import "../../../src/shared/desktopOnly"',
      'src/shared/mobileEntry.ts': 'export { value } from "./nested/value.js"',
      'src/shared/nested/value.ts': 'export const value = 1',
      'src/shared/desktopOnly.ts': 'export const timeout = 5',
    }
    const tree = ['mobile/app.json', ...Object.keys(sources)].map(path => `100644 blob ${commit}\t${path}\0`).join('')
    const context = { platform: 'ios' as const, projectId: buildId, owner: 'test', packageManager: 'bun@1.4.3' }
    const readSource = (path: string) => sources[path]!
    const before = fingerprintInputs(tree, context, readSource)
    const changed = (path: string) => tree.replace(`${commit}\t${path}\0`, `${'d'.repeat(40)}\t${path}\0`)
    const desktopOnly = fingerprintInputs(changed('src/shared/desktopOnly.ts'), context, readSource)
    expect(desktopOnly).toBe(before)
    expect(planDelivery({ ...input, fingerprint: desktopOnly, deliveries: [{ ...delivery, fingerprint: before }] }).build).toBe(false)
    const mobile = fingerprintInputs(changed('src/shared/nested/value.ts'), context, readSource)
    expect(mobile).not.toBe(before)
    expect(() => planDelivery({ ...input, fingerprint: mobile, deliveries: [{ ...delivery, fingerprint: before }] })).toThrow('version bump')
    expect(planDelivery({ ...input, fingerprint: mobile, version: '0.1.1', deliveries: [{ ...delivery, fingerprint: before }] }).build).toBe(true)
  })
  test('shared dependencies include require, dynamic imports, native indexes and assets but ignore type-only imports', () => {
    const sources: Record<string, string> = {
      'mobile/src/entry.ts': 'import type { Settings } from "../../src/shared/types"; export const load = () => import("../../src/shared/feature")',
      'src/shared/feature/index.ts': 'export const value = require("../data.json")',
      'src/shared/feature/index.ios.ts': 'export const value = require("../ios-data.json")',
      'src/shared/feature/index.native.ts': 'export { load } from "../../../mobile/src/entry"',
      'src/shared/data.json': '{}',
      'src/shared/ios-data.json': '{}',
      'src/shared/types.ts': 'export type Settings = string',
    }
    const tree = ['mobile/app.json', ...Object.keys(sources)].map(path => `100644 blob ${commit}\t${path}\0`).join('')
    const context = { platform: 'ios' as const, projectId: buildId, owner: 'test', packageManager: 'bun@1.4.3' }
    const readSource = (path: string) => sources[path]!
    const before = fingerprintInputs(tree, context, readSource)
    for (const path of Object.keys(sources).filter(path => path !== 'src/shared/types.ts')) {
      const changed = tree.replace(`${commit}\t${path}\0`, `${'d'.repeat(40)}\t${path}\0`)
      expect(fingerprintInputs(changed, context, readSource)).not.toBe(before)
    }
    expect(fingerprintInputs(tree.replace(`${commit}\tsrc/shared/types.ts`, `${'d'.repeat(40)}\tsrc/shared/types.ts`), context, readSource)).toBe(before)
    expect(() => fingerprintInputs(tree, context, path => path === 'mobile/src/entry.ts' ? 'import "../../src/shared/missing"' : readSource(path))).toThrow('Cannot resolve mobile build dependency')
  })
  test('desktop-only release skips mobile, using last successful delivery rather than previous desktop tag', () => {
    expect(planDelivery(input)).toMatchObject({ build: false, previous: delivery })
  })
  test('first platform delivery builds, including when the other platform already succeeded', () => {
    expect(planDelivery({ ...input, platform: 'android' })).toMatchObject({ build: true })
    expect(planDelivery({ ...input, deliveries: [] })).toMatchObject({ build: true })
  })
  test('failed release without success manifest does not advance baseline', () => {
    expect(planDelivery({ ...input, tag: 'v1.4.0', fingerprint: 'd'.repeat(64), version: '0.2.0' })).toMatchObject({ build: true, previous: delivery })
  })
  test('retry of successful platform is idempotent and changed delivered tags are rejected', () => {
    expect(planDelivery({ ...input, tag: delivery.tag, commit })).toMatchObject({ build: false })
    expect(() => planDelivery({ ...input, tag: delivery.tag })).toThrow('different mobile inputs')
  })
  test('unchanged marketing version with new inputs and rollback both fail before spending quota', () => {
    expect(() => planDelivery({ ...input, fingerprint: 'd'.repeat(64) })).toThrow('version bump')
    expect(() => planDelivery({ ...input, version: '0.0.9' })).toThrow('older mobile version')
  })
  test('manifest reader rejects unknown schema, malformed records and missing APK integrity metadata', () => {
    expect(parseDelivery(delivery)).toEqual(delivery)
    expect(() => parseDelivery({ ...delivery, schemaVersion: 2 })).toThrow('Unsupported')
    expect(() => parseDelivery({ ...delivery, commit: 'main' })).toThrow('Invalid')
    expect(() => parseDelivery({ ...delivery, platform: 'android', destination: 'github-release' })).toThrow('Invalid')
  })
  test('fingerprint includes mobile production inputs and build context, excludes desktop, tests and credentials', () => {
    const context = { platform: 'ios' as const, projectId: buildId, owner: 'test', packageManager: 'bun@1.4.3' }
    const base = `100644 blob ${commit}\tmobile/app.json\0`
    const hash = fingerprintInputs(base, context, () => '')
    for (const path of ['desktop/src/App.tsx', 'mobile/src/core/example.test.ts', 'mobile/README.md', 'mobile/scripts/fixture-server.ts', 'mobile/.env', 'mobile/credentials.json', 'mobile/android/build.gradle']) {
      expect(isBuildInput(path)).toBe(false)
      expect(fingerprintInputs(`${base}100644 blob ${commit}\t${path}\0`, context, () => '')).toBe(hash)
    }
    for (const path of ['mobile/src/app/index.tsx', 'mobile/plugins/withPinnedWebSockets.js', 'mobile/bun.lock', 'mobile/eas.json']) {
      expect(isBuildInput(path)).toBe(true)
      expect(fingerprintInputs(`${base}100644 blob ${commit}\t${path}\0`, context, () => '')).not.toBe(hash)
    }
    expect(fingerprintInputs(base, { ...context, platform: 'android' }, () => '')).not.toBe(hash)
  })
})

describe('mobile delivery outcomes', () => {
  const build = { id: buildId, status: 'FINISHED', platform: 'IOS', gitCommitHash: commit, appVersion: '0.1.0', message: buildMessage('ios', fingerprint), buildProfile: 'production', distribution: 'STORE' }
  test('reuses only exact successful build and refuses duplicates while still running', () => {
    const expected = { ...input, commit }
    expect(selectReusableBuild([build], expected)).toEqual(build)
    expect(selectReusableBuild([{ ...build, gitCommitHash: 'd'.repeat(40) }], expected)).toBeUndefined()
    expect(selectReusableBuild([{ ...build, message: 'manual production build' }], expected)).toBeUndefined()
    expect(selectReusableBuild([{ ...build, isForIosSimulator: true }], expected)).toBeUndefined()
    expect(() => selectReusableBuild([{ ...build, status: 'IN_PROGRESS' }], expected)).toThrow('still running')
    expect(selectReusableBuild([{ ...build, status: 'ERRORED' }], expected)).toBeUndefined()
  })
  test('retry recovers a completed submission only for the exact build and App Store app', () => {
    const uploaded = { status: 'FINISHED', submittedBuild: { id: buildId }, iosConfig: { ascAppIdentifier: '1234' } }
    expect(submissionAlreadyFinished([uploaded], buildId, '1234')).toBe(true)
    expect(submissionAlreadyFinished([uploaded], buildId, '5678')).toBe(false)
    expect(() => submissionAlreadyFinished([{ ...uploaded, status: 'IN_PROGRESS' }], buildId, '1234')).toThrow('active submission')
    expect(submissionAlreadyFinished([{ ...uploaded, status: 'ERRORED' }], buildId, '1234')).toBe(false)
  })
  test('retry reuses a matching finished build hidden by a full page of newer attempts', async () => {
    const pagesRead: number[] = []
    const newerBuilds = Array.from({ length: 50 }, () => ({ ...build, message: buildMessage('ios', 'e'.repeat(64)) }))
    const reusable = await findReusableBuild({ ...input, commit }, async (offset, limit) => {
      expect(limit).toBe(50)
      pagesRead.push(offset)
      return offset === 0 ? newerBuilds : [build]
    })
    expect(pagesRead).toEqual([0, 50])
    expect(reusable).toEqual(build)
  })
  test('a matching running build on a later page still prevents a duplicate build', async () => {
    const pagesRead: number[] = []
    const newerBuilds = Array.from({ length: 50 }, () => ({ ...build, message: 'another release fingerprint' }))
    await expect(findReusableBuild({ ...input, commit }, async offset => {
      pagesRead.push(offset)
      return offset === 0 ? newerBuilds : [{ ...build, status: 'IN_PROGRESS' }]
    })).rejects.toThrow('still running')
    expect(pagesRead).toEqual([0, 50])
  })
  test('successful upload records exact iOS build only after submission finishes', async () => {
    const calls: string[] = []
    await deliverBuild('ios', build, { submit: async id => { calls.push(`submit:${id}`) }, uploadApk: async () => { throw new Error('wrong platform') }, record: async details => { calls.push(`record:${details.buildId}`) } })
    expect(calls).toEqual([`submit:${buildId}`, `record:${buildId}`])
  })
  test('failed submission or APK upload never records success', async () => {
    for (const platform of ['ios', 'android'] as const) {
      let recorded = false
      await expect(deliverBuild(platform, { ...build, platform: platform.toUpperCase() }, {
        submit: async () => { throw new Error('upload failed') },
        uploadApk: async () => { throw new Error('upload failed') },
        record: async () => { recorded = true },
      })).rejects.toThrow('upload failed')
      expect(recorded).toBe(false)
    }
  })
  test('Android attaches APK and checksum without submitting to a store', async () => {
    const calls: string[] = []
    await deliverBuild('android', { ...build, platform: 'ANDROID' }, {
      submit: async () => { throw new Error('must not submit Android') },
      uploadApk: async () => { calls.push('apk'); return { asset: 'cc-haha-mobile-test.apk', sha256: fingerprint } },
      record: async item => { expect(item.sha256).toBe(fingerprint); calls.push('record') },
    })
    expect(calls).toEqual(['apk', 'record'])
  })
})

describe('release workflow wiring', () => {
  test('desktop explicitly calls mobile only after publishing, gated by onboarding readiness', () => {
    const workflow = parse(readFileSync('.github/workflows/release-desktop.yml', 'utf8'))
    expect(workflow.jobs['release-mobile'].needs).toBe('publish-release')
    expect(workflow.jobs['release-mobile'].uses).toBe('./.github/workflows/release-mobile.yml')
    expect(workflow.jobs['release-mobile'].if).toContain("vars.MOBILE_RELEASE_ENABLED == 'true'")
    expect(workflow.jobs['release-mobile'].if).toContain('inputs.draft == false')
  })
  test('manual retry requires a tag, defaults read-only, checks out that tag and preserves platform failure', () => {
    const workflow = parse(readFileSync('.github/workflows/release-mobile.yml', 'utf8'))
    expect(workflow.on.release).toBeUndefined()
    expect(workflow.on.workflow_dispatch.inputs.release_tag.required).toBe(true)
    expect(workflow.on.workflow_dispatch.inputs.dry_run.default).toBe(true)
    expect(workflow.jobs.deliver.strategy['fail-fast']).toBe(false)
    expect(workflow.jobs.deliver.steps[0].with.ref).toBe('refs/tags/${{ inputs.release_tag }}')
    expect(workflow.concurrency['cancel-in-progress']).toBe(false)
    expect(EAS_CLI_VERSION).toBe('25.3.0')
  })
})

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

test('real runner dry-run never builds or mutates EAS config; draft releases fail closed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mobile-release-test-'))
  dirs.push(root)
  for (const dir of ['scripts/pr', 'mobile', 'bin', 'home']) mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, 'scripts/pr/module-graph.ts'), readFileSync('scripts/pr/module-graph.ts'))
  writeFileSync(join(root, 'scripts/mobile-release.ts'), readFileSync('scripts/mobile-release.ts'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ packageManager: 'bun@1.4.3' }))
  writeFileSync(join(root, 'mobile/package.json'), JSON.stringify({ version: '0.1.0' }))
  writeFileSync(join(root, 'mobile/app.json'), JSON.stringify({ expo: { version: '0.1.0' } }))
  writeFileSync(join(root, 'mobile/eas.json'), '{}')
  writeFileSync(join(root, 'bin/gh'), `#!/usr/bin/env bun\nconst args=process.argv.slice(2);\nif(args.some(a=>a.includes('/releases/tags/'))) console.log(JSON.stringify({id:1,tag_name:'v1.0.0',draft:process.env.FIXTURE_DRAFT==='true',prerelease:false,assets:[]}));\nelse if(args.includes('--paginate')) console.log('[[]]');\nelse throw new Error('unexpected mutation');\n`, { mode: 0o755 })
  writeFileSync(join(root, 'bin/bunx'), '#!/usr/bin/env bun\nthrow new Error("EAS must not run during dry-run")\n', { mode: 0o755 })
  const env = { PATH: `${join(root, 'bin')}:${process.env.PATH}`, HOME: join(root, 'home'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', EXPO_PROJECT_ID: buildId, EXPO_OWNER: 'fixture', ASC_APP_ID: '123456789', GITHUB_REPOSITORY: 'fixture/repo', MOBILE_RELEASE_TAG: 'v1.0.0', MOBILE_RELEASE_PLATFORM: 'ios' }
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'], ['-c', 'tag.gpgsign=false', 'tag', 'v1.0.0']]) {
    const result = Bun.spawnSync(['git', ...args], { cwd: root, env })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
  }
  const success = Bun.spawnSync([process.execPath, '--no-env-file', 'scripts/mobile-release.ts', '--dry-run'], { cwd: root, env })
  expect(success.exitCode, success.stderr.toString()).toBe(0)
  expect(success.stdout.toString()).toContain('First mobile delivery')
  expect(readFileSync(join(root, 'mobile/eas.json'), 'utf8')).toBe('{}')
  const draft = Bun.spawnSync([process.execPath, '--no-env-file', 'scripts/mobile-release.ts', '--dry-run'], { cwd: root, env: { ...env, FIXTURE_DRAFT: 'true' } })
  expect(draft.exitCode).toBe(1)
  expect(draft.stderr.toString()).toContain('published stable')
  const unsafe = Bun.spawnSync([process.execPath, '--no-env-file', 'scripts/mobile-release.ts'], { cwd: root, env })
  expect(unsafe.exitCode).toBe(1)
  expect(unsafe.stderr.toString()).toContain('only in GitHub Actions')
})
