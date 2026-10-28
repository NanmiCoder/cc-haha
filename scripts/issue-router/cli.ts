#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { ZodError } from 'zod'
import { RouterError } from './git'
import { execute } from './router'

/** One invocation, one JSON request/result. No client API or provider access. */
export async function main(argv: string[]) {
  try {
    let cwd = process.cwd()
    let inputPath: string | undefined
    const command = argv.shift()
    for (let index = 0; index < argv.length; index += 2) {
      const flag = argv[index]
      const value = argv[index + 1]
      if (!value || !['--cwd', '--input'].includes(flag)) throw new RouterError('arguments', 'Use COMMAND [--cwd PATH] [--input JSON_FILE|-]')
      if (flag === '--cwd') cwd = value
      else inputPath = value
    }
    if (!command) throw new RouterError('arguments', 'Command required; see .agents/workflows/issue-router.md')
    const payload = inputPath ? JSON.parse(inputPath === '-' ? await Bun.stdin.text() : readFileSync(inputPath, 'utf8')) : {}
    if (payload.command && payload.command !== command) throw new RouterError('arguments', 'Input command conflicts with CLI command')
    const result = execute({ ...payload, command }, cwd)
    process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`)
    return 0
  } catch (error) {
    const code = error instanceof RouterError ? error.code : error instanceof ZodError ? 'input' : 'state_error'
    const message = error instanceof ZodError ? error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') : String((error as Error).message)
    process.stdout.write(`${JSON.stringify({ ok: false, error: { code, message } })}\n`)
    return 1
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
