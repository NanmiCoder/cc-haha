import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type QuarantineEntry = {
  id: string
  path: string
  reason: string
  owner: string
  reviewAfter: string
  exitCriteria: string
}

export type QuarantineManifest = {
  quarantined: QuarantineEntry[]
}

const defaultManifestPath = join(dirname(fileURLToPath(import.meta.url)), 'quarantine.json')

export function loadQuarantineManifest(path = defaultManifestPath, options: { enforceReviewDate?: boolean; asOf?: Date } = {}): QuarantineManifest {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as QuarantineManifest
  validateQuarantineManifest(manifest, options)
  return manifest
}

export function expiredQuarantineEntries(manifest: QuarantineManifest, asOf = new Date()) {
  return manifest.quarantined.filter((entry) => {
    const reviewAfter = new Date(`${entry.reviewAfter}T23:59:59.999Z`)
    return Number.isNaN(reviewAfter.getTime()) || reviewAfter < asOf
  })
}

export function validateQuarantineManifest(manifest: QuarantineManifest, options: { enforceReviewDate?: boolean; asOf?: Date } = {}) {
  if (!Array.isArray(manifest.quarantined)) {
    throw new Error('quarantine manifest must contain a quarantined array')
  }

  const ids = new Set<string>()
  const paths = new Set<string>()

  for (const entry of manifest.quarantined) {
    if (!entry.id || !entry.path || !entry.reason || !entry.owner || !entry.reviewAfter || !entry.exitCriteria) {
      throw new Error(`invalid quarantine entry: ${JSON.stringify(entry)}`)
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.reviewAfter) || Number.isNaN(new Date(`${entry.reviewAfter}T00:00:00.000Z`).getTime())) {
      throw new Error(`invalid quarantine reviewAfter date: ${entry.id}`)
    }
    if (ids.has(entry.id)) {
      throw new Error(`duplicate quarantine id: ${entry.id}`)
    }
    if (paths.has(entry.path)) {
      throw new Error(`duplicate quarantine path: ${entry.path}`)
    }
    ids.add(entry.id)
    paths.add(entry.path)
  }

  if (options.enforceReviewDate) {
    const expired = expiredQuarantineEntries(manifest, options.asOf)
    if (expired.length > 0) {
      throw new Error(`expired quarantine entries require review: ${expired.map((entry) => entry.id).join(', ')}`)
    }
  }
}

export function quarantinedPathSet(manifest = loadQuarantineManifest()) {
  return new Set(manifest.quarantined.map((entry) => entry.path))
}

function parseArgs(argv: string[]) {
  const args = new Map<string, string | boolean>()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) continue
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      args.set(arg, next)
      index += 1
    } else {
      args.set(arg, true)
    }
  }
  return args
}

export function renderQuarantineSummary(manifest: QuarantineManifest, asOf = new Date()) {
  const expired = expiredQuarantineEntries(manifest, asOf)
  const lines = [
    'Quarantine manifest',
    `  Entries: ${manifest.quarantined.length}`,
    `  Expired: ${expired.length}`,
  ]

  if (expired.length > 0) {
    lines.push('  Expired entries:')
    for (const entry of expired) {
      lines.push(`    - ${entry.id} (${entry.path}, reviewAfter=${entry.reviewAfter})`)
    }
  }

  return lines.join('\n')
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2))
  const manifestPath = typeof args.get('--manifest') === 'string'
    ? String(args.get('--manifest'))
    : defaultManifestPath
  const asOf = typeof args.get('--as-of') === 'string'
    ? new Date(`${args.get('--as-of')}T00:00:00.000Z`)
    : new Date()

  if (Number.isNaN(asOf.getTime())) {
    console.error('Invalid --as-of date. Expected YYYY-MM-DD.')
    process.exit(2)
  }

  try {
    const manifest = loadQuarantineManifest(manifestPath, {
      enforceReviewDate: args.has('--enforce-review-date'),
      asOf,
    })
    console.log(renderQuarantineSummary(manifest, asOf))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
