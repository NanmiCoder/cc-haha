import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'

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
      /missing=\(\)[\s\S]*?# Drafts may remain unsigned/,
    )?.[0]
    expect(macRequiredBlock).not.toContain('if [ "$RELEASE_DRAFT" != "true" ]; then')
    expect(macRequiredBlock).toContain('exit 1')
    expect(signingJob).toContain('if [ "$RELEASE_DRAFT" != "true" ]; then')
    expect(signingJob).toContain('exit 1')
    expect(buildJob).toContain('- signing-preflight')
    expect(workflow.indexOf('signing-preflight:')).toBeLessThan(workflow.indexOf('build:'))
    expect(workflow.indexOf('signing-preflight:')).toBeLessThan(workflow.indexOf('Upload release artifacts for final publish'))
  })

  test('an explicit manual Windows signing skip preserves macOS and default release requirements', async () => {
    const workflow = parse(readReleaseWorkflow())
    expect(workflow.on.workflow_dispatch.inputs.skip_windows_signing).toEqual({
      description: 'Build unsigned Windows artifacts while SignPath onboarding is pending',
      required: false,
      default: false,
      type: 'boolean',
    })
    const preflight = workflow.jobs['signing-preflight'].steps.find((step: { id?: string }) => step.id === 'validate')
    expect(preflight.env.SKIP_WINDOWS_SIGNING).toBe("${{ github.event_name == 'workflow_dispatch' && inputs.skip_windows_signing == true }}")

    const directory = mkdtempSync(join(tmpdir(), 'release-signing-preflight-'))
    const configured = Object.fromEntries(Object.keys(preflight.env).map(key => [key, 'test-value']))
    const cases = [
      { name: 'configured release', env: {}, code: 0, outputs: 'macos_signed=true\nwindows_signed=true\n' },
      { name: 'explicit skip with configured SignPath', env: { SKIP_WINDOWS_SIGNING: 'true' }, code: 0, outputs: 'macos_signed=true\nwindows_signed=false\n' },
      { name: 'explicit skip without SignPath', env: { SKIP_WINDOWS_SIGNING: 'true', SIGNPATH_API_TOKEN: '' }, code: 0, outputs: 'macos_signed=true\nwindows_signed=false\n' },
      { name: 'release missing SignPath without skip', env: { SIGNPATH_API_TOKEN: '' }, code: 1, outputs: 'macos_signed=true\nwindows_signed=false\n' },
      { name: 'draft missing SignPath', env: { RELEASE_DRAFT: 'true', SIGNPATH_API_TOKEN: '' }, code: 0, outputs: 'macos_signed=true\nwindows_signed=false\n' },
      { name: 'explicit skip still requires macOS credentials', env: { SKIP_WINDOWS_SIGNING: 'true', CSC_LINK: '' }, code: 1, outputs: 'macos_signed=false\n' },
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
            SKIP_WINDOWS_SIGNING: 'false',
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
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }

    const unsignedBuild = extractStep(readReleaseWorkflow(), 'Build unsigned Electron release artifacts')
    expect(unsignedBuild).toContain("matrix.smoke_platform == 'windows' && needs.signing-preflight.outputs.windows_signed != 'true'")
    for (const name of ['Sign Windows application executables with SignPath', 'Sign Windows installer with SignPath']) {
      expect(extractStep(readReleaseWorkflow(), name)).toContain("needs.signing-preflight.outputs.windows_signed == 'true'")
    }
    expect(extractStep(readReleaseWorkflow(), 'Verify Windows installer execution')).not.toContain('windows_signed')
    expect(extractStep(readReleaseWorkflow(), 'Verify packaged app structure')).not.toContain('windows_signed')
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
    expect(stageApplicationStep).not.toContain('rg.exe')
    expect(stageApplicationStep).not.toContain('node-pty')
    expect(signApplicationStep).toContain('signpath/github-action-submit-signing-request@v2')
    expect(signApplicationStep).toContain('SIGNPATH_APPLICATION_ARTIFACT_CONFIGURATION_SLUG')
    expect(signApplicationStep).toContain('signing-policy-slug: ${{ env.SIGNPATH_SIGNING_POLICY_SLUG }}')
    expect(signApplicationStep).toContain('github-artifact-id: ${{ steps.upload-unsigned-signpath-application.outputs.artifact-id }}')
    expect(restoreApplicationStep).toContain('Get-AuthenticodeSignature')
    expect(restoreApplicationStep).toContain('REQUIRE_TRUSTED_WINDOWS_SIGNATURE')
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
    expect(applicationConfiguration).not.toContain('rg.exe')
    expect(installerConfiguration).toContain('<pe-file path="Claude-Code-Haha-*-win-*.exe">')
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
    expect(buildJob).toContain('Claude-Code-Haha-${APP_VERSION}-win-arm64.exe')
    expect(buildJob).toContain('Upload release artifacts for final publish')
    expect(buildJob).toContain('actions/upload-artifact@v4')
    expect(buildJob).toContain('name: desktop-release-artifacts-${{ matrix.label }}')
    expect(buildJob).not.toContain('softprops/action-gh-release@v2')
    expect(buildJob).not.toContain('Load release notes')
  })

  test('manual draft validation cannot overwrite an existing published release', () => {
    const workflow = readReleaseWorkflow()
    const publishJob = extractJob(workflow, 'publish-release')

    expect(workflow).toContain('publish_draft_release:')
    expect(workflow).toContain("description: 'Publish manual draft artifacts to GitHub Releases'")
    expect(publishJob).toContain("if: github.event_name == 'push' || inputs.draft == false || inputs.publish_draft_release == true")
    expect(publishJob).toContain('Refuse to overwrite an existing published release')
    expect(publishJob).toContain("if: github.event_name == 'workflow_dispatch' && inputs.draft == true")
    expect(publishJob).toContain('Refusing to overwrite published release v${{ steps.version.outputs.value }} with manual draft artifacts')
    expect(publishJob.indexOf('Refuse to overwrite an existing published release')).toBeLessThan(publishJob.indexOf('Publish complete GitHub release'))
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
    expect(publishJob).toContain('artifacts/release-assets/**/*.blockmap')
    expect(publishJob).toContain('artifacts/update-metadata-standard/*.yml')
    expect(publishJob).toContain('desktop/scripts/install-macos-unsigned.sh')
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

  test('release matrix asset basenames remain unique when final artifacts are flattened', () => {
    const desktopPackage = JSON.parse(readFileSync('desktop/package.json', 'utf8')) as {
      version: string
      build: {
        artifactName: string
      }
    }
    const version = desktopPackage.version
    expect(desktopPackage.build.artifactName).toBe('Claude-Code-Haha-${version}-${os}-${arch}.${ext}')

    const expectedReleaseAssets = [
      `Claude-Code-Haha-${version}-mac-arm64.dmg`,
      `Claude-Code-Haha-${version}-mac-arm64.dmg.blockmap`,
      `Claude-Code-Haha-${version}-mac-arm64.zip`,
      `Claude-Code-Haha-${version}-mac-arm64.zip.blockmap`,
      `Claude-Code-Haha-${version}-mac-x64.dmg`,
      `Claude-Code-Haha-${version}-mac-x64.dmg.blockmap`,
      `Claude-Code-Haha-${version}-mac-x64.zip`,
      `Claude-Code-Haha-${version}-mac-x64.zip.blockmap`,
      `Claude-Code-Haha-${version}-linux-x86_64.AppImage`,
      `Claude-Code-Haha-${version}-linux-amd64.deb`,
      `Claude-Code-Haha-${version}-linux-x86_64.rpm`,
      `Claude-Code-Haha-${version}-linux-arm64.AppImage`,
      `Claude-Code-Haha-${version}-linux-arm64.deb`,
      `Claude-Code-Haha-${version}-linux-aarch64.rpm`,
      `Claude-Code-Haha-${version}-win-x64.exe`,
      `Claude-Code-Haha-${version}-win-x64.exe.blockmap`,
      `Claude-Code-Haha-${version}-win-arm64.exe`,
      `Claude-Code-Haha-${version}-win-arm64.exe.blockmap`,
    ]
    const namespacedMetadata = [
      'latest-mac-macOS-ARM64.yml',
      'latest-mac-macOS-x64.yml',
      'latest-linux-Linux-x64.yml',
      'latest-linux-Linux-ARM64.yml',
      'latest-Windows-x64.yml',
    ]
    const standardMetadata = [
      'latest-mac.yml',
      'latest-linux.yml',
      'latest-linux-arm64.yml',
      'latest.yml',
    ]
    const flattenedNames = [
      ...expectedReleaseAssets,
      ...namespacedMetadata,
      ...standardMetadata,
    ]

    expect(new Set(flattenedNames).size).toBe(flattenedNames.length)
    expect(expectedReleaseAssets.filter((name) => name.endsWith('.dmg')).length).toBe(2)
    expect(expectedReleaseAssets.filter((name) => name.endsWith('.zip')).length).toBe(2)
    expect(expectedReleaseAssets.filter((name) => name.endsWith('.AppImage')).length).toBe(2)
    expect(expectedReleaseAssets.filter((name) => name.endsWith('.deb')).length).toBe(2)
    expect(expectedReleaseAssets.filter((name) => name.endsWith('.rpm')).length).toBe(2)
    expect(expectedReleaseAssets.filter((name) => name.endsWith('.exe')).length).toBe(2)
    expect(expectedReleaseAssets.some((name) => name.includes('-linux-') && name.endsWith('.blockmap'))).toBe(false)
    for (const platform of ['mac', 'linux', 'win']) {
      expect(expectedReleaseAssets.some((name) => name.includes(`-${platform}-`))).toBe(true)
    }
    expect(standardMetadata).toEqual([
      'latest-mac.yml',
      'latest-linux.yml',
      'latest-linux-arm64.yml',
      'latest.yml',
    ])
  })

  test('release workflow validates exact expected release assets and update metadata before publishing', () => {
    const workflow = readReleaseWorkflow()
    const buildJob = extractJob(workflow, 'build')
    const publishJob = extractJob(workflow, 'publish-release')
    const expectedFiles = [
      'Claude-Code-Haha-${APP_VERSION}-mac-arm64.dmg',
      'Claude-Code-Haha-${APP_VERSION}-mac-arm64.zip',
      'Claude-Code-Haha-${APP_VERSION}-mac-x64.dmg',
      'Claude-Code-Haha-${APP_VERSION}-mac-x64.zip',
      'Claude-Code-Haha-${APP_VERSION}-linux-x86_64.AppImage',
      'Claude-Code-Haha-${APP_VERSION}-linux-amd64.deb',
      'Claude-Code-Haha-${APP_VERSION}-linux-x86_64.rpm',
      'Claude-Code-Haha-${APP_VERSION}-linux-arm64.AppImage',
      'Claude-Code-Haha-${APP_VERSION}-linux-arm64.deb',
      'Claude-Code-Haha-${APP_VERSION}-linux-aarch64.rpm',
      'Claude-Code-Haha-${APP_VERSION}-win-x64.exe',
      'Claude-Code-Haha-${APP_VERSION}-win-x64.exe.blockmap',
      'Claude-Code-Haha-${APP_VERSION}-win-arm64.exe',
      'Claude-Code-Haha-${APP_VERSION}-win-arm64.exe.blockmap',
    ]

    for (const file of expectedFiles) {
      expect(buildJob).toContain(file)
      expect(publishJob).toContain(file)
    }
    for (const metadata of ['latest-mac.yml', 'latest-linux.yml', 'latest-linux-arm64.yml', 'latest.yml']) {
      expect(publishJob).toContain(`artifacts/update-metadata-standard/$file`)
      expect(publishJob).toContain(metadata)
    }
    expect(buildJob).not.toContain('linux-x64.AppImage.blockmap')
    expect(buildJob).not.toContain('linux-arm64.AppImage.blockmap')
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
