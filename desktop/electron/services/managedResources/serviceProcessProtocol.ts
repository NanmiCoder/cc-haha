import { ProcessKindSchema, ProcessProbeSchema, type JavaProcess, type ProcessKind, type ProcessProbe } from '../../../src/features/managed-resources/api/hostToolsApi.js'
import { quoteShellArgument } from './applicationOperationsIo.js'
import { JAVA_PROCESS_COMMAND, parseJavaProcesses } from './javaProcessProtocol.js'

const SERVICE_LIST_SCRIPT = String.raw`export LC_ALL=C
command -v base64 >/dev/null && command -v tr >/dev/null || exit 127
[ -d /proc/self ] || exit 125
kind=$1
printf 'CC_HAHA_PROCESS_V1\t%s\n' "$kind"
unreadable=0
for dir in /proc/[0-9]*; do
  [ -d "$dir" ] || continue
  comm=$(cat "$dir/comm" 2>/dev/null) || { unreadable=$((unreadable+1)); continue; }
  case "$kind:$comm" in mysql:mysqld|mysql:mariadbd|redis:redis-server|redis:redis-sentinel) ;; *) continue ;; esac
  before=$(cat "$dir/stat" 2>/dev/null) || { unreadable=$((unreadable+1)); continue; }
  rest=\${before##*) }; read -r -a fields <<< "$rest"
  start=\${fields[19]}
  [[ "$start" =~ ^[1-9][0-9]*$ ]] || continue
  data=$(base64 < "$dir/cmdline" 2>/dev/null) || { unreadable=$((unreadable+1)); continue; }
  data=$(printf '%s' "$data" | tr -d '\r\n')
  [ -n "$data" ] || continue
  after=$(cat "$dir/stat" 2>/dev/null) || continue
  rest=\${after##*) }; read -r -a fields <<< "$rest"
  [ "$start" = "\${fields[19]}" ] || continue
  printf '%s\t%s\t%s\t%s\n' "\${dir#/proc/}" "$start" "$comm" "$data"
done
printf 'CC_HAHA_PROCESS_END\t%s\n' "$unreadable"`.replace(/\\\$\{/g, '${')

export function processListCommand(kind: ProcessKind): string {
  ProcessKindSchema.parse(kind)
  if (kind === 'java') return JAVA_PROCESS_COMMAND
  return `exec bash -c ${quoteShellArgument(SERVICE_LIST_SCRIPT)} cc-haha-process ${quoteShellArgument(kind)}`
}

export function parseServiceProcesses(text: string, kind: ProcessKind): { processes: JavaProcess[]; unreadable: number } {
  if (kind === 'java') return parseJavaProcesses(text)
  const lines = text.trimEnd().split('\n')
  if (lines.shift() !== `CC_HAHA_PROCESS_V1\t${kind}`) throw new Error('PROCESS_RESPONSE_INVALID')
  const end = /^CC_HAHA_PROCESS_END\t(\d+)$/.exec(lines.pop() ?? '')
  if (!end || !Number.isSafeInteger(Number(end[1])) || lines.length > 10000) throw new Error('PROCESS_RESPONSE_INVALID')
  const seen = new Set<number>()
  const processes = lines.map(line => {
    const match = /^([1-9]\d*)\t([1-9]\d{0,19})\t([a-z-]+)\t([A-Za-z0-9+/]+={0,2})$/.exec(line)
    if (!match) throw new Error('PROCESS_RESPONSE_INVALID')
    const [, rawPid, startTime, name, encoded] = match
    const pid = Number(rawPid)
    if (!Number.isSafeInteger(pid) || pid > 2147483647 || seen.has(pid)) throw new Error('PROCESS_RESPONSE_INVALID')
    if (!(kind === 'mysql' ? ['mysqld', 'mariadbd'] : ['redis-server', 'redis-sentinel']).includes(name!)) throw new Error('PROCESS_RESPONSE_INVALID')
    const data = Buffer.from(encoded!, 'base64')
    if (data.at(-1) !== 0 || data.toString('base64') !== encoded) throw new Error('PROCESS_RESPONSE_INVALID')
    seen.add(pid)
    const args = data.toString('utf8').slice(0, -1).split('\0')
    // Redis clears the unused argv allocation with NUL bytes after setproctitle.
    if (kind === 'redis') while (args.length > 1 && args.at(-1) === '') args.pop()
    // Redis rewrites its process title; comm, not an argv substring, identifies it.
    const commandLine = args.map(arg => arg && !/[\s'"\\]/.test(arg) ? arg : JSON.stringify(arg)).join(' ')
    return { pid, startTime: startTime!, commandLine, xmx: null, xms: null }
  })
  return { processes: processes.sort((a, b) => a.pid - b.pid), unreadable: Number(end[1]) }
}

export const PROCESS_INSPECTION_SCRIPT = String.raw`export LC_ALL=C
set -o pipefail
pid=$1; expected=$2; kind=$3; probe=$4
error() { printf 'CC_HAHA_PROCESS_ERROR\t%s\n' "$1"; exit 0; }
identity() {
  [ -d "/proc/$pid" ] || error PROCESS_EXITED
  raw=$(cat "/proc/$pid/stat" 2>/dev/null) || error PROCESS_PERMISSION_DENIED
  rest=\${raw##*) }; read -r -a fields <<< "$rest"
  [ "\${fields[19]}" = "$expected" ] || error PROCESS_CHANGED
  comm=$(cat "/proc/$pid/comm" 2>/dev/null) || error PROCESS_PERMISSION_DENIED
  case "$kind:$comm" in java:java|java:java.bin|mysql:mysqld|mysql:mariadbd|redis:redis-server|redis:redis-sentinel) ;; *) error PROCESS_CHANGED ;; esac
}
command -v base64 >/dev/null && command -v tr >/dev/null || error PROCESS_TOOL_UNAVAILABLE
identity
if [ "$probe" = top ]; then
  command -v top >/dev/null || error PROCESS_TOOL_UNAVAILABLE
  result=$(top -b -n 2 -d 1 -p "$pid" -w 512 2>/dev/null) || error PROCESS_QUERY_FAILED
else
  command -v ss >/dev/null && command -v awk >/dev/null && command -v readlink >/dev/null || error PROCESS_TOOL_UNAVAILABLE
  ownns=$(readlink /proc/self/ns/net) || error PROCESS_PERMISSION_DENIED
  targetns=$(readlink "/proc/$pid/ns/net") || error PROCESS_PERMISSION_DENIED
  [ "$ownns" = "$targetns" ] || error PROCESS_NAMESPACE_UNAVAILABLE
  ls "/proc/$pid/fd" >/dev/null 2>&1 || error PROCESS_PERMISSION_DENIED
  if [ "$probe" = ports ]; then options=-l; else options=-a; fi
  result=$(ss -H -n -t -u -p "$options" 2>/dev/null | awk -v target="pid=$pid," 'index($0,target) { count++; bytes+=length($0)+1; if(count<=4096 && bytes<=245760) print; else truncated=1; } END { if(truncated) print "[output truncated]"; }') || error PROCESS_QUERY_FAILED
fi
identity
printf 'CC_HAHA_INSPECTION_V1\t%s\t%s\n' "$pid" "$probe"
printf '%s' "$result" | base64 | tr -d '\r\n'
printf '\nCC_HAHA_INSPECTION_END\n'`.replace(/\\\$\{/g, '${')

export function processInspectionCommand(input: { pid: number; startTime: string; processKind: ProcessKind; probe: ProcessProbe }): string {
  if (!Number.isInteger(input.pid) || input.pid < 1 || input.pid > 2147483647 || !/^[1-9][0-9]{0,19}$/.test(input.startTime)) throw new Error('INVALID_ARGUMENT')
  ProcessKindSchema.parse(input.processKind); ProcessProbeSchema.parse(input.probe)
  return `exec bash -c ${quoteShellArgument(PROCESS_INSPECTION_SCRIPT)} cc-haha-inspect ${input.pid} ${quoteShellArgument(input.startTime)} ${quoteShellArgument(input.processKind)} ${quoteShellArgument(input.probe)}`
}

export function parseProcessInspection(text: string, pid: number, probe: ProcessProbe): { text: string; truncated: boolean } {
  const failure = /^CC_HAHA_PROCESS_ERROR\t(PROCESS_EXITED|PROCESS_PERMISSION_DENIED|PROCESS_CHANGED|PROCESS_TOOL_UNAVAILABLE|PROCESS_NAMESPACE_UNAVAILABLE|PROCESS_QUERY_FAILED)\r?\n?$/.exec(text)
  if (failure) throw new Error(failure[1])
  const prefix = `CC_HAHA_INSPECTION_V1\t${pid}\t${probe}\n`
  const suffix = '\nCC_HAHA_INSPECTION_END\n'
  if (!text.startsWith(prefix) || !text.endsWith(suffix)) throw new Error('PROCESS_RESPONSE_INVALID')
  const encoded = text.slice(prefix.length, -suffix.length)
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.toString('base64') !== encoded || bytes.length > 256 * 1024) throw new Error('PROCESS_RESPONSE_INVALID')
  const content = bytes.toString('utf8')
  return { text: content, truncated: content.includes('[output truncated]') }
}
