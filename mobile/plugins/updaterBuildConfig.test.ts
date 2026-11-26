import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { createSandboxedTestEnvironment, removeTestSandbox } from '../../scripts/pr/test-environment'
import { isBuildInput } from '../../scripts/mobile-release'

const root = resolve(import.meta.dir, '..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')
const moduleDir = 'modules/cchaha-updater/android'

function autolinkedProjects(platform: 'android' | 'apple') {
  const sandbox = mkdtempSync(join(tmpdir(), 'mobile-updater-build-config-'))
  try {
    const output = execFileSync(process.execPath, [
      '--no-env-file', join(root, 'node_modules/expo-modules-autolinking/bin/expo-modules-autolinking.js'),
      'resolve', '--platform', platform, '--json',
    ], {
      cwd: root,
      env: { ...createSandboxedTestEnvironment(sandbox, { CI: '1', EXPO_NO_DOTENV: '1', NO_COLOR: '1' }), NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
    })
    const modules = JSON.parse(output.toString()).modules as { packageName: string, projects?: { name: string, sourceDir: string }[] }[]
    return modules.flatMap(module => (module.projects ?? []).map(project => ({
      packageName: module.packageName,
      name: project.name,
      sourceDir: project.sourceDir,
    })))
  } finally {
    removeTestSandbox(sandbox, 'mobile updater config')
  }
}

describe('Android APK updater native wiring', () => {
  test('the updater module is linked into Android builds only', () => {
    expect(autolinkedProjects('android')).toContainEqual({
      packageName: 'cchaha-updater',
      name: 'cchaha-updater',
      sourceDir: join(root, moduleDir),
    })
    expect(autolinkedProjects('apple').map(project => project.packageName)).not.toContain('cchaha-updater')
  }, 40000)

  test('manifest declares REQUEST_INSTALL_PACKAGES, isolated FileProvider and APK query', () => {
    const manifest = read(`${moduleDir}/src/main/AndroidManifest.xml`)
    expect(manifest).toContain('android.permission.REQUEST_INSTALL_PACKAGES')
    expect(manifest).toContain('android:name="app.cchaha.updater.UpdaterFileProvider"')
    expect(manifest).toContain('android:authorities="${applicationId}.updater.fileprovider"')
    expect(manifest).toContain('android:exported="false"')
    expect(manifest).toContain('android:grantUriPermissions="true"')
    expect(manifest).toContain('android:resource="@xml/cchaha_updater_paths"')
    expect(manifest).toContain('application/vnd.android.package-archive')

    const pathsXml = read(`${moduleDir}/src/main/res/xml/cchaha_updater_paths.xml`)
    expect(pathsXml).toContain('<cache-path name="apk_updates" path="cchaha-updates/" />')
  })

  test('release shrinking keeps the updater module and FileProvider', () => {
    expect(read(`${moduleDir}/build.gradle`)).toContain("consumerProguardFiles 'proguard-rules.pro'")
    const proguard = read(`${moduleDir}/proguard-rules.pro`)
    expect(proguard).toContain('-keep class app.cchaha.updater.UpdaterModule { *; }')
    expect(proguard).toContain('-keep class app.cchaha.updater.UpdaterFileProvider { *; }')
  })

  test('mobile release fingerprint tracks the updater native sources', () => {
    expect(isBuildInput('mobile/modules/cchaha-updater/index.ts')).toBe(true)
    expect(isBuildInput('mobile/modules/cchaha-updater/expo-module.config.json')).toBe(true)
    expect(isBuildInput('mobile/modules/cchaha-updater/android/src/main/AndroidManifest.xml')).toBe(true)
    expect(isBuildInput('mobile/modules/cchaha-updater/android/src/main/java/app/cchaha/updater/UpdaterModule.kt')).toBe(true)
  })

  test('UpdaterModule matches installed expo-modules-core Kotlin APIs and AOSP 9-13 signature workaround', () => {
    const coded = read('node_modules/expo-modules-core/android/src/main/java/expo/modules/kotlin/exception/CodedException.kt')
    expect(coded).toContain('constructor(code: String?, message: String?, cause: Throwable?)')
    const mod = read('node_modules/expo-modules-core/android/src/main/java/expo/modules/kotlin/modules/Module.kt')
    expect(mod).toContain('fun sendEvent(name: String, body: Map<String, Any?>)')
    const afb = read('node_modules/expo-modules-core/android/src/main/java/expo/modules/kotlin/functions/AsyncFunctionBuilder.kt')
    expect(afb).toContain('AsyncFunctionBuilder.Coroutine(')

    // Guard AOSP #243324820 (Android 13) & #159537841 (Android 9-12) signingInfo null workaround.
    const verifier = read(`${moduleDir}/src/main/java/app/cchaha/updater/ApkVerifier.kt`)
    expect(verifier).toContain('PackageManager.GET_SIGNING_CERTIFICATES or PackageManager.GET_SIGNATURES')
    expect(verifier).toContain('selectCurrentSignerBytes')

    // Guard against blocking China / LAN / VPN devices on Google captive-portal validation.
    const ctx = read('src/state/AndroidUpdateContext.tsx')
    expect(ctx).not.toContain('state.isInternetReachable')
  })
})
