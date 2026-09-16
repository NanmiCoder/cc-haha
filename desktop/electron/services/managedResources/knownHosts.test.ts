import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createResourceDocumentStore } from './repositories/resourceDocumentStore.js'
import { canonicalizeEndpoint, createKnownHostsService } from './knownHosts.js'

describe('knownHostsService', () => {
  it('canonicalizes IPv4 and IPv6 endpoints correctly', () => {
    expect(canonicalizeEndpoint('192.168.1.1', 22)).toBe('192.168.1.1:22')
    expect(canonicalizeEndpoint('example.com', 2222)).toBe('example.com:2222')
    expect(canonicalizeEndpoint('::1', 22)).toBe('[::1]:22')
    expect(canonicalizeEndpoint('[2001:db8::1]', 22)).toBe('[2001:db8::1]:22')
    expect(canonicalizeEndpoint('[::1]:2222', 22)).toBe('[::1]:2222')
  })

  it('verifies unknown, trusts, and detects changed host keys', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'known-hosts-test-'))
    try {
      const store = createResourceDocumentStore({ activeConfigDir: tempDir })
      const service = createKnownHostsService(store)

      const endpoint = '10.0.0.1:22'
      const algo = 'ssh-ed25519'
      const fp1 = 'AAAAB3NzaC1yc2EAAAADAQABAAABAQC3' + 'a'.repeat(11)
      const fp2 = 'AAAAB3NzaC1yc2EAAAADAQABAAABAQC4' + 'b'.repeat(11)

      // 1. Initial check -> unknown
      const status1 = await service.verifyHostKey(endpoint, algo, fp1)
      expect(status1).toBe('unknown')
      expect(await service.getKnownKey(endpoint, algo)).toBeNull()

      // 2. Trust key
      await service.trustHostKey(endpoint, algo, fp1)
      const known = await service.getKnownKey(endpoint, algo)
      expect(known).not.toBeNull()
      expect(known?.sha256).toBe(fp1)

      // 3. Verify trusted key -> trusted
      const status2 = await service.verifyHostKey(endpoint, algo, fp1)
      expect(status2).toBe('trusted')

      // 4. Verify changed key -> changed
      const status3 = await service.verifyHostKey(endpoint, algo, fp2)
      expect(status3).toBe('changed')

      // 5. Update trust with new key
      await service.trustHostKey(endpoint, algo, fp2)
      const status4 = await service.verifyHostKey(endpoint, algo, fp2)
      expect(status4).toBe('trusted')
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    }
  })
})
