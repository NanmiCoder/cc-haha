import { spawn, type ChildProcess, type SpawnOptions } from 'child_process'
import type { Duplex } from 'stream'

// Keep the guardian outside the target shell's job table: a command's bare
// `wait` must not wait for our lifetime watcher. Arguments reach the original
// shell unchanged, including login flags and sandbox command wrappers.
const PARENT_PROCESS_GUARD = `
(
  if ! IFS= read -r lifetime <&3; then
    kill -KILL "-$$"
  fi
) </dev/null >/dev/null 2>&1 &
lifetime_guard=$!
"$@" 3<&-
lifetime_status=$?
kill "$lifetime_guard" 2>/dev/null || :
wait "$lifetime_guard" 2>/dev/null || :
exit "$lifetime_status"
`

export function spawnWithParentProcessGuard(
  command: string,
  args: string[],
  options: SpawnOptions,
): ChildProcess {
  // Windows has no POSIX process group or /bin/sh. Retain its existing spawn
  // behavior; callers must not infer that a runtime crash killed its children.
  if (process.platform === 'win32') return spawn(command, args, options)

  const stdio = Array.isArray(options.stdio)
    ? [...options.stdio]
    : Array(3).fill(options.stdio ?? 'pipe')
  stdio[3] = 'pipe'
  const child = spawn('/bin/sh', [
    '-c', PARENT_PROCESS_GUARD, 'cc-haha-shell-lifetime', command, ...args,
  ], {
    ...options,
    detached: true,
    stdio,
  })

  // The CLI owns the pipe's write end. Even SIGKILL closes it in the kernel,
  // so EOF reaps this command's group without depending on SDK task_started,
  // a model loop, or graceful cleanup. Normal completion kills and waits for
  // the guardian in the supervisor before returning the original exit code.
  const lifetimePipe = child.stdio[3] as Duplex | null
  const release = () => lifetimePipe?.destroy()
  child.once('exit', release)
  child.once('error', release)
  return child
}
