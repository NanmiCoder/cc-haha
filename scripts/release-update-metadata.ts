#!/usr/bin/env bun

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { parse, stringify } from 'yaml'

type UpdateFileMetadata = {
  url?: string
  sha512?: string
  sha2?: string
  size?: number
  [key: string]: unknown
}

type UpdateMetadata = {
  version?: string
  files?: UpdateFileMetadata[]
  path?: string
  sha512?: string
  sha2?: string
  releaseDate?: string
  [key: string]: unknown
}

type MetadataEntry = {
  sourcePath: string
  canonicalName: string
  metadata: UpdateMetadata
}

export type MergeUpdateMetadataOptions = {
  metadataDir: string
  outDir: string
}

export type MergeUpdateMetadataResult = {
  writtenFiles: string[]
}

function usage() {
  return 'Usage: bun run scripts/release-update-metadata.ts --metadata-dir <dir> --out-dir <dir>'
}

function readArgValue(argv: string[], index: number, flag: string) {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}\n${usage()}`)
  }
  return value
}

function parseArgs(argv: string[]): MergeUpdateMetadataOptions {
  let metadataDir: string | undefined
  let outDir: string | undefined

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--metadata-dir') {
      metadataDir = readArgValue(argv, index, arg)
      index += 1
      continue
    }
    if (arg === '--out-dir') {
      outDir = readArgValue(argv, index, arg)
      index += 1
      continue
    }
  }

  if (!metadataDir || !outDir) {
    throw new Error(usage())
  }

  return { metadataDir, outDir }
}

function walkMetadataFiles(rootDir: string) {
  if (!existsSync(rootDir)) {
    return [] as string[]
  }

  const files: string[] = []
  const stack = [rootDir]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue

    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
      } else if (/^latest.*\.ya?ml$/i.test(entry.name)) {
        files.push(fullPath)
      }
    }
  }

  return files.sort()
}

function readMetadata(filePath: string): UpdateMetadata {
  const parsed = parse(readFileSync(filePath, 'utf8')) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Update metadata must be a YAML object: ${filePath}`)
  }
  return parsed as UpdateMetadata
}

function metadataHaystack(fileName: string, metadata: UpdateMetadata) {
  const fileUrls = Array.isArray(metadata.files)
    ? metadata.files.map(file => file.url ?? '').join(' ')
    : ''
  return `${fileName} ${metadata.path ?? ''} ${fileUrls}`.toLowerCase()
}

function canonicalChannelName(filePath: string, metadata: UpdateMetadata) {
  const fileName = basename(filePath).replace(/\.ya?ml$/i, '')
  if (fileName.startsWith('latest-mac')) {
    return 'latest-mac.yml'
  }
  if (fileName.startsWith('latest-linux')) {
    const haystack = metadataHaystack(fileName, metadata)
    return /(?:^|[-_])(?:arm64|aarch64)(?:$|[-_.])/.test(haystack)
      ? 'latest-linux-arm64.yml'
      : 'latest-linux.yml'
  }
  if (fileName.startsWith('latest')) {
    return 'latest.yml'
  }
  return null
}

function metadataFiles(metadata: UpdateMetadata, sourcePath: string) {
  const files = Array.isArray(metadata.files) && metadata.files.length > 0
    ? metadata.files
    : metadata.path
      ? [{ url: metadata.path, sha512: metadata.sha512, sha2: metadata.sha2 }]
      : []

  if (files.length === 0) {
    throw new Error(`No update files found in ${sourcePath}`)
  }

  return files.map((file) => {
    if (!file.url) {
      throw new Error(`Update file entry is missing url in ${sourcePath}`)
    }
    if (!file.sha512 && !file.sha2) {
      throw new Error(`Update file entry is missing checksum for ${file.url} in ${sourcePath}`)
    }
    return file
  })
}

function archRank(url: string) {
  const lowerUrl = url.toLowerCase()
  if (/(^|[-_.])(?:x64|x86_64|amd64)($|[-_.])/.test(lowerUrl)) return 0
  if (/(^|[-_.])arm64($|[-_.])|(^|[-_.])aarch64($|[-_.])/.test(lowerUrl)) return 1
  if (/(^|[-_.])ia32($|[-_.])/.test(lowerUrl)) return 2
  return 3
}

function artifactRank(canonicalName: string, url: string) {
  const lowerUrl = url.toLowerCase()
  if (canonicalName === 'latest-mac.yml') {
    if (lowerUrl.endsWith('.zip')) return 0
    if (lowerUrl.endsWith('.dmg')) return 1
    return 2
  }
  if (canonicalName.startsWith('latest-linux')) {
    if (lowerUrl.endsWith('.appimage')) return 0
    if (lowerUrl.endsWith('.deb')) return 1
    return 2
  }
  return 2
}

function sortUpdateFiles(canonicalName: string, files: UpdateFileMetadata[]) {
  return [...files].sort((left, right) => {
    const leftUrl = left.url ?? ''
    const rightUrl = right.url ?? ''
    return archRank(leftUrl) - archRank(rightUrl)
      || artifactRank(canonicalName, leftUrl) - artifactRank(canonicalName, rightUrl)
      || leftUrl.localeCompare(rightUrl)
  })
}

function latestReleaseDate(entries: MetadataEntry[]) {
  const dates = entries
    .map(entry => entry.metadata.releaseDate)
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .sort()
  return dates.at(-1)
}

function mergeEntries(entries: MetadataEntry[]) {
  const [first] = entries
  if (!first) {
    throw new Error('Cannot merge an empty update metadata group')
  }

  const version = first.metadata.version
  for (const entry of entries) {
    if (entry.metadata.version !== version) {
      throw new Error(
        `Cannot merge update metadata with different versions for ${entry.canonicalName}: ${version} vs ${entry.metadata.version}`,
      )
    }
  }

  const filesByUrl = new Map<string, UpdateFileMetadata>()
  for (const entry of entries) {
    for (const file of metadataFiles(entry.metadata, entry.sourcePath)) {
      const existing = filesByUrl.get(file.url ?? '')
      if (existing && (existing.sha512 ?? existing.sha2) !== (file.sha512 ?? file.sha2)) {
        throw new Error(`Conflicting checksums for update artifact ${file.url}`)
      }
      filesByUrl.set(file.url ?? '', file)
    }
  }

  const files = sortUpdateFiles(first.canonicalName, [...filesByUrl.values()])
  const primaryFile = files[0]
  const merged: UpdateMetadata = {
    ...first.metadata,
    files,
    path: primaryFile.url,
    sha512: primaryFile.sha512,
  }
  if (primaryFile.sha2) {
    merged.sha2 = primaryFile.sha2
  } else {
    delete merged.sha2
  }

  const releaseDate = latestReleaseDate(entries)
  if (releaseDate) {
    merged.releaseDate = releaseDate
  }

  return merged
}

export function mergeUpdateMetadataArtifacts(options: MergeUpdateMetadataOptions): MergeUpdateMetadataResult {
  const metadataDir = resolve(options.metadataDir)
  const outDir = resolve(options.outDir)
  const metadataFiles = walkMetadataFiles(metadataDir)
  if (metadataFiles.length === 0) {
    throw new Error(`No latest*.yml metadata files found in ${metadataDir}`)
  }

  const groups = new Map<string, MetadataEntry[]>()
  for (const sourcePath of metadataFiles) {
    const metadata = readMetadata(sourcePath)
    const canonicalName = canonicalChannelName(sourcePath, metadata)
    if (!canonicalName) continue

    const entries = groups.get(canonicalName) ?? []
    entries.push({ sourcePath, canonicalName, metadata })
    groups.set(canonicalName, entries)
  }

  if (groups.size === 0) {
    throw new Error(`No recognized update metadata files found in ${metadataDir}`)
  }

  mkdirSync(outDir, { recursive: true })
  const writtenFiles: string[] = []
  for (const [canonicalName, entries] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const outputPath = join(outDir, canonicalName)
    writeFileSync(outputPath, stringify(mergeEntries(entries)))
    writtenFiles.push(outputPath)
  }

  return { writtenFiles }
}

if (import.meta.main) {
  try {
    const result = mergeUpdateMetadataArtifacts(parseArgs(process.argv.slice(2)))
    for (const file of result.writtenFiles) {
      console.log(`[release-update-metadata] wrote ${relative(process.cwd(), file)}`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    process.exit(1)
  }
}
