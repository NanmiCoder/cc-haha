/**
 * M7.1 tests: the public context manifest is rebuilt deterministically from a
 * staged snapshot, matches the pinned v2 shape, leaks no secret and no local
 * absolute path, and refuses the (not yet shipped) disclosure path without
 * calling any decrypt/reveal code.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  canonicalJson,
  contextBindingInput,
  contextBindingOf,
  sha256Hex,
} from '../../../../services/managedContext/canonicalSerializer.js'
import { ManagedContextError } from '../../../../services/managedContext/errors.js'
import {
  CONTEXT_PROMPT_CONTEXT_BYTES_LIMIT,
  assertPublicManifestSafe,
  buildPublicContextManifest,
  estimateContextTokens,
  measureInjectableContextBytes,
  type StagedContextSnapshot,
} from '../../../../services/managedContext/manifest.js'
import { findAbsolutePath, findSecretMaterial } from '../../../../services/managedContext/secrets.js'
import { createUnreachableVaultGateway } from '../../../../services/managedContext/vaultGateway.js'
import {
  cloneFixture,
  loadContractFixture,
  snapshotFromFixture,
} from './stagedFixture.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = loadContractFixture()
const SNAPSHOT = snapshotFromFixture(FIXTURE)

function build(snapshot: StagedContextSnapshot = SNAPSHOT) {
  return buildPublicContextManifest(snapshot, {
    requestId: FIXTURE.publicManifest.requestId,
    resolvedAt: FIXTURE.publicManifest.resolvedAt,
  })
}

function expectManagedContextError(run: () => unknown, code: string): ManagedContextError {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(ManagedContextError)
    const managed = error as ManagedContextError
    expect(managed.code).toBe(code)
    return managed
  }
  throw new Error(`expected ManagedContextError(${code})`)
}

describe('M7.1 public context manifest', () => {
  it('rebuilds the pinned v2 public manifest from the staged snapshot', () => {
    const manifest = build()
    const { estimatedTokens: expectedTokens, ...expected } = FIXTURE.publicManifest
    const { estimatedTokens: actualTokens, ...actual } = manifest
    expect(actual).toEqual(expected)
    expect(expectedTokens).toBeGreaterThan(0)
    expect(Number.isInteger(actualTokens)).toBe(true)
    expect(actualTokens).toBeGreaterThan(0)
  })

  it('carries no secret, no vault handle and no local absolute path', () => {
    const manifest = build()
    const serialized = JSON.stringify(manifest)

    expect(findSecretMaterial(manifest)).toBeNull()
    expect(findAbsolutePath(manifest)).toBeNull()
    expect(manifest.containsSecrets).toBe(false)
    expect(manifest.secretFieldCount).toBe(0)

    // The fixture's ciphertext and the host's remote directory exist in the
    // staged snapshot; neither may reach the public manifest.
    expect(serialized).not.toContain('RkFLRQ==')
    expect(serialized).not.toContain('ciphertext')
    expect(serialized).not.toContain('/opt/example')
    expect(serialized).not.toContain('FAKE_ONLY_DO_NOT_USE_LABEL')
    expect(Object.keys(manifest)).not.toContain('credentials')
  })

  it('publishes only secret metadata when includePasswords=true', () => {
    const snapshot = cloneFixture(SNAPSHOT)
    snapshot.selection.includePasswords = true
    snapshot.selection.credentialRefs = [
      { id: '50000000-0000-4000-8000-000000000001', revision: 1 },
    ]

    const manifest = buildPublicContextManifest(snapshot, {
      requestId: FIXTURE.publicManifest.requestId,
      resolvedAt: FIXTURE.publicManifest.resolvedAt,
      secretFieldCount: 1,
    })
    expect(manifest.containsSecrets).toBe(true)
    expect(manifest.secretFieldCount).toBe(1)
    expect(manifest.selection.credentialRefs).toEqual(snapshot.selection.credentialRefs)
    expect(findSecretMaterial(manifest)).toBeNull()

    // The public builder remains vault-free: decrypt/reveal happens only in
    // Electron main before the private modelContext is staged.
    const source = readFileSync(
      resolve(HERE, '..', '..', '..', '..', 'services', 'managedContext', 'manifest.ts'),
      'utf8',
    )
    expect(source).not.toContain('vaultGateway')
    expect(source).not.toContain('.decrypt(')
  })

  it('prepares successfully while the vault is unreachable, as long as disclosure is off', () => {
    const vault = createUnreachableVaultGateway()
    expect(vault.availability()).toBe('unavailable')
    expect(() => vault.reveal('50000000-0000-4000-8000-000000000001')).toThrow(
      'No credential vault is reachable',
    )

    // The snapshot carries credential metadata; the manifest still builds.
    expect(SNAPSHOT.credentials.length).toBeGreaterThan(0)
    const manifest = build()
    expect(manifest.schemaVersion).toBe(2)
    expect(manifest.selection.includePasswords).toBe(false)
  })

  it('rejects a staged credential metadata entry that carries ciphertext', () => {
    const snapshot = cloneFixture(SNAPSHOT)
    const smuggled = {
      ...snapshot.credentials[0]!,
      ciphertextBase64: 'RkFLRQ==',
    }
    snapshot.credentials = [smuggled as typeof snapshot.credentials[number]]
    expectManagedContextError(() => build(snapshot), 'CONTEXT_SECRET_DETECTED')
  })

  it('rejects an absolute path or a private key smuggled into a manifest field', () => {
    const pathSnapshot = cloneFixture(SNAPSHOT)
    pathSnapshot.hosts[0]!.name = 'C:\\Users\\dev\\.ssh\\id_rsa'
    const pathError = expectManagedContextError(
      () => build(pathSnapshot),
      'CONTEXT_ABSOLUTE_PATH_DETECTED',
    )
    expect(pathError.details?.path).toBe('$manifest.hosts[0].name')

    const pemSnapshot = cloneFixture(SNAPSHOT)
    pemSnapshot.concepts[0]!.title = '-----BEGIN RSA PRIVATE KEY-----'
    expectManagedContextError(() => build(pemSnapshot), 'CONTEXT_SECRET_DETECTED')

    const posixSnapshot = cloneFixture(SNAPSHOT)
    posixSnapshot.databases[0]!.name = '/home/deploy/postgres'
    expectManagedContextError(() => build(posixSnapshot), 'CONTEXT_ABSOLUTE_PATH_DETECTED')
  })

  it('reports missing entities and changed revisions instead of shipping partial knowledge', () => {
    const missing = cloneFixture(SNAPSHOT)
    missing.hosts = []
    expectManagedContextError(() => build(missing), 'CONTEXT_RESOURCE_MISSING')

    const changed = cloneFixture(SNAPSHOT)
    changed.concepts[0]!.revision = 2
    expectManagedContextError(() => build(changed), 'CONTEXT_REVISION_CHANGED')

    const missingDependency = cloneFixture(SNAPSHOT)
    missingDependency.concepts = missingDependency.concepts.filter(
      (concept) => concept.id !== FIXTURE.selection.dependencyRefs[0]!.id,
    )
    expectManagedContextError(() => build(missingDependency), 'CONTEXT_RESOURCE_MISSING')

    const missingTag = cloneFixture(SNAPSHOT)
    missingTag.tags = missingTag.tags.filter((tag) => tag.id !== FIXTURE.selection.sourceTags[0]!.id)
    expectManagedContextError(() => build(missingTag), 'CONTEXT_RESOURCE_MISSING')

    const credentialRefsWithoutDisclosure = cloneFixture(SNAPSHOT)
    credentialRefsWithoutDisclosure.selection.credentialRefs = [
      { id: '50000000-0000-4000-8000-000000000001', revision: 1 },
    ]
    expectManagedContextError(
      () => build(credentialRefsWithoutDisclosure),
      'INVALID_CONTEXT_SELECTION',
    )
  })

  it('blocks a selection whose injectable context exceeds 64 KiB', () => {
    const big = cloneFixture(SNAPSHOT)
    big.concepts[0]!.bodyMarkdown = 'z'.repeat(CONTEXT_PROMPT_CONTEXT_BYTES_LIMIT)
    expectManagedContextError(() => build(big), 'CONTEXT_TOO_LARGE')
  })

  it('estimates tokens from the injectable payload, not from the manifest', () => {
    const bytes = measureInjectableContextBytes(SNAPSHOT)
    expect(bytes).toBeGreaterThan(0)
    expect(estimateContextTokens(SNAPSHOT)).toBe(Math.ceil(bytes / 4))
    expect(build().estimatedTokens).toBe(Math.ceil(bytes / 4))
  })

  it('keeps root concepts marked as root when also reached as a dependency', () => {
    const snapshot = cloneFixture(SNAPSHOT)
    snapshot.selection.dependencyRefs = [
      ...snapshot.selection.dependencyRefs,
      { id: FIXTURE.selection.conceptRootRefs[0]!.id, revision: 1 },
    ]
    const manifest = build(snapshot)
    const root = manifest.concepts.find(
      (concept) => concept.id === FIXTURE.selection.conceptRootRefs[0]!.id,
    )
    expect(root?.includedAs).toBe('root')
    expect(manifest.concepts).toHaveLength(2)
  })

  it('refuses to re-scan a manifest that carries a secret', () => {
    const manifest = cloneFixture(build())
    ;(manifest as unknown as Record<string, unknown>).privateKey = 'vault://credential/1'
    expectManagedContextError(() => assertPublicManifestSafe(manifest), 'CONTEXT_SECRET_DETECTED')
  })

  it('rejects a vault-handle field added to the manifest shape', () => {
    const manifest = cloneFixture(build()) as unknown as Record<string, unknown>
    manifest.credentialHandle = 'vault://credential/1'
    expectManagedContextError(
      () => assertPublicManifestSafe(manifest as never),
      'CONTEXT_SECRET_DETECTED',
    )
  })
})

describe('M7.1 canonical serializer', () => {
  it('sorts object keys by code point and preserves array order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(canonicalJson({ nested: { z: 1, a: [{ b: 1, a: 2 }] } })).toBe(
      '{"nested":{"a":[{"a":2,"b":1}],"z":1}}',
    )
    // Code-point order puts "z" (U+007A) before "é" (U+00E9).
    expect(canonicalJson({ é: 1, z: 2 })).toBe('{"z":2,"é":1}')
    expect(canonicalJson(['b', 'a'])).toBe('["b","a"]')
  })

  it('rejects values that JSON cannot represent deterministically', () => {
    expect(() => canonicalJson({ a: undefined })).toThrow('undefined is not serializable')
    expect(() => canonicalJson({ a: Number.NaN })).toThrow('non-finite numbers are not serializable')
    expect(() => canonicalJson({ a: new Date() })).toThrow('Date objects are not serializable')
    expect(() => canonicalJson({ a: new Map() })).toThrow('only plain objects are serializable')
  })

  it('hashes to lowercase hex SHA-256', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('derives a stable contextBinding that ignores labelAtSelection', () => {
    const base = FIXTURE.selection
    const renamed = cloneFixture(base)
    renamed.sourceTags = renamed.sourceTags.map((tag) => ({
      ...tag,
      labelAtSelection: `${tag.labelAtSelection}-renamed`,
    }))
    expect(contextBindingOf(renamed)).toBe(contextBindingOf(base))

    const reorderedTags = cloneFixture(base)
    reorderedTags.sourceTags = [...reorderedTags.sourceTags].reverse()
    expect(contextBindingOf(reorderedTags)).not.toBe(contextBindingOf(base))

    const reorderedMembers = cloneFixture(base)
    reorderedMembers.sourceTags[0]!.memberIds = []
    expect(contextBindingOf(reorderedMembers)).not.toBe(contextBindingOf(base))

    // The binding input is the selection without any label field.
    const input = contextBindingInput(base) as { sourceTags: Array<Record<string, unknown>> }
    expect(Object.keys(input.sourceTags[0]!).sort()).toEqual([
      'id',
      'memberIds',
      'namespace',
    ])
    expect(contextBindingOf(base)).toMatch(/^[0-9a-f]{64}$/)
  })
})
