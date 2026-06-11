import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

describe('release desktop workflow', () => {
  function readReleaseWorkflow() {
    return readFileSync('.github/workflows/release-desktop.yml', 'utf8')
  }

  function extractJob(workflow: string, jobName: string) {
    return workflow.match(
      new RegExp(`${jobName}:[\\s\\S]*?(?:\\n {2}[a-zA-Z0-9_-]+:|$)`),
    )?.[0]
  }

  test('release packaging does not run the PR-quality gate', () => {
    const workflow = readReleaseWorkflow()

    // Quality gates run on PRs, not at release time: tagging should not be
    // blocked by `bun run verify`. Releasing is gated on the tag only.
    expect(workflow).not.toContain('quality-preflight')
    expect(workflow).not.toContain('bun run verify')
    expect(workflow).toContain('name: Build (${{ matrix.label }})')
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

      expect(workflow).toContain('Build Electron')
      expect(workflow).toContain('smoke_platform')
      expect(workflow).toContain('bun run test:package-smoke --platform ${{ matrix.smoke_platform }} --package-kind release --artifacts-dir desktop/build-artifacts/electron')
      expect(workflow).not.toContain('tauri-apps/tauri-action@v0')
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
    // This fork (706412584/cc-haha) republishes desktop builds under its own
    // GitHub homepage while keeping NanmiCoder's author attribution. Upstream
    // (NanmiCoder/cc-haha) uses its own homepage; both are valid release-time
    // shapes, so accept either.
    expect(desktopPackage.homepage).toMatch(/^https:\/\/github\.com\/[^/]+\/cc-haha$/)
    expect(desktopPackage.author?.name).toBe('NanmiCoder')
    expect(desktopPackage.author?.email).toBe('relakkes@gmail.com')
    expect(desktopPackage.build?.linux?.maintainer).toBe('NanmiCoder <relakkes@gmail.com>')
  })

  test('release workflow requires macOS Gatekeeper launch approval for signed builds', () => {
    const workflow = readReleaseWorkflow()
    const gatekeeperStep = workflow.match(
      /- name: Verify macOS launch policy[\s\S]*?(?:\n\s{6}- name:|$)/,
    )?.[0]
    const unsignedWarningStep = workflow.match(
      /- name: Warn unsigned macOS launch policy skipped[\s\S]*?(?:\n\s{6}- name:|$)/,
    )?.[0]

    expect(gatekeeperStep).toContain("if: matrix.smoke_platform == 'macos' && needs.signing-preflight.outputs.macos_signed == 'true'")
    expect(gatekeeperStep).toContain('bun run test:package-smoke --platform macos --package-kind release --artifacts-dir desktop/build-artifacts/electron --require-macos-gatekeeper')
    expect(unsignedWarningStep).toContain("if: matrix.smoke_platform == 'macos' && needs.signing-preflight.outputs.macos_signed != 'true'")
    expect(unsignedWarningStep).toContain('install-macos-unsigned.sh')
    expect(workflow.indexOf('Verify macOS launch policy')).toBeLessThan(workflow.indexOf('Upload release artifacts for final publish'))
  })

  test('release workflow records macOS signing state and warns for unsigned builds', () => {
    const workflow = readReleaseWorkflow()
    const signingJob = workflow.match(
      /signing-preflight:[\s\S]*?(?:\n {2}[a-zA-Z0-9_-]+:|$)/,
    )?.[0]
    const buildJob = extractJob(workflow, 'build')

    expect(signingJob).toContain('Validate release signing and notarization secrets')
    expect(signingJob).toContain('outputs:')
    expect(signingJob).toContain('macos_signed: ${{ steps.validate.outputs.macos_signed }}')
    for (const secret of [
      'MACOS_CERTIFICATE',
      'MACOS_CERTIFICATE_PASSWORD',
      'APPLE_ID',
      'APPLE_APP_SPECIFIC_PASSWORD',
      'APPLE_TEAM_ID',
    ]) {
      expect(signingJob).toContain(secret)
    }
    for (const secret of [
      'WINDOWS_CERTIFICATE',
      'WINDOWS_CERTIFICATE_PASSWORD',
    ]) {
      expect(signingJob).toContain(secret)
    }
    expect(signingJob).toContain('Missing macOS signing/notarization secrets')
    expect(signingJob).toContain('macOS artifacts will be unsigned')
    expect(signingJob).toContain('install-macos-unsigned.sh')
    expect(signingJob).toContain('macos_signed=false')
    expect(signingJob).toContain('macos_signed=true')
    expect(signingJob).toContain('Windows signing secrets missing')
    expect(signingJob).toContain('::warning::Windows signing secrets missing')

    const macRequiredBlock = signingJob?.match(
      /missing=\(\)[\s\S]*?# Windows signing is optional:/,
    )?.[0]
    const windowsOptionalBlock = signingJob?.match(
      /win_missing=\(\)[\s\S]*?fi\n/,
    )?.[0]
    expect(macRequiredBlock).not.toContain('exit 1')
    expect(windowsOptionalBlock).toContain('::warning::')
    expect(windowsOptionalBlock).not.toContain('exit 1')
    expect(buildJob).toContain('- signing-preflight')
    expect(workflow.indexOf('signing-preflight:')).toBeLessThan(workflow.indexOf('build:'))
    expect(workflow.indexOf('signing-preflight:')).toBeLessThan(workflow.indexOf('Upload release artifacts for final publish'))
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
    for (const label of ['macOS-ARM64', 'macOS-x64', 'Linux-x64', 'Linux-ARM64', 'Windows-x64']) {
      expect(buildJob).toContain(`${label})`)
    }
    expect(buildJob).toContain('Upload release artifacts for final publish')
    expect(buildJob).toContain('actions/upload-artifact@v4')
    expect(buildJob).toContain('name: desktop-release-artifacts-${{ matrix.label }}')
    expect(buildJob).not.toContain('softprops/action-gh-release@v2')
    expect(buildJob).not.toContain('Load release notes')
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
    expect(publishJob).toContain('artifacts/release-assets/**/*.exe')
    expect(publishJob).toContain('artifacts/release-assets/**/*.AppImage')
    expect(publishJob).toContain('artifacts/update-metadata-standard/*.yml')
    expect(publishJob).toContain('desktop/scripts/install-macos-unsigned.sh')
    expect(publishJob).toContain('fail_on_unmatched_files: true')
    expect(publishJob).toContain('Load release notes')
    expect(workflow.indexOf('publish-release:')).toBeGreaterThan(workflow.indexOf('build:'))
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
      `Claude-Code-Haha-${version}-linux-arm64.AppImage`,
      `Claude-Code-Haha-${version}-linux-arm64.deb`,
      `Claude-Code-Haha-${version}-win-x64.exe`,
      `Claude-Code-Haha-${version}-win-x64.exe.blockmap`,
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
    expect(expectedReleaseAssets.filter((name) => name.endsWith('.exe')).length).toBe(1)
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
      'Claude-Code-Haha-${APP_VERSION}-linux-arm64.AppImage',
      'Claude-Code-Haha-${APP_VERSION}-linux-arm64.deb',
      'Claude-Code-Haha-${APP_VERSION}-win-x64.exe',
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

    // The fork (706412584/cc-haha) republishes desktop builds under its own
    // GitHub owner; upstream (NanmiCoder/cc-haha) uses its own. Both are
    // valid release-time shapes — we only require that publish is pinned to
    // GitHub with explicit owner/repo (no autodetect from git remote).
    expect(desktopPackage.build.publish).toHaveLength(1)
    expect(desktopPackage.build.publish?.[0]).toEqual(
      expect.objectContaining({
        provider: 'github',
        owner: expect.stringMatching(/^[\w-]+$/),
        repo: 'cc-haha',
      }),
    )
    expect(desktopPackage.build.mac?.publish).toBeUndefined()
    expect(desktopPackage.build.win?.publish).toBeUndefined()
    expect(desktopPackage.build.linux?.publish).toBeUndefined()
  })
})
