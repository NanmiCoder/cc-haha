import { z } from 'zod'

// Write-only inputs, never part of a public Host, Application or renderer store.
export const HostCredentialWriteSchema = z.object({
  storage: z.enum(['vault', 'temporary']),
  secret: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('ssh-password'), password: z.string().min(1).max(16 * 1024) }).strict(),
    z.object({ kind: z.literal('ssh-private-key'), privateKeyPem: z.string().min(1).max(64 * 1024), passphrase: z.string().min(1).max(16 * 1024).optional() }).strict(),
  ]),
}).strict()

export type HostCredentialWrite = z.infer<typeof HostCredentialWriteSchema>
export type AccountPasswordWrite = { password?: string }
