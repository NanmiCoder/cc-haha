import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import type { TaskRun } from './cronScheduler.js'

export type ScheduledTaskReceipt = {
  version: 1
  occurrenceId: string
  taskId: string
  taskRevision: number
  runId: string
  scheduledFor: string
  claimedAt: string
  ownerPid: number
  state: 'claimed' | 'finished'
  run?: TaskRun
  historyWritten?: boolean
}
export function scheduledTaskReceiptsDir(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'scheduled_task_receipts')
}
function receiptPath(directory: string, occurrenceId: string): string {
  return path.join(directory, `${createHash('sha256').update(occurrenceId).digest('hex')}.json`)
}
/** The canonical receipt is exclusive-created BEFORE sending. Never rebuild it from the disposable index. */
export async function claimScheduledTaskReceipt(receipt: ScheduledTaskReceipt, directory = scheduledTaskReceiptsDir()): Promise<boolean> {
  await fs.mkdir(directory, { recursive: true })
  try {
    await fs.writeFile(receiptPath(directory, receipt.occurrenceId), JSON.stringify(receipt), { flag: 'wx', mode: 0o600 })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}
export async function finishScheduledTaskReceipt(receipt: ScheduledTaskReceipt, run: TaskRun, directory = scheduledTaskReceiptsDir(), historyWritten = false): Promise<void> {
  const target = receiptPath(directory, receipt.occurrenceId)
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, JSON.stringify({ ...receipt, state: 'finished', run, historyWritten }), { mode: 0o600 })
    await fs.rename(temporary, target)
  } finally { await fs.unlink(temporary).catch(() => {}) }
}
export async function readScheduledTaskReceipts(directory = scheduledTaskReceiptsDir()): Promise<ScheduledTaskReceipt[]> {
  const entries = await fs.readdir(directory).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  })
  const receipts: ScheduledTaskReceipt[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    try {
      const value = JSON.parse(await fs.readFile(path.join(directory, entry), 'utf8'))
      if (value.version === 1 && typeof value.occurrenceId === 'string' && typeof value.runId === 'string' &&
        typeof value.taskId === 'string' && Number.isInteger(value.taskRevision) && value.taskRevision >= 1 &&
        Number.isInteger(value.ownerPid) && value.ownerPid > 0 && ['claimed', 'finished'].includes(value.state) &&
        Number.isFinite(Date.parse(value.claimedAt)) && Number.isFinite(Date.parse(value.scheduledFor))) receipts.push(value)
    } catch {
      // A damaged exclusive claim must never be removed and retried automatically.
    }
  }
  return receipts
}
export function isReceiptOwnerAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

/** Match the bounded run history; retain all uncertain claims for conservative recovery. */
export async function pruneScheduledTaskReceipts(taskId: string, directory = scheduledTaskReceiptsDir()): Promise<void> {
  const finished = (await readScheduledTaskReceipts(directory))
    .filter(receipt => receipt.taskId === taskId && receipt.state === 'finished' && receipt.historyWritten)
    .sort((a, b) => Date.parse(b.claimedAt) - Date.parse(a.claimedAt))
  for (const receipt of finished.slice(100)) await fs.unlink(receiptPath(directory, receipt.occurrenceId)).catch(() => {})
}
