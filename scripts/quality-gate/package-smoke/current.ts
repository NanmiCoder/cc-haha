#!/usr/bin/env bun

import { spawnSync } from 'node:child_process'

export function currentPackageSmokePlatform(platform: NodeJS.Platform = process.platform) {
  if (platform === 'darwin') return 'macos'
  if (platform === 'win32') return 'windows'
  if (platform === 'linux') return 'linux'
  return null
}

export function currentPackageSmokeArch(arch: NodeJS.Architecture = process.arch) {
  return arch === 'arm64' || arch === 'x64' ? arch : null
}

if (import.meta.main) {
  const platform = currentPackageSmokePlatform()
  if (!platform) {
    console.log(`[package-smoke] skipping unsupported host platform: ${process.platform}`)
    process.exit(0)
  }

  const args = [
    'run',
    'test:package-smoke',
    '--platform',
    platform,
    '--package-kind',
    'dir',
    '--artifacts-dir',
    'desktop/build-artifacts/electron',
  ]
  const arch = currentPackageSmokeArch()
  if (arch) {
    args.push('--arch', arch)
  }

  const result = spawnSync(process.execPath, args, {
    stdio: 'inherit',
  })
  process.exit(result.status ?? 1)
}
