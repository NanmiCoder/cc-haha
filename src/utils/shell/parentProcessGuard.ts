import { spawn, type ChildProcess, type SpawnOptions } from 'child_process'

// Keep the guardian outside the target shell's job table: a command's bare
// `wait` must not wait for our lifetime watcher. Arguments reach the original
// shell unchanged, including login flags and sandbox command wrappers.
//
// The guardian polls the runtime's pid instead of reading EOF from an extra
// stdio pipe. Bun wraps every stdio entry past fd 2 in a socket inside
// spawn(); that wrapping randomly fails ("Failed to connect"), closes the fd
// early (so the guardian SIGKILLed healthy commands) and can close unrelated
// fds in the runtime. It also stops once this supervisor shell is gone, so a
// terminated or aborted supervisor still takes its command group with it. The
// group outlives the supervisor while the guardian is a member, so `-$$`
// cannot name a reused process group.
//
// `kill -0` also succeeds for a zombie, so a dead runtime is noticed once its
// parent (the desktop server or a terminal shell) reaps it. The guardian's
// own PATH falls back to the system directories, and if `sleep` still cannot
// be run (126/127) it stops guarding instead of spinning; a poll killed by
// the command (`pkill sleep`) just polls again. The TERM trap reaps the poll
// in flight through `$!`, which the shell sets at fork time; `jobs -p` is
// empty inside a dash/zsh subshell trap and would wait out the whole second.
const PARENT_PROCESS_GUARD = `
runtime_pid=$1
shift
(
  PATH="/bin:/usr/bin:$PATH"
  trap '[ -n "$!" ] && kill "$!" 2>/dev/null; wait 2>/dev/null; exit 0' TERM
  while kill -0 "$runtime_pid" 2>/dev/null && kill -0 "$$" 2>/dev/null; do
    sleep 1 &
    wait "$!"
    case $? in 126|127) exit 0 ;; esac
  done
  kill -KILL "-$$"
) </dev/null >/dev/null 2>&1 &
lifetime_guard=$!
"$@"
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

  // Even a SIGKILLed runtime is noticed within one poll, so its command group
  // is reaped without depending on SDK task_started, a model loop, or graceful
  // cleanup. Normal completion kills and waits for the guardian in the
  // supervisor before returning the original exit code.
  return spawn('/bin/sh', [
    '-c', PARENT_PROCESS_GUARD, 'cc-haha-shell-lifetime', String(process.pid),
    command, ...args,
  ], {
    ...options,
    detached: true,
  })
}
