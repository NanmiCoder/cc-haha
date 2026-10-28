import { z } from 'zod'

const text = z.string().min(1).max(4096)
const key = z.string().min(1).max(256)
const sha = z.string().regex(/^[0-9a-f]{40,64}$/)
const time = z.iso.datetime({ offset: true })
const number = z.number().int().positive()
const session = z.strictObject({ client: key, host: key, session_id: text })
const token = { run_id: key, owner: key, generation: number }
const command = <T extends string, S extends z.ZodRawShape>(name: T, fields: S) => z.strictObject({ command: z.literal(name), ...fields })
const observation = z.strictObject({
  number, title: text, state: z.enum(['open', 'closed']), fingerprint: key,
  updated_at: time, is_pr: z.boolean().default(false),
})
const provenance = {
  source: text, reference: text, observed_at: time,
}
const versioned = { ...provenance, head: sha, base: sha }
const discovery = z.strictObject({
  ...provenance, complete: z.literal(true), sessions: z.array(session),
  prs: z.array(z.strictObject({ number, url: z.url(), branch: text })),
})
const adoption = z.strictObject({ session, worktree: text })

export const commandSchema = z.discriminatedUnion('command', [
  command('locate', {}),
  command('install-exclude', {}),
  command('init', {
    repository_id: key, repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    required_checks: z.array(key).min(1).default(['pr-quality-gate']),
  }),
  command('status', {}),
  command('observe-main', { ...provenance, sha, previous: sha.nullable(), descendant_verified: z.literal(true) }),
  command('backup', {}),
  command('migrate', {}),
  command('restore', { backup: text, clients_stopped: z.literal(true) }),
  command('observe', {
    scan_id: key, cursor_before: z.string(), cursor_after: text,
    complete: z.literal(true), baseline: z.boolean().default(false), candidates: z.array(observation),
  }),
  command('enqueue', {
    number, modules: z.array(key).min(1), branch: z.string().regex(/^(fix|feat)\/issue-\d+-[a-z0-9-]+$/),
  }),
  command('cover', { number, covered_by: number, reference: text }),
  command('claim', {
    number, owner: key, lease_seconds: number.max(86400).default(7200),
    adopt: adoption.optional(), discovery,
  }),
  command('reopen', {
    number, owner: key, previous_generation: number, old_executor_stopped: z.literal(true), reference: text,
    lease_seconds: number.max(86400).default(7200), adopt: adoption.optional(), discovery,
  }),
  command('consume', { ...token }),
  command('dispatch-start', { ...token, action_key: key, sender: key }),
  command('dispatch-unknown', { ...token, action_key: key, sender: key, reference: text }),
  command('bind-session', { ...token, action_key: key, sender: key, session, worktree: text }),
  command('ack', { ...token, action_key: key, sender: key, reference: text }),
  command('reconcile', {
    ...token, action_key: key, reference: text,
    outcome: z.enum(['found', 'absent', 'unknown']),
    session: session.optional(), worktree: text.optional(), merge_sha: sha.optional(),
  }),
  command('progress', {
    ...token, phase: z.enum(['working', 'review', 'ci', 'merge', 'blocked']),
    next_step: text, reference: text, lease_seconds: number.max(86400).default(7200),
  }),
  command('handoff', {
    ...token, new_owner: key, stopped_reference: text, old_executor_stopped: z.literal(true),
    session, worktree: text,
  }),
  command('record-pr', { ...token, ...versioned, number, url: z.url(), branch: text, state: z.enum(['open', 'closed', 'merged']) }),
  command('validation', {
    ...token, ...versioned, checks: z.array(z.strictObject({ name: key, result: z.enum(['passed', 'failed', 'not_run', 'skipped']) })).min(1),
  }),
  command('review', { ...token, ...versioned, reviewer: text, independent: z.literal(true), verdict: z.enum(['approved', 'changes_requested']) }),
  command('ci', {
    ...token, ...versioned, complete: z.literal(true), tested_sha: sha,
    // The adapter verifies the tested commit's parents/tree association, not
    // merely a status name on some previous PR head.
    association: z.enum(['head', 'merge']), association_reference: text,
    checks: z.array(z.strictObject({
      name: key, external_id: key, tested_sha: sha,
      selected: z.boolean(), status: z.enum(['queued', 'in_progress', 'completed']),
      conclusion: z.enum(['success', 'failure', 'cancelled', 'skipped', 'neutral', 'timed_out', 'action_required']).nullable(),
      scope_reference: text.optional(),
    })).min(1),
  }),
  command('merge-acquire', { ...token, head: sha, base: sha, branch_protection: z.strictObject({
    ...provenance, strict: z.literal(true), required_checks: z.array(key).min(1),
  }) }),
  command('smoke-acquire', { ...token }),
  command('smoke-release', { ...token }),
  command('complete', { ...token, merge_sha: sha, main_ci_reference: text, scenario_reference: text }),
  command('retire', {
    ...token, executor_stopped: z.literal(true), reference: text,
    outcome: z.enum(['closed', 'covered', 'not_planned']), pr_terminal_reference: text.optional(),
  }),
  command('recovery-confirm', { clients_stopped: z.literal(true), reference: text }),
])

export type Command = z.infer<typeof commandSchema>
export type Token = { run_id: string; owner: string; generation: number }
