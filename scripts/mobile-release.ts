#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveSpecifier } from './pr/module-graph'

export const EAS_CLI_VERSION = '25.3.0'
export type Platform = 'ios' | 'android'
export type Delivery = {
  schemaVersion: 1
  platform: Platform
  tag: string
  commit: string
  fingerprint: string
  version: string
  buildId: string
  deliveredAt: string
  destination: 'app-store-connect' | 'github-release'
  asset?: string
  sha256?: string
}
type Release = { id: number, tag_name: string, draft: boolean, prerelease: boolean, assets: { id: number, name: string }[] }
type Build = { id: string, status: string, platform: string, gitCommitHash: string, message?: string, appVersion: string, buildProfile: string, distribution: string, isForIosSimulator?: boolean, artifacts?: { buildUrl?: string, applicationArchiveUrl?: string } }
type Submission = { status: string, submittedBuild?: { id: string }, iosConfig?: { ascAppIdentifier: string } }
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const sha = /^[a-f0-9]{40}$/
const digest = /^[a-f0-9]{64}$/

export function parseDelivery(value: unknown): Delivery {
  const item = value as Delivery
  if (!item || item.schemaVersion !== 1) throw new Error('Unsupported mobile delivery manifest schema; refusing to overwrite it')
  if (!['ios', 'android'].includes(item.platform) || !/^v\d+\.\d+\.\d+$/.test(item.tag)
    || !sha.test(item.commit) || !digest.test(item.fingerprint) || !semver.test(item.version)
    || !/^[a-f0-9-]{36}$/.test(item.buildId) || !Number.isFinite(Date.parse(item.deliveredAt))
    || item.destination !== (item.platform === 'ios' ? 'app-store-connect' : 'github-release')
    || (item.platform === 'android' && (!item.asset || !/^cc-haha-mobile-[\w.-]+\.apk$/.test(item.asset) || !digest.test(item.sha256 ?? '')))) {
    throw new Error('Invalid mobile delivery manifest')
  }
  return item
}

export function isBuildInput(path: string, dependencies: ReadonlySet<string> = new Set()) {
  if (/(^|\/)(node_modules|ios|android|\.expo|dist|artifacts)\//.test(path)) return false
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(path) || /\.(md|mdx)$/.test(path)) return false
  if (path.startsWith('mobile/scripts/') || path.includes('/__tests__/') || path.includes('/__fixtures__/')) return false
  if (/(^|\/)(credentials\.json|google-services\.json|\.env(?:\..*)?)$/.test(path) || /\.(p8|p12|mobileprovision|jks|keystore)$/.test(path)) return false
  return path.startsWith('mobile/') || dependencies.has(path)
    || path === '.github/workflows/release-mobile.yml' || path === '.gitignore' || path === '.easignore'
    || path === 'scripts/pr/module-graph.ts'
    || (path.startsWith('scripts/mobile-release') && !path.endsWith('.test.ts'))
}

/** Git tree entries hash only committed production inputs, never a developer's local credentials. */
export function fingerprintInputs(
  tree: string,
  context: { platform: Platform, projectId: string, owner: string, ascAppId?: string, packageManager: string },
  readSource: (path: string) => string,
) {
  const treeEntries = tree.split('\0').filter(Boolean)
  const entryPath = (entry: string) => entry.slice(entry.indexOf('\t') + 1)
  const files = new Set(treeEntries.map(entryPath))
  const sourceFile = (path: string) => /\.[cm]?[jt]sx?$/.test(path)
  const queue = [...files].filter(path => path.startsWith('mobile/') && isBuildInput(path))
  const dependencies = new Set(queue)
  const parsers = { ts: new Bun.Transpiler({ loader: 'ts' }), tsx: new Bun.Transpiler({ loader: 'tsx' }) }
  for (let index = 0; index < queue.length; index++) {
    const path = queue[index]!
    if (!sourceFile(path)) continue
    const parser = /\.[jt]sx$/.test(path) ? parsers.tsx : parsers.ts
    // Parse syntax without executing app/config code; type-only imports do not affect a binary.
    for (const { path: specifier } of parser.scanImports(readSource(path))) {
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue
      // Include native/platform alternatives as well as the base module. The shared
      // resolver handles .js -> .ts, directory indexes, JSON and explicit assets.
      const suffix = specifier.match(/\.[cm]?[jt]sx?$/)?.[0] ?? ''
      const stem = suffix ? specifier.slice(0, -suffix.length) : specifier
      const targets = [specifier, `${stem}.${context.platform}${suffix}`, `${stem}.native${suffix}`,
        ...(!suffix ? [`${specifier}/index.${context.platform}`, `${specifier}/index.native`] : [])]
        .map(candidate => resolveSpecifier('/', path, candidate, files))
        .filter((target): target is string => target !== null)
      if (targets.length === 0) throw new Error(`Cannot resolve mobile build dependency: ${path} -> ${specifier}`)
      for (const target of targets) {
        if (dependencies.has(target)) continue
        dependencies.add(target)
        queue.push(target)
      }
    }
  }
  const entries = treeEntries.filter(entry => isBuildInput(entryPath(entry), dependencies)).sort()
  if (!entries.some(entry => entry.endsWith('\tmobile/app.json'))) throw new Error('Mobile app configuration missing from release commit')
  return createHash('sha256').update(JSON.stringify({ entries, ...context, easCli: EAS_CLI_VERSION })).digest('hex')
}

function compareVersions(a: string, b: string) {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! - right[i]!
  return 0
}

export function planDelivery(input: { platform: Platform, tag: string, commit: string, fingerprint: string, version: string, deliveries: Delivery[] }) {
  if (!semver.test(input.version)) throw new Error('Mobile version must use x.y.z')
  const history = input.deliveries.filter(item => item.platform === input.platform)
  const current = history.find(item => item.tag === input.tag)
  if (current) {
    if (current.commit !== input.commit || current.fingerprint !== input.fingerprint) throw new Error('This release already delivered different mobile inputs; publish a new release')
    return { build: false, reason: 'This platform was already delivered for this release', previous: current }
  }
  const latest = history.sort((a, b) => Date.parse(b.deliveredAt) - Date.parse(a.deliveredAt))[0]
  if (latest && compareVersions(input.version, latest.version) < 0) throw new Error('Refusing to deliver an older mobile version')
  if (latest?.fingerprint === input.fingerprint) return { build: false, reason: `Unchanged since ${latest.tag} (mobile ${latest.version})`, previous: latest }
  if (latest && compareVersions(input.version, latest.version) === 0) throw new Error('Mobile inputs changed without a mobile version bump. Update mobile/app.json and mobile/package.json before tagging')
  return { build: true, reason: latest ? 'Mobile production inputs changed' : 'First mobile delivery', previous: latest }
}

export async function deliverBuild(platform: Platform, build: Build, effects: { submit: (id: string) => Promise<void>, uploadApk: (build: Build) => Promise<{ asset: string, sha256: string }>, record: (details: { buildId: string, asset?: string, sha256?: string }) => Promise<void> }) {
  if (build.status !== 'FINISHED' || build.platform.toLowerCase() !== platform) throw new Error('Cannot deliver an unfinished or wrong-platform build')
  if (platform === 'ios') {
    await effects.submit(build.id)
    await effects.record({ buildId: build.id })
  } else {
    const artifact = await effects.uploadApk(build)
    await effects.record({ buildId: build.id, ...artifact })
  }
}

export function buildMessage(platform: Platform, fingerprint: string) {
  return `cc-haha-release:${platform}:${fingerprint}`
}

export function selectReusableBuild(builds: Build[], input: { platform: Platform, commit: string, fingerprint: string, version: string }) {
  const matching = builds.filter(build => build.platform.toLowerCase() === input.platform && build.gitCommitHash === input.commit
    && build.appVersion === input.version && build.message === buildMessage(input.platform, input.fingerprint)
    && build.buildProfile === 'production' && build.distribution === 'STORE' && !build.isForIosSimulator)
  const finished = matching.find(build => build.status === 'FINISHED')
  if (finished) return finished
  if (matching.some(build => !['ERRORED', 'CANCELED'].includes(build.status))) throw new Error('An identical EAS build is still running. Retry after it completes; no duplicate build was started')
  return undefined
}

export async function findReusableBuild(
  input: { platform: Platform, commit: string, fingerprint: string, version: string },
  readPage: (offset: number, limit: number) => Promise<Build[]>,
) {
  const builds: Build[] = []
  const limit = 50
  for (let offset = 0; ; offset += limit) {
    const page = await readPage(offset, limit)
    if (!Array.isArray(page)) throw new Error('Unexpected EAS build list response')
    builds.push(...page)
    if (page.length < limit) break
  }
  // Inspect the entire history before deciding to spend quota: a successful or
  // running retry may be older than the first page of builds for this commit.
  return selectReusableBuild(builds, input)
}

export function submissionAlreadyFinished(submissions: Submission[], buildId: string, ascAppId: string) {
  const matching = submissions.filter(item => item.submittedBuild?.id === buildId && item.iosConfig?.ascAppIdentifier === ascAppId)
  if (matching.some(item => item.status === 'FINISHED')) return true
  if (matching.some(item => !['ERRORED', 'CANCELED'].includes(item.status))) throw new Error('This iOS build has an active submission; retry after it completes')
  return false
}

async function command(args: string[], cwd: string, stream = false) {
  const child = Bun.spawn(args, { cwd, stdout: stream ? 'inherit' : 'pipe', stderr: 'inherit', env: { ...process.env, CI: '1', EXPO_NO_DOTENV: '1' } })
  const output = stream ? '' : await new Response(child.stdout).text()
  if (await child.exited !== 0) throw new Error(`${args[0]} ${args[1]} failed`)
  return output.trim()
}

async function main() {
  const root = resolve(import.meta.dir, '..')
  const mobile = resolve(root, 'mobile')
  const tag = process.env.MOBILE_RELEASE_TAG ?? ''
  const platform = process.env.MOBILE_RELEASE_PLATFORM as Platform
  const repo = process.env.GITHUB_REPOSITORY ?? ''
  const dryRun = process.argv.includes('--dry-run')
  if (!/^v\d+\.\d+\.\d+$/.test(tag) || !['ios', 'android'].includes(platform) || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Expected explicit release tag, platform and GITHUB_REPOSITORY')
  if (!dryRun && process.env.GITHUB_ACTIONS !== 'true') throw new Error('Delivery runs only in GitHub Actions; use --dry-run for read-only planning')
  const gh = (...args: string[]) => command(['gh', ...args], root)
  const eas = (...args: string[]) => command(['bunx', `eas-cli@${EAS_CLI_VERSION}`, ...args], mobile)
  const commit = await command(['git', 'rev-parse', `refs/tags/${tag}^{commit}`], root)
  if (commit !== await command(['git', 'rev-parse', 'HEAD'], root)) throw new Error('Checkout must match the exact release tag commit')
  const target: Release = JSON.parse(await gh('api', `repos/${repo}/releases/tags/${tag}`))
  if (target.draft || target.prerelease || target.tag_name !== tag) throw new Error('Mobile delivery requires an existing published stable GitHub Release')
  const projectId = process.env.EXPO_PROJECT_ID ?? ''
  const owner = process.env.EXPO_OWNER ?? ''
  const ascAppId = platform === 'ios' ? process.env.ASC_APP_ID : undefined
  if (!/^[a-f0-9-]{36}$/.test(projectId) || !/^[\w-]+$/.test(owner)) throw new Error('Configure EXPO_PROJECT_ID and EXPO_OWNER repository variables')
  if (platform === 'ios' && !/^\d+$/.test(ascAppId ?? '')) throw new Error('Configure ASC_APP_ID repository variable for iOS')
  const config = JSON.parse(readFileSync(resolve(mobile, 'app.json'), 'utf8'))
  const pkg = JSON.parse(readFileSync(resolve(mobile, 'package.json'), 'utf8'))
  const version = config.expo.version
  if (pkg.version !== version) throw new Error('mobile/package.json and mobile/app.json versions differ')
  const tree = await command(['git', 'ls-tree', '-r', '-z', commit], root)
  const fingerprint = fingerprintInputs(tree, { platform, projectId, owner, ascAppId, packageManager: JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).packageManager }, path => readFileSync(resolve(root, path), 'utf8'))
  const manifestName = `mobile-release-${platform}.json`
  const releases: Release[] = JSON.parse(await gh('api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`)).flat()
  const deliveries: Delivery[] = []
  for (const release of releases.filter(item => !item.draft && !item.prerelease)) {
    const asset = release.assets.find(item => item.name === manifestName)
    if (!asset) continue
    const delivery = parseDelivery(JSON.parse(await gh('api', '-H', 'Accept: application/octet-stream', `repos/${repo}/releases/assets/${asset.id}`)))
    if (delivery.platform !== platform || delivery.tag !== release.tag_name) throw new Error('Mobile delivery manifest does not match its release')
    if (platform === 'android' && !release.assets.some(item => item.name === delivery.asset)) throw new Error('Previously delivered APK is missing; restore it before releasing')
    deliveries.push(delivery)
  }
  const plan = planDelivery({ platform, tag, commit, fingerprint, version, deliveries })
  console.log(`${platform}: ${plan.reason}`)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Mobile ${platform}\n\n${plan.reason}. Mobile version: ${version}.\n`)
  if (!plan.build || dryRun) return
  if (!process.env.EXPO_TOKEN) throw new Error('Configure EXPO_TOKEN before building')
  const easPath = resolve(mobile, 'eas.json')
  const originalEas = readFileSync(easPath, 'utf8')
  const easConfig = JSON.parse(originalEas)
  if (easConfig.cli?.appVersionSource !== 'remote' || !easConfig.build?.production?.autoIncrement) throw new Error('Production builds must use remote auto-incrementing build versions')
  easConfig.build.production.env = { ...easConfig.build.production.env, EXPO_PROJECT_ID: projectId, EXPO_OWNER: owner }
  if (platform === 'ios') {
    easConfig.submit ??= {}
    easConfig.submit.production ??= {}
    easConfig.submit.production.ios = { ...easConfig.submit.production.ios, ascAppId }
  }
  writeFileSync(easPath, JSON.stringify(easConfig, null, 2) + '\n')
  try {
    const input = { platform, commit, fingerprint, version }
    let build = await findReusableBuild(input, async (offset, limit) => JSON.parse(await eas('build:list', '--platform', platform, '--build-profile', 'production', '--git-commit-hash', commit, '--offset', String(offset), '--limit', String(limit), '--json', '--non-interactive')))
    if (!build) {
      const result: Build[] = JSON.parse(await eas('build', '--platform', platform, '--profile', 'production', '--message', buildMessage(platform, fingerprint), '--freeze-credentials', '--wait', '--json', '--non-interactive'))
      build = selectReusableBuild(result, input)
      if (!build) throw new Error('EAS did not return a successful build for the release inputs')
    }
    const outputDir = resolve(process.env.RUNNER_TEMP ?? root, `mobile-release-${platform}`)
    mkdirSync(outputDir, { recursive: true })
    await deliverBuild(platform, build, {
      submit: async id => {
        // Recover an upload that succeeded before the GitHub manifest could be saved.
        const submissions: Submission[] = []
        for (let offset = 0; ; offset += 50) {
          const page: Submission[] = JSON.parse(await eas('submit:list', '--platform', 'ios', '--offset', String(offset), '--limit', '50', '--json', '--non-interactive'))
          submissions.push(...page)
          if (page.length < 50) break
        }
        if (submissionAlreadyFinished(submissions, id, ascAppId!)) return
        await command(['bunx', `eas-cli@${EAS_CLI_VERSION}`, 'submit', '--platform', 'ios', '--profile', 'production', '--id', id, '--wait', '--non-interactive'], mobile, true)
      },
      uploadApk: async finished => {
        const url = finished.artifacts?.applicationArchiveUrl ?? finished.artifacts?.buildUrl
        if (!url || new URL(url).protocol !== 'https:') throw new Error('Missing secure EAS artifact URL')
        const response = await fetch(url)
        if (!response.ok) throw new Error(`APK download failed: ${response.status}`)
        const bytes = new Uint8Array(await response.arrayBuffer())
        if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('EAS artifact is not an APK archive')
        const asset = `cc-haha-mobile-${version}-${finished.id}.apk`
        const path = resolve(outputDir, asset)
        writeFileSync(path, bytes)
        const entries = (await command(['unzip', '-Z1', path], root)).split('\n')
        if (!entries.includes('AndroidManifest.xml')) throw new Error('Expected an installable APK, not an Android App Bundle')
        const certificate = await command(['apksigner', 'verify', '--print-certs', path], root)
        if (/CN=Android Debug/i.test(certificate)) throw new Error('Refusing to distribute an APK signed with the default debug key')
        // Android packaging is fixed to APK by the production profile; never submit to Play.
        await gh('release', 'upload', tag, path, '--clobber', '--repo', repo)
        return { asset, sha256: createHash('sha256').update(bytes).digest('hex') }
      },
      record: async details => {
        const delivery: Delivery = { schemaVersion: 1, platform, tag, commit, fingerprint, version, ...details, deliveredAt: new Date().toISOString(), destination: platform === 'ios' ? 'app-store-connect' : 'github-release' }
        parseDelivery(delivery)
        const path = resolve(outputDir, manifestName)
        writeFileSync(path, JSON.stringify(delivery, null, 2) + '\n')
        await gh('release', 'upload', tag, path, '--clobber', '--repo', repo)
        console.log(`${platform}: delivered mobile ${version}, EAS build ${details.buildId}`)
      },
    })
  } finally {
    writeFileSync(easPath, originalEas)
  }
}

if (import.meta.main) main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
