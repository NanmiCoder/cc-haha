import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { mergeUpdateMetadataArtifacts } from '../release-update-metadata'

describe('release desktop workflow', () => {
  function readReleaseWorkflow() {
    return readFileSync('.github/workflows/release-desktop.yml', 'utf8')
  }

  function extractJob(workflow: string, jobName: string) {
    return workflow.match(
      new RegExp(`${jobName}:[\\s\\S]*?(?:\\n {2}[a-zA-Z0-9_-]+:|$)`),
    )?.[0]
  }

  function extractStep(workflow: string, stepName: string) {
    return workflow.match(
      new RegExp(`- name: ${stepName}[\\s\\S]*?(?:\\n\\s{6}- name:|$)`),
    )?.[0]
  }

  const electronBuilderCli = 'node ./node_modules/electron-builder/out/cli/cli.js ${{ matrix.builder_args }} --publish never'

  type MatrixRow = { label: string, builder_args: string, arch: string }
  type ArtifactConfig = { artifactName?: string }

  const RELEASE_CHANNELS: Record<string, string> = {
    'macOS-ARM64': 'latest-mac.yml',
    'macOS-x64': 'latest-mac.yml',
    'Linux-x64': 'latest-linux.yml',
    'Linux-ARM64': 'latest-linux-arm64.yml',
    'Windows-x64': 'latest.yml',
    'Windows-ARM64': 'latest.yml',
  }
  const TARGET_EXTENSIONS: Record<string, string> = { dmg: 'dmg', zip: 'zip', nsis: 'exe', AppImage: 'AppImage', deb: 'deb', rpm: 'rpm' }
  // Config keys electron-builder reads target options from; the mac zip has none.
  const TARGET_CONFIG_KEYS: Record<string, string> = { dmg: 'dmg', nsis: 'nsis', AppImage: 'appImage', deb: 'deb', rpm: 'rpm' }

  function releaseMatrix(): MatrixRow[] {
    return parse(readReleaseWorkflow()).jobs.build.strategy.matrix.include
  }

  // builder-util getArtifactArchName: ${arch} is spelled per Linux package format.
  function artifactArchName(arch: string, ext: string) {
    if (arch === 'x64' && (ext === 'AppImage' || ext === 'rpm')) return 'x86_64'
    if (arch === 'x64' && ext === 'deb') return 'amd64'
    if (arch === 'arm64' && ext === 'rpm') return 'aarch64'
    return arch
  }

  // The file names electron-builder writes for one matrix row: target options
  // win over platform options, and `-c.<key>.artifactName=` overrides from the
  // row's builder_args win over desktop/package.json at the same level.
  function packagedAssetNames(row: MatrixRow, version: string) {
    const build = JSON.parse(readFileSync('desktop/package.json', 'utf8')).build as
      Record<string, ArtifactConfig | undefined> & { artifactName?: string }
    const overrides = new Map(
      [...row.builder_args.matchAll(/'-c\.([A-Za-z]+)\.artifactName=([^']+)'/g)].map(match => [match[1], match[2]]),
    )
    const [, platformKey, targetList] = row.builder_args.match(/--(mac|win|linux) ([A-Za-z ]+?) --/) ?? []
    expect(platformKey, row.label).toBeTruthy()
    const arch = row.builder_args.includes('--arm64') ? 'arm64' : 'x64'
    return targetList.split(' ').map((target) => {
      const ext = TARGET_EXTENSIONS[target]
      const targetKey = TARGET_CONFIG_KEYS[target]
      const pattern = (targetKey ? overrides.get(targetKey) ?? build[targetKey]?.artifactName : undefined)
        ?? overrides.get(platformKey) ?? build[platformKey]?.artifactName ?? build.artifactName
      expect(pattern, `${row.label} ${target}`).toBeTruthy()
      return pattern!.replace(/\$\{(\w+)\}/g, (_, macro: string) => {
        if (macro === 'version') return version
        if (macro === 'ext') return ext
        if (macro === 'arch') return artifactArchName(arch, ext)
        throw new Error(`Unexpected artifactName macro ${macro}`)
      })
    })
  }

  // electron-updater 6.8.3 out/providers/Provider.js findFile: among files with
  // the extension, prefer one whose name contains process.arch.
  function findUpdateFile(urls: string[], extension: string, processArch: string, not?: string[]) {
    const filtered = urls.filter(url => url.toLowerCase().endsWith(`.${extension.toLowerCase()}`))
    const result = filtered.find(url => url.includes(processArch)) ?? filtered[0]
    if (result) return result
    if (!not) return urls[0]
    return urls.find(url => !not.some(ext => url.toLowerCase().endsWith(`.${ext.toLowerCase()}`)))
  }

  // electron-updater 6.8.3 out/MacUpdater.js doDownloadUpdate: Apple Silicon
  // (including an x64 build under Rosetta) keeps only files named "arm64",
  // Intel drops them, then the zip is chosen.
  function pickMacUpdate(urls: string[], isArm64Mac: boolean, processArch: string) {
    const isArm64 = (url: string) => url.includes('arm64')
    const files = isArm64Mac && urls.some(isArm64)
      ? urls.filter(url => isArm64(url))
      : urls.filter(url => !isArm64(url))
    return findUpdateFile(files, 'zip', processArch, ['pkg', 'dmg'])
  }

  test('release packaging does not run the PR-quality gate', () => {
    const workflow = readReleaseWorkflow()

    // Quality gates run on PRs, not at release time: tagging should not be
    // blocked by `bun run verify`. Releasing is gated on the tag only.
    expect(workflow).not.toContain('quality-preflight')
    expect(workflow).not.toContain('bun run verify')
    expect(workflow).toContain('name: Build (${{ matrix.label }})')
  })

  test('version tags have exactly one desktop release publisher', () => {
    const releasePublishers = readdirSync('.github/workflows')
      .filter(fileName => fileName.endsWith('.yml'))
      .filter((fileName) => {
        const workflow = readFileSync(`.github/workflows/${fileName}`, 'utf8')
        return workflow.includes("tags: ['v*.*.*']")
          && workflow.includes('softprops/action-gh-release@v2')
      })

    expect(releasePublishers).toEqual(['release-desktop.yml'])
  })

  test('desktop build workflows keep Bun compile cache on the runner work drive', () => {
    for (const workflowPath of [
      '.github/workflows/build-desktop-dev.yml',
      '.github/workflows/release-desktop.yml',
    ]) {
      const workflow = readFileSync(workflowPath, 'utf8')
      for (const stepName of ['Build sidecars']) {
        const step = workflow.match(
          new RegExp(`- name: ${stepName}[\\s\\S]*?(?:\\n\\s{6}- name:|\\n\\s*with:|$)`),
        )?.[0]

        expect(step, `${workflowPath} ${stepName}`).toContain(
          'BUN_INSTALL_CACHE_DIR: ${{ runner.temp }}/bun-install-cache',
        )
        expect(step, `${workflowPath} ${stepName}`).toContain(
          'SIDECAR_TARGET_TRIPLE: ${{ matrix.target_triple }}',
        )
      }

      if (workflowPath === '.github/workflows/release-desktop.yml') {
        expect(workflow).toContain('Build signed macOS Electron release artifacts')
        expect(workflow).toContain('Build unsigned Electron release artifacts')
      } else {
        expect(workflow).toContain('Build Electron app')
        expect(workflow).toContain(electronBuilderCli)
      }
      expect(workflow).toContain('smoke_platform')
      expect(workflow).toContain('bun run test:package-smoke --platform ${{ matrix.smoke_platform }} --arch ${{ matrix.arch }} --package-kind release --artifacts-dir desktop/build-artifacts/electron')
      expect(workflow).not.toContain('tauri-apps/tauri-action@v0')
    }
  })

  test('desktop build workflows install the Bun version declared by packageManager', () => {
    for (const workflowPath of [
      '.github/workflows/build-desktop-dev.yml',
      '.github/workflows/release-desktop.yml',
    ]) {
      const workflow = readFileSync(workflowPath, 'utf8')
      const setupBunStepCount = workflow.match(/uses: oven-sh\/setup-bun@v2/g)?.length ?? 0
      const packageVersionCount = workflow.match(/bun-version-file: package\.json/g)?.length ?? 0

      expect(setupBunStepCount, workflowPath).toBeGreaterThan(0)
      expect(packageVersionCount, workflowPath).toBe(setupBunStepCount)
      expect(workflow, workflowPath).not.toContain('bun-version: latest')
    }
  })

  test('Windows x64 builds execute the compiled sidecar before packaging', () => {
    for (const workflowPath of [
      '.github/workflows/build-desktop-dev.yml',
      '.github/workflows/release-desktop.yml',
    ]) {
      const workflow = readFileSync(workflowPath, 'utf8')
      const smokeStep = extractStep(workflow, 'Verify compiled Windows sidecar startup')

      expect(smokeStep, workflowPath).toContain(
        "if: matrix.smoke_platform == 'windows' && matrix.arch == 'x64'",
      )
      expect(smokeStep, workflowPath).toContain('working-directory: desktop')
      expect(smokeStep, workflowPath).toContain("CC_HAHA_COMPILED_SIDECAR_SMOKE_STARTS: '20'")
      expect(smokeStep, workflowPath).toContain('bun run test:compiled-sidecar-smoke')
      expect(workflow.indexOf('Build sidecars'), workflowPath).toBeLessThan(
        workflow.indexOf('Verify compiled Windows sidecar startup'),
      )
      expect(workflow.indexOf('Verify compiled Windows sidecar startup'), workflowPath)
        .toBeLessThan(workflow.indexOf('Build renderer and Electron bundles'))
    }
  })

  test('desktop build workflows install the phone app before building the renderer', () => {
    // `bun run build` exports mobile/ into dist/m; without its packages the build fails.
    for (const workflowPath of [
      '.github/workflows/build-desktop-dev.yml',
      '.github/workflows/release-desktop.yml',
    ]) {
      const workflow = readFileSync(workflowPath, 'utf8')
      const installStep = extractStep(workflow, 'Install mobile dependencies')

      expect(installStep, workflowPath).toContain('working-directory: mobile')
      expect(installStep, workflowPath).toContain('bun install --frozen-lockfile')
      expect(workflow.indexOf('Install mobile dependencies'), workflowPath)
        .toBeLessThan(workflow.indexOf('Build renderer and Electron bundles'))
    }
  })

  test('desktop build workflows prepare the pinned ripgrep asset before sidecars', () => {
    for (const workflowPath of [
      '.github/workflows/build-desktop-dev.yml',
      '.github/workflows/release-desktop.yml',
    ]) {
      const workflow = readFileSync(workflowPath, 'utf8')
      const prepareStep = extractStep(workflow, 'Prepare bundled ripgrep')

      expect(prepareStep, workflowPath).toContain(
        'SIDECAR_TARGET_TRIPLE: ${{ matrix.target_triple }}',
      )
      expect(prepareStep, workflowPath).toContain('bun run prepare:ripgrep')
      expect(workflow.indexOf('Prepare bundled ripgrep')).toBeLessThan(
        workflow.indexOf('Build sidecars'),
      )
    }
  })

  test('Linux desktop builds package node-pty compiled for the glibc floor package-smoke enforces', () => {
    for (const workflowPath of [
      '.github/workflows/build-desktop-dev.yml',
      '.github/workflows/release-desktop.yml',
    ]) {
      const workflow = readFileSync(workflowPath, 'utf8')
      const rebuildStep = extractStep(workflow, 'Rebuild node-pty for the Linux glibc floor')

      expect(rebuildStep, workflowPath).toContain("if: matrix.smoke_platform == 'linux'")
      expect(rebuildStep, workflowPath).toContain('working-directory: desktop')
      expect(rebuildStep, workflowPath).toContain('bash ./scripts/rebuild-node-pty-linux.sh')
      expect(workflow.indexOf('Build renderer and Electron bundles'), workflowPath)
        .toBeLessThan(workflow.indexOf('Rebuild node-pty for the Linux glibc floor'))
      expect(workflow.indexOf('Rebuild node-pty for the Linux glibc floor'), workflowPath)
        .toBeLessThan(workflow.indexOf(electronBuilderCli))
      expect(extractStep(workflow, 'Verify packaged app structure'), workflowPath)
        .toContain("${{ matrix.smoke_platform == 'linux' && '--max-linux-glibc 2.28' || '' }}")
    }
  })

  test('development desktop artifacts exclude unpacked macOS app bundles and updater-only files', () => {
    const workflow = readFileSync('.github/workflows/build-desktop-dev.yml', 'utf8')
    const collectStep = workflow.match(
      /- name: Collect artifacts[\s\S]*?(?:\n\s{6}- name:|$)/,
    )?.[0]

    expect(collectStep).toContain('*.dmg')
    // The macOS auto-update zip and blockmaps are not collected: unsigned builds
    // ship manual downloads only, so the artifact stays the installer + script.
    expect(collectStep).not.toContain('*.zip')
    expect(collectStep).not.toContain('*.blockmap')
    expect(collectStep).toContain('*.yml')
    expect(collectStep).toContain('install-macos-unsigned.sh')
    expect(collectStep).toContain('[ "${{ matrix.smoke_platform }}" = "macos" ]')
    expect(collectStep).not.toContain('-type d -name "*.app"')
  })

  test('desktop package includes Linux deb metadata required by electron-builder', () => {
    const desktopPackage = JSON.parse(readFileSync('desktop/package.json', 'utf8')) as {
      description?: string
      homepage?: string
      author?: {
        name?: string
        email?: string
      }
      build?: {
        linux?: {
          maintainer?: string
        }
      }
    }

    expect(desktopPackage.description).toBeTruthy()
    expect(desktopPackage.homepage).toBe('https://github.com/NanmiCoder/cc-haha')
    expect(desktopPackage.author?.name).toBe('NanmiCoder')
    expect(desktopPackage.author?.email).toBe('relakkes@gmail.com')
    expect(desktopPackage.build?.linux?.maintainer).toBe('NanmiCoder <relakkes@gmail.com>')
  })

  test('release workflow requires macOS Gatekeeper launch approval for signed builds', () => {
    const workflow = readReleaseWorkflow()
    const gatekeeperStep = workflow.match(
      /- name: Verify macOS launch policy[\s\S]*?(?:\n\s{6}- name:|$)/,
    )?.[0]
    const notarizationWarningStep = workflow.match(
      /- name: Warn macOS notarization skipped[\s\S]*?(?:\n\s{6}- name:|$)/,
    )?.[0]
    const unsignedWarningStep = workflow.match(
      /- name: Warn unsigned macOS launch policy skipped[\s\S]*?(?:\n\s{6}- name:|$)/,
    )?.[0]

    expect(workflow).toContain('notarize_macos:')
    expect(workflow).toContain("description: 'Notarize macOS artifacts'")
    expect(gatekeeperStep).toContain("if: matrix.smoke_platform == 'macos' && needs.signing-preflight.outputs.macos_signed == 'true' && (github.event_name != 'workflow_dispatch' || inputs.notarize_macos == true)")
    expect(gatekeeperStep).toContain('bun run test:package-smoke --platform macos --arch ${{ matrix.arch }} --package-kind release --artifacts-dir desktop/build-artifacts/electron --require-macos-gatekeeper')
    expect(notarizationWarningStep).toContain("if: matrix.smoke_platform == 'macos' && needs.signing-preflight.outputs.macos_signed == 'true' && github.event_name == 'workflow_dispatch' && inputs.notarize_macos == false")
    expect(notarizationWarningStep).toContain('Developer ID signed but not notarized')
    expect(unsignedWarningStep).toContain("if: matrix.smoke_platform == 'macos' && needs.signing-preflight.outputs.macos_signed != 'true'")
    expect(unsignedWarningStep).toContain('install-macos-unsigned.sh')
    expect(workflow.indexOf('Verify macOS launch policy')).toBeLessThan(workflow.indexOf('Upload release artifacts for final publish'))
  })

  test('release workflow signs and notarizes macOS builds only when signing preflight succeeds', () => {
    const workflow = readReleaseWorkflow()
    const importIdentityStep = extractStep(workflow, 'Import macOS signing identity for native runtimes')
    const signedBuildStep = extractStep(workflow, 'Build signed macOS Electron release artifacts')
    const unsignedBuildStep = extractStep(workflow, 'Build unsigned Electron release artifacts')

    expect(workflow).toContain('app_bundle_dir: mac-arm64')
    expect(workflow).toContain('app_bundle_dir: mac')
    expect(signedBuildStep).toContain("if: matrix.smoke_platform == 'macos' && needs.signing-preflight.outputs.macos_signed == 'true'")
    expect(importIdentityStep).toContain('CSC_LINK: ${{ secrets.MACOS_CERTIFICATE }}')
    expect(importIdentityStep).toContain('CSC_KEY_PASSWORD: ${{ secrets.MACOS_CERTIFICATE_PASSWORD }}')
    expect(signedBuildStep).toContain('APPLE_ID: ${{ secrets.APPLE_ID }}')
    expect(signedBuildStep).toContain('APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}')
    expect(signedBuildStep).toContain('APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}')
    expect(signedBuildStep).toContain("MACOS_NOTARIZE: ${{ github.event_name != 'workflow_dispatch' || inputs.notarize_macos }}")
    expect(signedBuildStep).not.toContain('CSC_IDENTITY_AUTO_DISCOVERY')
    expect(signedBuildStep).toContain('timeout-minutes: 80')
    expect(signedBuildStep).toContain("DEBUG: 'electron-builder,electron-osx-sign,electron-notarize*'")
    expect(signedBuildStep).toContain('macOS signing diagnostics')
    expect(signedBuildStep).toContain('xcrun --find notarytool')
    expect(signedBuildStep).toContain('security find-identity -v -p codesigning')
    expect(signedBuildStep).toContain('macOS notarization requested: ${MACOS_NOTARIZE}')
    expect(signedBuildStep).toContain('builder_args=( ${{ matrix.builder_args }} --publish never -c.mac.notarize=false )')
    expect(signedBuildStep).toContain('max_attempts=1')
    expect(signedBuildStep).toContain('build_timeout_seconds=900')
    expect(signedBuildStep).toContain('-c.mac.notarize=false')
    expect(signedBuildStep).toContain('macOS notarization is disabled for this draft run')
    expect(signedBuildStep).toContain('run_signed_electron_builder')
    expect(signedBuildStep).toContain('run_electron_builder_with_retries')
    expect(signedBuildStep).toContain('notarize_app_bundle')
    expect(signedBuildStep).toContain('xcrun notarytool submit "$notary_zip"')
    expect(signedBuildStep).toContain('--timeout "$notary_timeout"')
    expect(signedBuildStep).toContain('notary_attempts=3')
    expect(signedBuildStep).toContain('xcrun stapler staple "$app_path"')
    expect(signedBuildStep).toContain('xcrun stapler validate "$app_path"')
    expect(signedBuildStep).toContain('spctl -a -vv -t execute "$app_path"')
    expect(signedBuildStep).toContain('app_path="build-artifacts/electron/${{ matrix.app_bundle_dir }}/Claude Code Haha.app"')
    expect(signedBuildStep).toContain('package_args=( ${{ matrix.builder_args }} --prepackaged "$app_path" --publish never -c.mac.notarize=false )')
    expect(signedBuildStep).toContain('find build-artifacts/electron -maxdepth 1 -type f -delete')
    expect(signedBuildStep).toContain('Signed electron-builder timed out')
    expect(signedBuildStep).toContain('pkill -TERM -P "$build_pid"')
    expect(signedBuildStep).toContain('with ${timeout_seconds}s watchdog')
    expect(signedBuildStep).toContain('set +e')
    expect(signedBuildStep).toContain('status=$?')
    expect(signedBuildStep).toContain('if [ "$status" -eq 0 ]; then')
    expect(signedBuildStep).toContain('rm -rf build-artifacts/electron')
    expect(signedBuildStep).toContain('Starting signed electron-builder attempt')
    expect(signedBuildStep).toContain('Finished signed electron-builder attempt')
    expect(signedBuildStep).toContain('retrying after 120 seconds')
    expect(signedBuildStep).toContain('node ./node_modules/electron-builder/out/cli/cli.js "${builder_args[@]}"')

    expect(unsignedBuildStep).toContain("if: matrix.smoke_platform == 'linux' || (matrix.smoke_platform == 'macos' && needs.signing-preflight.outputs.macos_signed != 'true') || (matrix.smoke_platform == 'windows' && needs.signing-preflight.outputs.windows_signed != 'true')")
    expect(unsignedBuildStep).toContain("CSC_IDENTITY_AUTO_DISCOVERY: 'false'")
    for (const envName of [
      'CSC_LINK:',
      'CSC_KEY_PASSWORD:',
      'APPLE_ID:',
      'APPLE_APP_SPECIFIC_PASSWORD:',
      'APPLE_TEAM_ID:',
    ]) {
      expect(unsignedBuildStep).not.toContain(envName)
    }
    expect(unsignedBuildStep).toContain(electronBuilderCli)
    expect(workflow.indexOf('Build signed macOS Electron release artifacts')).toBeLessThan(workflow.indexOf('Verify packaged app structure'))
    expect(workflow.indexOf('Build unsigned Electron release artifacts')).toBeLessThan(workflow.indexOf('Verify packaged app structure'))
  })

  test('macOS packaging reuses the native runtime keychain instead of importing the certificate again', () => {
    const workflow = readReleaseWorkflow()
    const importIdentityStep = extractStep(workflow, 'Import macOS signing identity for native runtimes')
    const signedBuildStep = extractStep(workflow, 'Build signed macOS Electron release artifacts')
    const cleanupStep = extractStep(workflow, 'Remove temporary macOS signing keychain')

    expect(importIdentityStep).toContain('echo "CC_HAHA_CI_KEYCHAIN=$keychain_path" >> "$GITHUB_ENV"')
    expect(signedBuildStep).toContain('export CSC_KEYCHAIN="${CC_HAHA_CI_KEYCHAIN:?macOS signing keychain was not prepared}"')
    expect(signedBuildStep).not.toContain('CSC_LINK:')
    expect(signedBuildStep).not.toContain('CSC_KEY_PASSWORD:')
    expect(cleanupStep).toContain('security delete-keychain "$CC_HAHA_CI_KEYCHAIN"')
    expect(workflow.indexOf('Import macOS signing identity for native runtimes')).toBeLessThan(
      workflow.indexOf('Build signed macOS Electron release artifacts'),
    )
    expect(workflow.indexOf('Remove temporary macOS signing keychain')).toBeGreaterThan(
      workflow.indexOf('Verify macOS launch policy'),
    )
  })

  test('release workflow requires signed macOS Computer Use and preserves SignPath draft policy', () => {
    const workflow = readReleaseWorkflow()
    const signingJob = workflow.match(
      /signing-preflight:[\s\S]*?(?:\n {2}[a-zA-Z0-9_-]+:|$)/,
    )?.[0]
    const buildJob = extractJob(workflow, 'build')

    expect(signingJob).toContain('Validate release signing and notarization secrets')
    expect(signingJob).toContain('outputs:')
    expect(signingJob).toContain('macos_signed: ${{ steps.validate.outputs.macos_signed }}')
    expect(signingJob).toContain('windows_signed: ${{ steps.validate.outputs.windows_signed }}')
    for (const secret of [
      'MACOS_CERTIFICATE',
      'MACOS_CERTIFICATE_PASSWORD',
      'APPLE_ID',
      'APPLE_APP_SPECIFIC_PASSWORD',
      'APPLE_TEAM_ID',
    ]) {
      expect(signingJob).toContain(secret)
    }
    for (const setting of [
      'SIGNPATH_API_TOKEN',
      'SIGNPATH_ORGANIZATION_ID',
      'SIGNPATH_PROJECT_SLUG',
      'SIGNPATH_TEST_SIGNING_POLICY_SLUG',
      'SIGNPATH_RELEASE_SIGNING_POLICY_SLUG',
      'SIGNPATH_APPLICATION_ARTIFACT_CONFIGURATION_SLUG',
      'SIGNPATH_INSTALLER_ARTIFACT_CONFIGURATION_SLUG',
    ]) {
      expect(signingJob).toContain(setting)
    }
    expect(signingJob).toContain('Missing macOS signing/notarization secrets')
    expect(signingJob).toContain('refusing to build a macOS release whose Computer Use runtime cannot pass client attestation')
    expect(signingJob).toContain("RELEASE_DRAFT: ${{ github.event_name == 'workflow_dispatch' && inputs.draft == true }}")
    expect(signingJob).toContain('macos_signed=false')
    expect(signingJob).toContain('macos_signed=true')
    expect(signingJob).toContain('SignPath configuration missing')
    expect(signingJob).toContain('windows_signed=false')
    expect(signingJob).toContain('windows_signed=true')
    expect(signingJob).toContain('Refusing to publish a non-draft desktop release without SignPath Windows signing.')
    expect(signingJob).toContain("inputs.draft == true && vars.SIGNPATH_TEST_SIGNING_POLICY_SLUG || vars.SIGNPATH_RELEASE_SIGNING_POLICY_SLUG")

    const macRequiredBlock = signingJob?.match(
      /missing=\(\)[\s\S]*?# Windows signing is opt-in/,
    )?.[0]
    expect(macRequiredBlock).not.toContain('if [ "$RELEASE_DRAFT" != "true" ]; then')
    expect(macRequiredBlock).toContain('exit 1')
    expect(signingJob).toContain('if [ "$RELEASE_DRAFT" != "true" ]; then')
    expect(signingJob).toContain('exit 1')
    expect(buildJob).toContain('- signing-preflight')
    expect(workflow.indexOf('signing-preflight:')).toBeLessThan(workflow.indexOf('build:'))
    expect(workflow.indexOf('signing-preflight:')).toBeLessThan(workflow.indexOf('Upload release artifacts for final publish'))
  })

  test('Windows signing stays off until the repository variable or a manual run asks for it', async () => {
    const workflow = parse(readReleaseWorkflow())
    expect(workflow.on.workflow_dispatch.inputs.skip_windows_signing).toBeUndefined()
    expect(workflow.on.workflow_dispatch.inputs.windows_signing).toEqual({
      description: 'Windows signing: auto follows the WINDOWS_SIGNING_ENABLED repository variable',
      required: false,
      default: 'auto',
      type: 'choice',
      options: ['auto', 'unsigned', 'signed'],
    })
    const preflight = workflow.jobs['signing-preflight'].steps.find((step: { id?: string }) => step.id === 'validate')
    expect(preflight.env.WINDOWS_SIGNING_ENABLED).toBe("${{ vars.WINDOWS_SIGNING_ENABLED == 'true' }}")
    expect(preflight.env.WINDOWS_SIGNING_MODE).toBe("${{ github.event_name == 'workflow_dispatch' && inputs.windows_signing || 'auto' }}")
    expect(preflight.env.SKIP_WINDOWS_SIGNING).toBeUndefined()

    const directory = mkdtempSync(join(tmpdir(), 'release-signing-preflight-'))
    // Every SignPath setting is present, as in the repository today while approval is pending.
    const configured = Object.fromEntries(Object.keys(preflight.env).map(key => [key, 'test-value']))
    const unsigned = 'macos_signed=true\nwindows_signed=false\n'
    const signed = 'macos_signed=true\nwindows_signed=true\n'
    const cases = [
      { name: 'tag or release with signing off', env: {}, code: 0, outputs: unsigned },
      { name: 'draft with signing off', env: { RELEASE_DRAFT: 'true' }, code: 0, outputs: unsigned },
      { name: 'signing off without SignPath settings', env: { SIGNPATH_API_TOKEN: '' }, code: 0, outputs: unsigned },
      { name: 'manual unsigned run overrides enabled signing', env: { WINDOWS_SIGNING_ENABLED: 'true', WINDOWS_SIGNING_MODE: 'unsigned' }, code: 0, outputs: unsigned },
      { name: 'enabled release signs', env: { WINDOWS_SIGNING_ENABLED: 'true' }, code: 0, outputs: signed },
      { name: 'manual trial draft signs while the variable is off', env: { WINDOWS_SIGNING_MODE: 'signed', RELEASE_DRAFT: 'true' }, code: 0, outputs: signed },
      { name: 'enabled release missing SignPath', env: { WINDOWS_SIGNING_ENABLED: 'true', SIGNPATH_API_TOKEN: '' }, code: 1, outputs: unsigned },
      { name: 'enabled draft missing SignPath', env: { WINDOWS_SIGNING_ENABLED: 'true', RELEASE_DRAFT: 'true', SIGNPATH_API_TOKEN: '' }, code: 0, outputs: unsigned },
      { name: 'manual trial missing SignPath', env: { WINDOWS_SIGNING_MODE: 'signed', RELEASE_DRAFT: 'true', SIGNPATH_API_TOKEN: '' }, code: 1, outputs: 'macos_signed=true\n' },
      { name: 'unknown manual mode', env: { WINDOWS_SIGNING_MODE: 'sometimes' }, code: 1, outputs: 'macos_signed=true\n' },
      { name: 'unsigned Windows still requires macOS credentials', env: { CSC_LINK: '' }, code: 1, outputs: 'macos_signed=false\n' },
    ]
    try {
      for (const [index, scenario] of cases.entries()) {
        const output = join(directory, `output-${index}`)
        const logPath = join(directory, `log-${index}`)
        // Capture inside the shell so Bun's test-output pipes cannot affect echo/printf exit codes.
        const result = Bun.spawn(['bash', '-e', '-c', 'exec > "$PREFLIGHT_LOG" 2>&1\n' + preflight.run], {
          env: {
            ...configured,
            RELEASE_DRAFT: 'false',
            WINDOWS_SIGNING_ENABLED: 'false',
            WINDOWS_SIGNING_MODE: 'auto',
            ...scenario.env,
            PATH: process.env.PATH,
            HOME: directory,
            GITHUB_OUTPUT: output,
            PREFLIGHT_LOG: logPath,
          },
          stdout: 'ignore',
          stderr: 'ignore',
        })
        const code = await result.exited
        expect(code, `${scenario.name}: ${readFileSync(logPath, 'utf8')}`).toBe(scenario.code)
        expect(readFileSync(output, 'utf8'), scenario.name).toBe(scenario.outputs)
      }
      // Unsigned Windows builds are the expected state, not a problem worth a warning.
      expect(readFileSync(join(directory, 'log-0'), 'utf8')).toContain('::notice::Windows signing is off')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  // electron-builder only writes publisherName into app-update.yml when it can
  // read a signing certificate, and the CI disables certificate discovery.
  // Installed Windows clients therefore accept both signed and unsigned
  // updates. Setting either key would make every client built with it reject
  // the next unsigned update, with no way to recover in place.
  test('Windows updates never require a code signature while unsigned releases are possible', () => {
    const desktopPackage = JSON.parse(readFileSync('desktop/package.json', 'utf8')) as {
      build: { win?: Record<string, unknown>, nsis?: Record<string, unknown>, publish?: Array<Record<string, unknown>> }
    }
    const winConfig = JSON.stringify([desktopPackage.build.win, desktopPackage.build.nsis, desktopPackage.build.publish])
    expect(winConfig).not.toContain('publisherName')
    expect(winConfig).not.toContain('verifyUpdateCodeSignature')
    const workflow = readReleaseWorkflow()
    expect(workflow).not.toContain('publisherName')
    expect(workflow).not.toContain('verifyUpdateCodeSignature')
    for (const stepName of [
      'Build unsigned Electron release artifacts',
      'Build unsigned Windows bootstrap installer for SignPath',
      'Package NSIS installer from signed Windows application',
    ]) {
      expect(extractStep(workflow, stepName), stepName).toContain("CSC_IDENTITY_AUTO_DISCOVERY: 'false'")
    }
  })

  test('release workflow signs project-owned Windows binaries before packaging and repairs updater metadata', () => {
    const workflow = readReleaseWorkflow()
    const applicationConfiguration = readFileSync('.github/signpath/windows-application.xml', 'utf8')
    const installerConfiguration = readFileSync('.github/signpath/windows-installer.xml', 'utf8')
    const applicationBuildStep = extractStep(workflow, 'Build unsigned Windows bootstrap installer for SignPath')
    const verifyUpdaterConfigStep = extractStep(workflow, 'Verify Windows updater config before SignPath')
    const stageApplicationStep = extractStep(workflow, 'Stage project-owned Windows application executables')
    const signApplicationStep = extractStep(workflow, 'Sign Windows application executables with SignPath')
    const restoreApplicationStep = extractStep(workflow, 'Restore and verify signed Windows application executables')
    const packageInstallerStep = extractStep(workflow, 'Package NSIS installer from signed Windows application')
    const signInstallerStep = extractStep(workflow, 'Sign Windows installer with SignPath')
    const restoreInstallerStep = extractStep(workflow, 'Restore and verify signed Windows installer')
    const refreshMetadataStep = extractStep(workflow, 'Refresh signed Windows blockmap and update metadata')

    expect(workflow).toContain('actions: read')
    expect(workflow).toContain('builder_arch_arg: --x64')
    expect(workflow).toContain('builder_arch_arg: --arm64')
    expect(workflow).toContain('unpacked_dir: win-unpacked')
    expect(workflow).toContain('unpacked_dir: win-arm64-unpacked')
    expect(applicationBuildStep).toContain('--win nsis ${{ matrix.builder_arch_arg }}')
    expect(applicationBuildStep).toContain("CSC_IDENTITY_AUTO_DISCOVERY: 'false'")
    expect(verifyUpdaterConfigStep).toContain('${{ matrix.unpacked_dir }}/resources/app-update.yml')
    expect(verifyUpdaterConfigStep).toContain('Test-Path -LiteralPath')
    expect(workflow.indexOf('Build unsigned Windows bootstrap installer for SignPath')).toBeLessThan(
      workflow.indexOf('Verify Windows updater config before SignPath'),
    )
    expect(workflow.indexOf('Verify Windows updater config before SignPath')).toBeLessThan(
      workflow.indexOf('Stage project-owned Windows application executables'),
    )
    expect(stageApplicationStep).toContain('Claude Code Haha.exe')
    expect(stageApplicationStep).toContain('claude-sidecar-${{ matrix.target_triple }}.exe')
    expect(stageApplicationStep).toContain('agent-desktop.exe')
    expect(stageApplicationStep).toContain('Copy-Item -LiteralPath $agentDesktopExecutable')
    expect(stageApplicationStep).not.toContain('rg.exe')
    expect(stageApplicationStep).not.toContain('node-pty')
    expect(signApplicationStep).toContain('signpath/github-action-submit-signing-request@v2')
    expect(signApplicationStep).toContain('SIGNPATH_APPLICATION_ARTIFACT_CONFIGURATION_SLUG')
    expect(signApplicationStep).toContain('signing-policy-slug: ${{ env.SIGNPATH_SIGNING_POLICY_SLUG }}')
    expect(signApplicationStep).toContain('github-artifact-id: ${{ steps.upload-unsigned-signpath-application.outputs.artifact-id }}')
    expect(restoreApplicationStep).toContain('Get-AuthenticodeSignature')
    expect(restoreApplicationStep).toContain('REQUIRE_TRUSTED_WINDOWS_SIGNATURE')
    expect(restoreApplicationStep).toContain('Copy-Item -LiteralPath (Join-Path $signedDir "agent-desktop.exe")')
    expect(restoreApplicationStep).toContain('Assert-SignPathSignature $agentDesktopExecutable')
    expect(packageInstallerStep).toContain('--prepackaged "build-artifacts/electron/${{ matrix.unpacked_dir }}"')
    expect(signInstallerStep).toContain('signpath/github-action-submit-signing-request@v2')
    expect(signInstallerStep).toContain('SIGNPATH_INSTALLER_ARTIFACT_CONFIGURATION_SLUG')
    expect(signInstallerStep).toContain('signing-policy-slug: ${{ env.SIGNPATH_SIGNING_POLICY_SLUG }}')
    expect(restoreInstallerStep).toContain('Get-AuthenticodeSignature')
    expect(restoreInstallerStep).toContain('A trusted production signature is required')
    expect(refreshMetadataStep).toContain('scripts/refresh-windows-update-metadata.ts')
    expect(refreshMetadataStep).toContain('desktop/build-artifacts/electron/latest.yml')
    expect(applicationConfiguration).toContain('<pe-file path="Claude Code Haha.exe">')
    expect(applicationConfiguration).toContain('<pe-file path="claude-sidecar-*.exe">')
    expect(applicationConfiguration).toContain('<pe-file path="agent-desktop.exe">')
    expect(applicationConfiguration).not.toContain('rg.exe')
    expect(installerConfiguration).toContain('<pe-file path="Claude-Code-Haha-*-Windows-*-Setup.exe">')
    expect(extractStep(workflow, 'Stage unsigned Windows installer')).toContain(
      '$installerName = "Claude-Code-Haha-${{ steps.version.outputs.value }}-Windows-${{ matrix.arch }}-Setup.exe"',
    )
    expect(workflow).not.toContain('WINDOWS_CERTIFICATE')
    expect(workflow).not.toContain('WINDOWS_CERTIFICATE_PASSWORD')
    expect(workflow.indexOf('Restore and verify signed Windows application executables')).toBeLessThan(workflow.indexOf('Package NSIS installer from signed Windows application'))
    expect(workflow.indexOf('Restore and verify signed Windows installer')).toBeLessThan(workflow.indexOf('Refresh signed Windows blockmap and update metadata'))
    expect(workflow.indexOf('Refresh signed Windows blockmap and update metadata')).toBeLessThan(workflow.indexOf('Verify Windows installer execution'))
  })

  test('release workflow avoids same-name updater metadata uploads from matrix builds', () => {
    const workflow = readReleaseWorkflow()
    const namespaceStep = workflow.match(
      /- name: Namespace update metadata assets[\s\S]*?(?:\n\s{6}- name:|$)/,
    )?.[0]

    expect(namespaceStep).toContain('for file in latest*.yml')
    expect(namespaceStep).toContain('"${file%.yml}-${{ matrix.label }}.yml"')
    expect(workflow.indexOf('Namespace update metadata assets')).toBeLessThan(workflow.indexOf('Upload release artifacts for final publish'))
  })

  test('release workflow uploads only Actions artifacts from matrix builds', () => {
    const workflow = readReleaseWorkflow()
    const buildJob = extractJob(workflow, 'build')

    expect(buildJob).toContain('Validate matrix release asset set')
    for (const label of ['macOS-ARM64', 'macOS-x64', 'Linux-x64', 'Linux-ARM64', 'Windows-x64', 'Windows-ARM64']) {
      expect(buildJob).toContain(`${label})`)
    }
    expect(buildJob).toContain('target_triple: aarch64-pc-windows-msvc')
    expect(buildJob).toContain('builder_args: --win nsis --arm64')
    expect(buildJob).toContain('builder_args: --linux AppImage deb rpm --x64')
    expect(buildJob).toContain('builder_args: --linux AppImage deb rpm --arm64')
    expect(buildJob).toContain('Claude-Code-Haha-${APP_VERSION}-Windows-arm64-Setup.exe')
    expect(buildJob).toContain('Upload release artifacts for final publish')
    // Blockmaps stay on the runner for package-smoke; differential updates are disabled.
    expect(extractStep(buildJob ?? '', 'Upload release artifacts for final publish')).not.toContain('*.blockmap')
    expect(buildJob).toContain('actions/upload-artifact@v4')
    expect(buildJob).toContain('name: desktop-release-artifacts-${{ matrix.label }}')
    expect(buildJob).not.toContain('softprops/action-gh-release@v2')
    expect(buildJob).not.toContain('Load release notes')
  })

  test('no run can overwrite a release that is already published', async () => {
    const workflow = readReleaseWorkflow()
    const signingJob = extractJob(workflow, 'signing-preflight') ?? ''
    const publishJob = extractJob(workflow, 'publish-release') ?? ''
    const preflightGuard = extractStep(signingJob, 'Refuse to overwrite an existing published release')
    const publishGuard = extractStep(publishJob, 'Refuse to overwrite an existing published release')
    const guardRun = 'run: bash scripts/assert-release-unpublished.sh "${{ steps.version.outputs.value }}"'

    expect(workflow).toContain('publish_draft_release:')
    expect(workflow).toContain("description: 'Publish manual draft artifacts to GitHub Releases'")
    expect(publishJob).toContain("if: github.event_name == 'push' || inputs.draft == false || inputs.publish_draft_release == true")
    // Before any build: every run that will write to the release, including tag pushes.
    expect(preflightGuard).toContain("if: github.event_name == 'push' || inputs.draft == false || inputs.publish_draft_release == true")
    expect(preflightGuard).toContain(guardRun)
    expect(signingJob).toContain('scripts/assert-release-unpublished.sh\n')
    expect(signingJob.indexOf('Refuse to overwrite an existing published release')).toBeLessThan(
      signingJob.indexOf('Validate release signing and notarization secrets'),
    )
    // Right before uploading: unconditional, in case another ref published meanwhile.
    expect(publishGuard).not.toContain('if:')
    expect(publishGuard).toContain(guardRun)
    expect(publishJob.indexOf('Refuse to overwrite an existing published release')).toBeLessThan(publishJob.indexOf('Publish complete GitHub release'))

    const directory = mkdtempSync(join(tmpdir(), 'release-overwrite-guard-'))
    const fakeBin = join(directory, 'bin')
    mkdirSync(fakeBin)
    writeFileSync(join(fakeBin, 'gh'), [
      '#!/bin/sh',
      'echo "$@" >> "$FAKE_GH_LOG"',
      'case "$FAKE_GH_MODE" in',
      '  published) echo false ;;',
      '  draft) echo true ;;',
      "  missing) echo 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;",
      "  broken) echo 'gh: Server Error (HTTP 500)' >&2; exit 1 ;;",
      'esac',
      '',
    ].join('\n'))
    chmodSync(join(fakeBin, 'gh'), 0o755)
    const cases = [
      { mode: 'published', code: 1 },
      { mode: 'draft', code: 0 },
      { mode: 'missing', code: 0 },
      { mode: 'broken', code: 1 },
    ]
    try {
      for (const scenario of cases) {
        const log = join(directory, `gh-${scenario.mode}.log`)
        const result = Bun.spawnSync(['bash', 'scripts/assert-release-unpublished.sh', '0.7.7'], {
          env: {
            PATH: `${fakeBin}:${process.env.PATH}`,
            HOME: directory,
            GITHUB_REPOSITORY: 'NanmiCoder/cc-haha',
            FAKE_GH_MODE: scenario.mode,
            FAKE_GH_LOG: log,
          },
        })
        const output = `${result.stdout.toString()}${result.stderr.toString()}`
        expect(result.exitCode, `${scenario.mode}: ${output}`).toBe(scenario.code)
        expect(readFileSync(log, 'utf8')).toBe("api repos/NanmiCoder/cc-haha/releases/tags/v0.7.7 --jq .draft\n")
        if (scenario.mode === 'published') {
          expect(output).toContain('::error::Refusing to overwrite published release v0.7.7')
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('release workflow publishes all release assets only after all matrix builds pass', () => {
    const workflow = readReleaseWorkflow()
    const publishJob = extractJob(workflow, 'publish-release')

    expect(workflow).toContain('name: desktop-update-metadata-${{ matrix.label }}')
    expect(workflow).toContain('name: desktop-release-artifacts-${{ matrix.label }}')
    expect(publishJob).toContain('needs: build')
    expect(publishJob).toContain('actions/download-artifact@v4')
    expect(publishJob).toContain('pattern: desktop-release-artifacts-*')
    expect(publishJob).toContain('pattern: desktop-update-metadata-*')
    expect(publishJob).toContain('Validate complete release asset set')
    expect(publishJob).toContain('bun run scripts/release-update-metadata.ts --metadata-dir artifacts/update-metadata --out-dir artifacts/update-metadata-standard')
    expect(publishJob).toContain('Validate standard update metadata set')
    expect(publishJob).toContain('softprops/action-gh-release@v2')
    expect(publishJob).toContain('artifacts/release-assets/**/*.dmg')
    expect(publishJob).toContain('artifacts/release-assets/**/*.zip')
    expect(publishJob).toContain('artifacts/release-assets/**/*.exe')
    expect(publishJob).toContain('artifacts/release-assets/**/*.AppImage')
    expect(publishJob).toContain('artifacts/release-assets/**/*.deb')
    expect(publishJob).toContain('artifacts/release-assets/**/*.rpm')
    expect(publishJob).toContain('artifacts/update-metadata-standard/*.yml')
    // Not release assets: differential updates are disabled, and releases are
    // always Developer ID signed, so users never need the unsigned installer.
    expect(publishJob).not.toContain('*.blockmap')
    expect(publishJob).not.toContain('install-macos-unsigned.sh')
    expect(publishJob).toContain('draft: true')
    expect(publishJob).toContain('Publish GitHub release after complete upload')
    expect(publishJob).toContain("if: github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && inputs.draft == false)")
    expect(publishJob).toContain('gh release edit "v${{ steps.version.outputs.value }}" --draft=false --repo "${{ github.repository }}"')
    expect(publishJob).toContain('Keep workflow-dispatch release as draft')
    expect(publishJob).toContain("if: github.event_name == 'workflow_dispatch' && inputs.draft == true")
    expect(publishJob).toContain('release remains draft')
    expect(publishJob).toContain('fail_on_unmatched_files: true')
    expect(publishJob).toContain('Load release notes')
    expect(publishJob.indexOf('Publish complete GitHub release')).toBeLessThan(publishJob.indexOf('Publish GitHub release after complete upload'))
    expect(workflow.indexOf('publish-release:')).toBeGreaterThan(workflow.indexOf('build:'))
  })

  test('release workflow keeps updater-visible releases draft until every asset is uploaded', () => {
    const workflow = readReleaseWorkflow()
    const publishJob = extractJob(workflow, 'publish-release')

    expect(publishJob).toContain('draft: true')
    expect(publishJob).toContain('fail_on_unmatched_files: true')
    expect(publishJob).toContain('Publish GitHub release after complete upload')
    expect(publishJob).toContain('--draft=false')
    expect(publishJob.indexOf('Publish complete GitHub release')).toBeLessThan(publishJob.indexOf('Publish GitHub release after complete upload'))
    expect(publishJob.indexOf('Validate standard update metadata set')).toBeLessThan(publishJob.indexOf('Publish complete GitHub release'))
  })

  test('release asset names come from the packaging config and match every validated asset list', () => {
    const workflow = readReleaseWorkflow()
    const version = JSON.parse(readFileSync('desktop/package.json', 'utf8')).version as string
    const rows = releaseMatrix()
    const matrixStep = extractStep(workflow, 'Validate matrix release asset set') ?? ''
    const publishStep = extractStep(workflow, 'Validate complete release asset set') ?? ''
    const listed = (block: string | undefined) =>
      [...(block ?? '').matchAll(/"([^"]+)"/g)].map(match => match[1].replace('${APP_VERSION}', version))

    expect(rows.map(row => row.label).sort()).toEqual(Object.keys(RELEASE_CHANNELS).sort())
    const releaseAssets: string[] = []
    for (const row of rows) {
      // Matrix values are pasted into bash/pwsh unquoted, so electron-builder
      // macros must sit inside single quotes or the shell expands them away.
      expect(row.builder_args.replace(/'[^']*'/g, ''), row.label).not.toContain('$')
      const assets = packagedAssetNames(row, version)
      const block = matrixStep.match(new RegExp(`${row.label}\\)\\n\\s+expected=\\(([\\s\\S]*?)\\)`))?.[1]
      expect(listed(block).sort(), row.label).toEqual([...assets, RELEASE_CHANNELS[row.label]].sort())
      releaseAssets.push(...assets)
    }

    expect(releaseAssets.sort()).toEqual([
      `Claude-Code-Haha-${version}-Linux-arm64.AppImage`,
      `Claude-Code-Haha-${version}-Linux-arm64.deb`,
      `Claude-Code-Haha-${version}-Linux-arm64.rpm`,
      `Claude-Code-Haha-${version}-Linux-x64.AppImage`,
      `Claude-Code-Haha-${version}-Linux-x64.deb`,
      `Claude-Code-Haha-${version}-Linux-x64.rpm`,
      `Claude-Code-Haha-${version}-Windows-arm64-Setup.exe`,
      `Claude-Code-Haha-${version}-Windows-x64-Setup.exe`,
      `Claude-Code-Haha-${version}-macOS-Apple-Silicon.dmg`,
      `Claude-Code-Haha-${version}-macOS-Intel.dmg`,
      `Claude-Code-Haha-${version}-macOS-arm64-update.zip`,
      `Claude-Code-Haha-${version}-macOS-x64-update.zip`,
    ].sort())
    expect(listed(publishStep.match(/expected=\(([\s\S]*?)\)/)?.[1]).sort()).toEqual([...releaseAssets].sort())

    const namespacedMetadata = rows.map(row => RELEASE_CHANNELS[row.label].replace('.yml', `-${row.label}.yml`))
    const flattenedNames = [...releaseAssets, ...namespacedMetadata, ...new Set(Object.values(RELEASE_CHANNELS))]
    expect(new Set(flattenedNames).size).toBe(flattenedNames.length)
  })

  test('renamed release assets still let every installed client pick its own update', () => {
    const version = JSON.parse(readFileSync('desktop/package.json', 'utf8')).version as string
    const inputDir = mkdtempSync(join(tmpdir(), 'release-asset-names-in-'))
    const outputDir = mkdtempSync(join(tmpdir(), 'release-asset-names-out-'))
    const assetsByRow = new Map<string, string[]>()
    try {
      // Each matrix row writes its channel file the way electron-builder does,
      // then the real publish-job merge combines them.
      for (const row of releaseMatrix()) {
        const assets = packagedAssetNames(row, version)
        assetsByRow.set(row.label, assets)
        const files = assets.map(url => ({ url, sha512: `${url}-sha512`, size: 1 }))
        writeFileSync(
          join(inputDir, RELEASE_CHANNELS[row.label].replace('.yml', `-${row.label}.yml`)),
          stringify({ version, files, path: files[0].url, sha512: files[0].sha512, releaseDate: '2026-11-02T00:00:00.000Z' }),
        )
      }
      mergeUpdateMetadataArtifacts({ metadataDir: inputDir, outDir: outputDir })
      const channel = (name: string) =>
        (parse(readFileSync(join(outputDir, name), 'utf8')).files as Array<{ url: string }>).map(file => file.url)
      const rowAsset = (label: string, extension: string) =>
        assetsByRow.get(label)!.find(name => name.endsWith(`.${extension}`))

      const mac = channel('latest-mac.yml')
      expect(pickMacUpdate(mac, true, 'arm64'), 'Apple Silicon').toBe(rowAsset('macOS-ARM64', 'zip'))
      expect(pickMacUpdate(mac, true, 'x64'), 'Intel build under Rosetta').toBe(rowAsset('macOS-ARM64', 'zip'))
      expect(pickMacUpdate(mac, false, 'x64'), 'Intel').toBe(rowAsset('macOS-x64', 'zip'))

      const windows = channel('latest.yml')
      expect(findUpdateFile(windows, 'exe', 'x64'), 'Windows x64').toBe(rowAsset('Windows-x64', 'exe'))
      expect(findUpdateFile(windows, 'exe', 'arm64'), 'Windows ARM64').toBe(rowAsset('Windows-ARM64', 'exe'))

      // Linux clients read latest-linux.yml (x64) or latest-linux-arm64.yml.
      for (const [label, processArch, channelName] of [
        ['Linux-x64', 'x64', 'latest-linux.yml'],
        ['Linux-ARM64', 'arm64', 'latest-linux-arm64.yml'],
      ] as const) {
        const linux = channel(channelName)
        expect(findUpdateFile(linux, 'AppImage', processArch, ['rpm', 'deb', 'pacman']), `${label} AppImage`).toBe(rowAsset(label, 'AppImage'))
        expect(findUpdateFile(linux, 'deb', processArch, ['AppImage', 'rpm', 'pacman']), `${label} deb`).toBe(rowAsset(label, 'deb'))
        expect(findUpdateFile(linux, 'rpm', processArch, ['AppImage', 'deb', 'pacman']), `${label} rpm`).toBe(rowAsset(label, 'rpm'))
      }
    } finally {
      rmSync(inputDir, { recursive: true, force: true })
      rmSync(outputDir, { recursive: true, force: true })
    }
  })

  test('release workflow validates update metadata before publishing', () => {
    const workflow = readReleaseWorkflow()
    const buildJob = extractJob(workflow, 'build')
    const publishJob = extractJob(workflow, 'publish-release')

    for (const metadata of ['latest-mac.yml', 'latest-linux.yml', 'latest-linux-arm64.yml', 'latest.yml']) {
      expect(publishJob).toContain(`artifacts/update-metadata-standard/$file`)
      expect(publishJob).toContain(metadata)
    }
    expect(buildJob).not.toContain('.blockmap"')
    expect(publishJob).not.toContain('.blockmap"')
    expect(buildJob).toContain('latest-linux-arm64.yml')
    expect(buildJob).toContain('Missing release assets for %s')
    expect(publishJob).toContain('Missing complete release assets')
    expect(publishJob).toContain('Missing standard update metadata')
  })

  test('Electron Builder publish config does not rely on git remote autodetection', () => {
    const desktopPackage = JSON.parse(readFileSync('desktop/package.json', 'utf8')) as {
      build: {
        publish?: Array<{ provider?: string, owner?: string, repo?: string }>
        mac?: { publish?: unknown }
        win?: { publish?: unknown }
        linux?: { publish?: unknown }
      }
    }

    expect(desktopPackage.build.publish).toEqual([
      {
        provider: 'github',
        owner: 'NanmiCoder',
        repo: 'cc-haha',
      },
    ])
    expect(desktopPackage.build.mac?.publish).toBeUndefined()
    expect(desktopPackage.build.win?.publish).toBeUndefined()
    expect(desktopPackage.build.linux?.publish).toBeUndefined()
  })

  test('Electron Builder macOS config keeps the signed auto-update contract', () => {
    const desktopPackage = JSON.parse(readFileSync('desktop/package.json', 'utf8')) as {
      build: {
        mac?: {
          target?: string[]
          hardenedRuntime?: boolean
          notarize?: boolean
          entitlements?: string
          entitlementsInherit?: string
          signIgnore?: string[]
        }
      }
    }

    expect(desktopPackage.build.mac?.target).toEqual(['dmg', 'zip'])
    expect(desktopPackage.build.mac?.hardenedRuntime).toBe(true)
    expect(desktopPackage.build.mac?.notarize).toBe(true)
    expect(desktopPackage.build.mac?.entitlements).toBe('build/entitlements.mac.plist')
    expect(desktopPackage.build.mac?.entitlementsInherit).toBe('build/entitlements.mac.inherit.plist')
    // The Computer Use helper is excluded on purpose. `native/cu-helper/build.sh`
    // already signed it under the stable identity `dev.cchaha.cu-helper`, and
    // macOS ties the user's Accessibility and Screen Recording grants to that
    // signing identity — re-signing it here would rotate the identity and
    // silently drop both permissions on every update.
    //
    // The sidecar is excluded for a different reason — see the dedicated test
    // below, which states the causal chain this literal list cannot express.
    expect(desktopPackage.build.mac?.signIgnore).toEqual([
      '/Contents/Frameworks/.+\\.(?:pak|bin|dat|nib)$',
      '/Contents/Resources/.+\\.(?:asar|pak|bin|dat|icns|png|jpg|jpeg|gif|svg|ttf|woff|woff2)$',
      'cc-haha-computer-use\\.app',
      'claude-sidecar-[^/]+$',
    ])
  })

  // Regression: this entry was once dropped from signIgnore while the literal
  // assertion above was edited to match, so the suite stayed green and every
  // Computer Use call in the shipped build failed closed with
  // `unauthorized_client` — the settings page just said "checking…" forever.
  //
  // The causal chain: `build-sidecars.ts` signs the sidecar with an explicit
  // `--identifier com.claude-code-haha.desktop.sidecar`, because
  // `ClientAttestation.swift` compares that identifier EXACTLY when it walks the
  // helper -> sidecar -> desktop process chain. If electron-builder re-signs the
  // sidecar it drops that flag, and codesign falls back to deriving the
  // identifier from the file name (`claude-sidecar-aarch64-apple-darwin`), which
  // never matches. So this test asserts the behaviour (real sidecar file names
  // are excluded) rather than the spelling of one array element.
  test('macOS signIgnore keeps electron-builder off the attested sidecar', () => {
    const desktopPackage = JSON.parse(readFileSync('desktop/package.json', 'utf8')) as {
      build: { mac?: { signIgnore?: string[] } }
    }
    const patterns = (desktopPackage.build.mac?.signIgnore ?? []).map(
      p => new RegExp(p),
    )

    // Both architectures ship under these names; ClientAttestation.swift accepts
    // exactly these two, so both must survive electron-builder's signing pass.
    for (const sidecar of [
      '/Contents/Resources/app.asar.unpacked/src-tauri/binaries/claude-sidecar-aarch64-apple-darwin',
      '/Contents/Resources/app.asar.unpacked/src-tauri/binaries/claude-sidecar-x86_64-apple-darwin',
    ]) {
      expect(
        patterns.some(p => p.test(sidecar)),
        `${sidecar} must be in signIgnore, or electron-builder re-signs it and ` +
          'the attestation chain breaks',
      ).toBe(true)
    }

    // The identifier the exclusion exists to protect. If this constant moves,
    // ClientAttestation.swift's `sidecarIdentifier` has to move with it.
    expect(
      readFileSync('desktop/scripts/sign-identity.ts', 'utf8'),
    ).toContain("SIDECAR_SIGNING_IDENTIFIER = 'com.claude-code-haha.desktop.sidecar'")
    expect(
      readFileSync('native/cu-helper/Sources/cu-helper/ClientAttestation.swift', 'utf8'),
    ).toContain('sidecarIdentifier = "com.claude-code-haha.desktop.sidecar"')
  })

  test('Windows NSIS installer lets users choose the install directory', () => {
    const desktopPackage = JSON.parse(readFileSync('desktop/package.json', 'utf8')) as {
      build: {
        nsis?: {
          oneClick?: boolean
          allowToChangeInstallationDirectory?: boolean
        }
      }
    }

    expect(desktopPackage.build.nsis?.oneClick).toBe(false)
    expect(desktopPackage.build.nsis?.allowToChangeInstallationDirectory).toBe(true)
  })

  test('Windows NSIS installer recovers only registered legacy install-directory data', () => {
    const desktopPackage = JSON.parse(readFileSync('desktop/package.json', 'utf8')) as {
      scripts?: Record<string, string>
      build: {
        nsis?: {
          include?: string
        }
      }
    }

    expect(desktopPackage.build.nsis?.include).toBe('build/installer.nsh')
    expect(desktopPackage.scripts?.['test:windows-storage-recovery']).toContain('-SelfTest')

    const installerHook = readFileSync('desktop/build/installer.nsh', 'utf8')
    const recoveryHelper = readFileSync('desktop/build/recover-legacy-install-data.ps1', 'utf8')
    const normalizedRecoveryHelper = recoveryHelper.replace(/\r\n/g, '\n')
    expect(installerHook).toContain('!macro customInit')
    expect(installerHook).toContain('!macro customCheckAppRunning')
    expect(installerHook).toContain('!macro customPageAfterChangeDir')
    expect(installerHook).toContain('UAC_AsUser_Call Function CcHahaRecoverLegacy')
    expect(installerHook).toContain('${UAC_IsInnerInstance}')
    expect(installerHook).toContain('recover-legacy-install-data.ps1')
    expect(installerHook).toContain('ReadRegStr $4 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation')
    expect(installerHook).toContain('ReadRegStr $5 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation')
    expect(installerHook).toContain('Function CcHahaUninstallerParent')
    expect(installerHook).toContain('Function CcHahaFinalInstallDir')
    expect(installerHook).toContain('HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString')
    expect(installerHook).toContain('HKLM "${UNINSTALL_REGISTRY_KEY}" UninstallString')
    expect(installerHook).toContain('UNINSTALL_REGISTRY_KEY_2')
    expect(installerHook).toContain('ReadEnvStr $2 APPDATA')
    expect(installerHook).toContain('ReadEnvStr $3 USERPROFILE')
    expect(installerHook).toContain('ReadEnvStr $6 CLAUDE_CONFIG_DIR')
    expect(installerHook).toContain('ReadEnvStr $7 CC_HAHA_APP_PORTABLE_DIR')
    expect(installerHook).toContain('No registered installation needs legacy data recovery')
    expect(installerHook).toContain('Var ccHahaPerUserInstallLocation')
    expect(installerHook).toContain('Var ccHahaPerMachineInstallLocation')
    expect(installerHook).toMatch(/!macro CcHahaRunLegacyRecovery[\s\S]*ReadRegStr \$ccHahaPerUserInstallLocation[\s\S]*\$ccHahaPerUserUninstallString == ""[\s\S]*No registered installation needs legacy data recovery[\s\S]*Call CcHahaRecoverLegacy/)
    expect(installerHook).toContain('SetErrorLevel 20')
    expect(installerHook).toContain('/SD IDOK')
    expect(installerHook).toContain('Quit')
    expect(recoveryHelper).toContain('function Get-LegacyActiveSource')
    expect(recoveryHelper).toContain('function Get-PotentialInstallDirs')
    expect(recoveryHelper).toContain('param([AllowEmptyString()][string[]]$InstallDirs)')
    expect(recoveryHelper).toContain('function Assert-NoUndiscoveredLegacySources')
    expect(recoveryHelper).toContain('function Assert-NoRunningApplication')
    expect(recoveryHelper).toContain('function Get-TreeManifest')
    expect(recoveryHelper).toContain('function Assert-TreeManifestsEqual')
    expect(recoveryHelper).toContain('function Write-AppModeAtomically')
    expect(recoveryHelper).toContain('[IO.File]::Replace')
    expect(recoveryHelper).not.toContain('Add-Type')
    expect(recoveryHelper).toContain('function Assert-NoReparsePointInPath')
    expect(recoveryHelper).toContain('robocopy.exe')
    expect(recoveryHelper).not.toMatch(/\/XC|\/XN|\/XO/)
    expect(recoveryHelper).toContain('Multiple distinct legacy data sources')
    expect(recoveryHelper).toContain('Active CLAUDE_CONFIG_DIR is managed outside Claude Code Haha')
    expect(recoveryHelper).toContain('Test-LexicalPathAtOrBelow')
    expect(recoveryHelper).toContain('-SharedInstallDirs @($PerMachineInstallDir)')
    expect(normalizedRecoveryHelper).toContain("function Invoke-LegacyRecovery {\n  param(\n    [Parameter(Mandatory = $true)][AllowEmptyCollection()][AllowEmptyString()][string[]]$InstallDirs")
    expect(recoveryHelper).toContain('$installDirInputs.Count -eq 0')
    expect(recoveryHelper).toContain('$sharedInstallDirInputs.Count -gt 0')
    expect(recoveryHelper).toContain('per-user default-mode reinstall scanned the packaged application tree')
    expect(recoveryHelper).toContain('untrusted-elevated')
    expect(recoveryHelper).toContain('External CLAUDE_CONFIG_DIR is active while install-contained legacy data still exists')
    expect(recoveryHelper).toMatch(/\$source = Get-UnsafeLegacySource[\s\S]*Assert-NoRunningApplication/)
    expect(recoveryHelper).not.toMatch(/InstallerIdentitySafety -eq 'untrusted-elevated' -and\s+@\(Get-ExistingInstallDirs/)
    expect(recoveryHelper).toMatch(/Assert-TreeManifestsEqual[\s\S]*Assert-NoRunningApplication[\s\S]*Write-AppModeAtomically/)
    expect(recoveryHelper).toContain("AddSeconds(30)")
    expect(recoveryHelper).toContain('[Console]::Out.WriteLine("Legacy recovery error:')
    expect(recoveryHelper).toContain('reparse point')
    expect(recoveryHelper).toContain('Run-SelfTest')
  })

  test('Windows build and release jobs execute helper and compiled-installer smoke tests', () => {
    const devWorkflow = readFileSync('.github/workflows/build-desktop-dev.yml', 'utf8')
    const releaseWorkflow = readFileSync('.github/workflows/release-desktop.yml', 'utf8')
    const installerSmoke = readFileSync('desktop/scripts/windows-installer-smoke.ps1', 'utf8')

    for (const workflow of [devWorkflow, releaseWorkflow]) {
      expect(workflow).toContain("if: matrix.smoke_platform == 'windows'")
      expect(workflow).toContain('bun run test:windows-storage-recovery')
      expect(workflow).toContain("matrix.arch == 'x64'")
      expect(workflow).toContain('windows-installer-smoke.ps1')
    }

    expect(installerSmoke).toContain('Invoke-CheckedProcess')
    expect(installerSmoke).toContain('Invoke-LegacyRecoveryDiagnostic')
    expect(installerSmoke).toContain('Direct legacy recovery diagnostic completed successfully')
    expect(installerSmoke).toContain("@('/S', '/currentuser'")
    expect(installerSmoke).toContain("@('--updated', '/S', '/currentuser'")
    expect(installerSmoke).toContain('$process.WaitForExit($TimeoutSeconds * 1000)')
    expect(installerSmoke).not.toContain('-Wait -PassThru')
    expect(installerSmoke).toContain('$Stage starting...')
    expect(installerSmoke).toContain('$Stage completed successfully.')
    expect(installerSmoke).toContain('Fresh install did not create the application executable')
    expect(installerSmoke).toContain('Reinstall removed the application executable')
    expect(installerSmoke).toContain("'中文 安装目录\\Claude Code Haha'")
    expect(installerSmoke).toContain('Invoke-InstalledApplicationSmoke')
    expect(installerSmoke).toContain('CC_HAHA_ELECTRON_WINDOW_SMOKE_LOG')
    expect(installerSmoke).toContain('desktop-server-state.json')
    expect(installerSmoke).toContain('"reason":"after-final-show"')
    expect(installerSmoke).toContain('"http://127.0.0.1:$port/health"')
    expect(installerSmoke).toContain('"http://127.0.0.1:$port/"')
    expect(installerSmoke).toContain('Installed application Unicode-path smoke passed')

    const compiledSidecarSmoke = readFileSync(
      'desktop/scripts/build-sidecars.test.ts',
      'utf8',
    )
    expect(compiledSidecarSmoke).toContain("'中文 安装目录'")
    expect(compiledSidecarSmoke).toContain("'中文 用户目录'")
    expect(compiledSidecarSmoke).toContain('copyFile(builtExecutable, executable)')
  })
})
