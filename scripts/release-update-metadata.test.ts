import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { mergeUpdateMetadataArtifacts } from './release-update-metadata'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'cc-haha-release-metadata-'))
}

function writeYaml(path: string, content: string) {
  writeFileSync(path, content.trimStart().replace(/^ {6}/gm, ''))
}

describe('release update metadata merge', () => {
  test('merges namespaced macOS x64 and arm64 metadata into standard latest-mac.yml', () => {
    const inputDir = tempDir()
    const outputDir = tempDir()

    writeYaml(join(inputDir, 'latest-mac-macOS-ARM64.yml'), `
      version: 0.3.2
      files:
        - url: Claude-Code-Haha-0.3.2-arm64.zip
          sha512: arm64-checksum
          size: 222
      path: Claude-Code-Haha-0.3.2-arm64.zip
      sha512: arm64-checksum
      releaseDate: '2026-06-01T02:00:00.000Z'
    `)
    writeYaml(join(inputDir, 'latest-mac-macOS-x64.yml'), `
      version: 0.3.2
      files:
        - url: Claude-Code-Haha-0.3.2-x64.zip
          sha512: x64-checksum
          size: 111
      path: Claude-Code-Haha-0.3.2-x64.zip
      sha512: x64-checksum
      releaseDate: '2026-06-01T01:00:00.000Z'
    `)

    const result = mergeUpdateMetadataArtifacts({ metadataDir: inputDir, outDir: outputDir })
    expect(result.writtenFiles.map(file => file.endsWith('latest-mac.yml'))).toContain(true)

    const merged = parse(readFileSync(join(outputDir, 'latest-mac.yml'), 'utf8')) as {
      files: Array<{ url: string, sha512: string, size: number }>
      path: string
      sha512: string
      releaseDate: string
    }

    expect(merged.files.map(file => file.url)).toEqual([
      'Claude-Code-Haha-0.3.2-x64.zip',
      'Claude-Code-Haha-0.3.2-arm64.zip',
    ])
    expect(merged.path).toBe('Claude-Code-Haha-0.3.2-x64.zip')
    expect(merged.sha512).toBe('x64-checksum')
    expect(merged.releaseDate).toBe('2026-06-01T02:00:00.000Z')
  })

  test('keeps macOS zip metadata primary when each architecture has dmg and zip files', () => {
    const inputDir = tempDir()
    const outputDir = tempDir()

    writeYaml(join(inputDir, 'latest-mac-macOS-ARM64.yml'), `
      version: 0.3.2
      files:
        - url: Claude-Code-Haha-0.3.2-arm64.dmg
          sha512: arm64-dmg-checksum
          size: 444
        - url: Claude-Code-Haha-0.3.2-arm64.zip
          sha512: arm64-zip-checksum
          size: 333
      path: Claude-Code-Haha-0.3.2-arm64.zip
      sha512: arm64-zip-checksum
    `)
    writeYaml(join(inputDir, 'latest-mac-macOS-x64.yml'), `
      version: 0.3.2
      files:
        - url: Claude-Code-Haha-0.3.2-x64.dmg
          sha512: x64-dmg-checksum
          size: 222
        - url: Claude-Code-Haha-0.3.2-x64.zip
          sha512: x64-zip-checksum
          size: 111
      path: Claude-Code-Haha-0.3.2-x64.zip
      sha512: x64-zip-checksum
    `)

    mergeUpdateMetadataArtifacts({ metadataDir: inputDir, outDir: outputDir })

    const merged = parse(readFileSync(join(outputDir, 'latest-mac.yml'), 'utf8')) as {
      files: Array<{ url: string, sha512: string }>
      path: string
      sha512: string
    }

    expect(merged.files.map(file => file.url)).toEqual([
      'Claude-Code-Haha-0.3.2-x64.zip',
      'Claude-Code-Haha-0.3.2-x64.dmg',
      'Claude-Code-Haha-0.3.2-arm64.zip',
      'Claude-Code-Haha-0.3.2-arm64.dmg',
    ])
    expect(merged.path).toBe('Claude-Code-Haha-0.3.2-x64.zip')
    expect(merged.sha512).toBe('x64-zip-checksum')
  })

  test('restores standard linux channel names for x64 and arm64 metadata', () => {
    const inputDir = tempDir()
    const outputDir = tempDir()

    writeYaml(join(inputDir, 'latest-linux-Linux-x64.yml'), `
      version: 0.3.2
      files:
        - url: Claude-Code-Haha-0.3.2-x64.AppImage
          sha512: linux-x64-checksum
          size: 111
      path: Claude-Code-Haha-0.3.2-x64.AppImage
      sha512: linux-x64-checksum
    `)
    writeYaml(join(inputDir, 'latest-linux-Linux-ARM64.yml'), `
      version: 0.3.2
      files:
        - url: Claude-Code-Haha-0.3.2-arm64.AppImage
          sha512: linux-arm64-checksum
          size: 222
      path: Claude-Code-Haha-0.3.2-arm64.AppImage
      sha512: linux-arm64-checksum
    `)

    mergeUpdateMetadataArtifacts({ metadataDir: inputDir, outDir: outputDir })

    const x64 = parse(readFileSync(join(outputDir, 'latest-linux.yml'), 'utf8')) as { path: string }
    const arm64 = parse(readFileSync(join(outputDir, 'latest-linux-arm64.yml'), 'utf8')) as { path: string }
    expect(x64.path).toBe('Claude-Code-Haha-0.3.2-x64.AppImage')
    expect(arm64.path).toBe('Claude-Code-Haha-0.3.2-arm64.AppImage')
  })

  test('keeps Linux AppImage as primary update artifact when deb is also published', () => {
    const inputDir = tempDir()
    const outputDir = tempDir()

    writeYaml(join(inputDir, 'latest-linux-Linux-x64.yml'), `
      version: 0.3.2
      files:
        - url: Claude-Code-Haha-0.3.2-linux-amd64.deb
          sha512: linux-deb-checksum
          size: 222
        - url: Claude-Code-Haha-0.3.2-linux-x86_64.AppImage
          sha512: linux-appimage-checksum
          size: 111
      path: Claude-Code-Haha-0.3.2-linux-amd64.deb
      sha512: linux-deb-checksum
    `)

    mergeUpdateMetadataArtifacts({ metadataDir: inputDir, outDir: outputDir })

    const x64 = parse(readFileSync(join(outputDir, 'latest-linux.yml'), 'utf8')) as {
      files: Array<{ url: string, sha512: string }>
      path: string
      sha512: string
    }
    expect(x64.files.map(file => file.url)).toEqual([
      'Claude-Code-Haha-0.3.2-linux-x86_64.AppImage',
      'Claude-Code-Haha-0.3.2-linux-amd64.deb',
    ])
    expect(x64.path).toBe('Claude-Code-Haha-0.3.2-linux-x86_64.AppImage')
    expect(x64.sha512).toBe('linux-appimage-checksum')
  })

  test('restores standard Windows channel metadata after matrix namespacing', () => {
    const inputDir = tempDir()
    const outputDir = tempDir()

    writeYaml(join(inputDir, 'latest-Windows-x64.yml'), `
      version: 0.3.2
      files:
        - url: Claude-Code-Haha-0.3.2-win-x64.exe
          sha512: win-checksum
          size: 333
      path: Claude-Code-Haha-0.3.2-win-x64.exe
      sha512: win-checksum
    `)

    mergeUpdateMetadataArtifacts({ metadataDir: inputDir, outDir: outputDir })

    const windows = parse(readFileSync(join(outputDir, 'latest.yml'), 'utf8')) as {
      files: Array<{ url: string, sha512: string }>
      path: string
      sha512: string
    }
    expect(windows.files.map(file => file.url)).toEqual(['Claude-Code-Haha-0.3.2-win-x64.exe'])
    expect(windows.path).toBe('Claude-Code-Haha-0.3.2-win-x64.exe')
    expect(windows.sha512).toBe('win-checksum')
  })

  test('rejects metadata groups with mixed app versions', () => {
    const inputDir = tempDir()
    const outputDir = tempDir()

    writeYaml(join(inputDir, 'latest-mac-macOS-x64.yml'), `
      version: 0.3.2
      files:
        - url: Claude-Code-Haha-0.3.2-x64.zip
          sha512: x64-checksum
    `)
    writeYaml(join(inputDir, 'latest-mac-macOS-ARM64.yml'), `
      version: 0.3.3
      files:
        - url: Claude-Code-Haha-0.3.3-arm64.zip
          sha512: arm64-checksum
    `)

    expect(() => mergeUpdateMetadataArtifacts({ metadataDir: inputDir, outDir: outputDir }))
      .toThrow('Cannot merge update metadata with different versions')
  })
})
