import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import {
  AGENT_DESKTOP_COMMANDS,
  type AgentDesktopInput,
} from '../../vendor/computer-use-mcp/agentDesktopProtocol.js'

const commands = new Set<string>(AGENT_DESKTOP_COMMANDS)
const managedFlags = new Set(['--session', '--agent-id', '--headed', '--trace', '--trace-strict'])
const globalOptionValues = new Set(['--session', '--agent-id', '--trace', '--screenshot', '--wait-for', '-w', '--wait-for-gone', '--wait-timeout'])
const globalBooleanOptions = new Set(['--verbose', '-v', '--debug', '--trace-strict', '--headed', '--help', '-h'])

export class AgentDesktopInputError extends Error {}

export function validateAgentDesktopInput(input: AgentDesktopInput): void {
  if (!input || !commands.has(input.command)) throw new AgentDesktopInputError('Unknown agent-desktop command. Use skills or a command with --help to discover the CLI.')
  if (input.headed !== undefined && typeof input.headed !== 'boolean') throw new AgentDesktopInputError('headed must be a boolean')
  if (input.args !== undefined && (!Array.isArray(input.args) || input.args.some(arg => typeof arg !== 'string' || arg.includes('\0')))) {
    throw new AgentDesktopInputError('args must be an array of strings without NUL characters')
  }
  if ((input.args?.length ?? 0) > 512 || Buffer.byteLength(JSON.stringify(input.args ?? [])) > 1024 * 1024) {
    throw new AgentDesktopInputError('Desktop arguments exceed the request limit')
  }
  for (const index of optionIndices(input)) {
    const arg = input.args![index]!
    if (managedFlags.has(arg.split('=', 1)[0]!)) {
      throw new AgentDesktopInputError('Session, agent identity and trace paths are managed by the host. Use the headed input field for physical input.')
    }
  }
}

export function isAgentDesktopHelp(input: AgentDesktopInput): boolean {
  for (const index of optionIndices(input)) {
    const arg = input.args![index]!
    if (arg === '--help' || arg === '-h') return true
  }
  return false
}

export function agentDesktopAction(input: AgentDesktopInput): { name: string; index: number } | undefined {
  const index = subcommandPositionals(input.args ?? [])[0]
  return index === undefined ? undefined : { name: input.args![index]!, index }
}

export async function prepareAgentDesktopArguments(
  input: AgentDesktopInput,
  sessionId: string,
  artifactRoot: string,
): Promise<string[]> {
  const args = [...(input.args ?? [])]
  if (isAgentDesktopHelp(input)) return args
  const action = agentDesktopAction(input)?.name
  const artifact = async (extension: string) => {
    await mkdir(artifactRoot, { recursive: true, mode: 0o700 })
    return path.join(artifactRoot, `${randomUUID()}.${extension}`)
  }
  if (input.command === 'screenshot') {
    const positional = screenshotPosition(args)
    const output = await artifact('png')
    if (positional === -1) args.push(output)
    else args[positional] = output
  }
  if (input.command === 'clipboard-get') replaceOutput(args, '--out', await artifact('png'))
  if (input.command === 'trace' && action === 'export') replaceOutput(args, '--out', await artifact('html'))
  if (['snapshot', 'click'].includes(input.command) && optionIndices(input).some(index => args[index] === '--debug')) {
    replaceOutput(args, '--screenshot', await artifact('html'))
  }
  if (input.command === 'session' && action === 'end') {
    const target = subcommandPositionals(args)[1]
    if (target !== undefined && args[target] !== sessionId) throw new AgentDesktopInputError('Only the current host-owned desktop session can be ended')
    if (target === undefined) args.push(sessionId)
  }
  if (input.command === 'batch') {
    const index = batchPosition(args)
    let entries: unknown
    try { entries = JSON.parse(args[index] ?? '') } catch { throw new AgentDesktopInputError('batch requires a JSON array of native command objects') }
    if (!Array.isArray(entries) || entries.length > 100) throw new AgentDesktopInputError('batch must contain at most 100 command objects')
    for (const entry of entries) {
      if (!record(entry) || typeof entry.command !== 'string' || !commands.has(entry.command) || entry.command === 'batch') {
        throw new AgentDesktopInputError('Every batch entry must name a supported non-batch command')
      }
      if (entry.session !== undefined && entry.session !== null && entry.session !== sessionId) {
        throw new AgentDesktopInputError('Batch entries cannot switch the host-owned desktop session')
      }
      entry.session = sessionId
      const nativeArgs = entry.args === undefined || entry.args === null ? {} : entry.args
      if (!record(nativeArgs)) throw new AgentDesktopInputError('Batch args must be native argument objects')
      if (['session', 'agent_id', 'headed', 'trace'].some(key => key in nativeArgs)) {
        throw new AgentDesktopInputError('Batch args cannot override host session, agent, input policy or trace ownership')
      }
      if (entry.command === 'session' && ['start', 'end'].includes(String(nativeArgs.action))) {
        throw new AgentDesktopInputError('Start or end host-owned sessions with a standalone session command, outside a batch')
      }
      if (entry.command === 'screenshot') nativeArgs.output_path = await artifact('png')
      if (entry.command === 'clipboard-get') nativeArgs.out = await artifact('png')
      if (entry.command === 'trace' && nativeArgs.action === 'export') nativeArgs.out = await artifact('html')
      entry.args = nativeArgs
    }
    args[index] = JSON.stringify(entries)
  }
  return args
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function replaceOutput(args: string[], flag: string, value: string): void {
  const terminator = args.indexOf('--')
  const end = terminator === -1 ? args.length : terminator
  const index = args.findIndex((arg, index) => index < end && (arg === flag || arg.startsWith(`${flag}=`)))
  if (index === -1) args.splice(end, 0, flag, value)
  else if (args[index] === flag) args.splice(index, args[index + 1] === undefined ? 1 : 2, flag, value)
  else args[index] = `${flag}=${value}`
}

function optionIndices(input: AgentDesktopInput): number[] {
  const indices: number[] = []
  const args = input.args ?? []
  const textCommand = input.command === 'type' || input.command === 'set-value'
  const valueOptions = new Set([...globalOptionValues, '--timeout-ms'])
  if (input.command === 'type') valueOptions.add('--interval-ms')
  let positional = 0
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--') break
    const flag = arg.split('=', 1)[0]!
    if (textCommand && positional === 1 && !globalBooleanOptions.has(flag) && !valueOptions.has(flag)) { positional++; continue }
    if (!arg.startsWith('-')) { positional++; continue }
    indices.push(index)
    if ((input.command === 'launch' && arg === '--arg') || (textCommand && valueOptions.has(arg))) index++
  }
  return indices
}

function subcommandPositionals(args: string[]): number[] {
  const positions: number[] = []
  let literal = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (!literal && arg === '--') { literal = true; continue }
    if (!literal && arg.startsWith('-')) {
      if (globalOptionValues.has(arg)) index++
    } else positions.push(index)
  }
  return positions
}

function screenshotPosition(args: string[]): number {
  const valueFlags = new Set(['--app', '--window-id', '--screen', '--wait-ms', '--wait-for', '--timeout-ms', '--wait-timeout-ms'])
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--') return index + 1 < args.length ? index + 1 : -1
    if (valueFlags.has(arg)) { index++; continue }
    if (!arg.startsWith('-')) return index
  }
  return -1
}

function batchPosition(args: string[]): number {
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--timeout-ms') { index++; continue }
    if (args[index] === '--') return index + 1
    if (!args[index]!.startsWith('-')) return index
  }
  throw new AgentDesktopInputError('batch requires a JSON array argument')
}
