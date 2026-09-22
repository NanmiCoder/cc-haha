import type { JavaProcess } from '../../../src/features/managed-resources/api/hostToolsApi.js'
import { quoteShellArgument } from './applicationOperationsIo.js'

// Fixed read-only collector. Search terms never enter a shell. Base64 frames preserve argv
// boundaries, spaces and Unicode without requiring a JDK, jps or truncated ps columns.
export const JAVA_PROCESS_SCRIPT = `command -v base64 >/dev/null && command -v tr >/dev/null || exit 127
[ -d /proc/self ] || exit 125
printf 'CC_HAHA_JAVA_V1\\n'
unreadable=0
for file in /proc/[0-9]*/cmdline; do
  [ -e "$file" ] || continue
  if [ ! -r "$file" ]; then unreadable=$((unreadable + 1)); continue; fi
  first=''
  IFS= read -r -d '' first < "$file" 2>/dev/null || continue
  case "\${first##*/}" in java|java.bin)
    statfile=\${file%/cmdline}/stat
    before=$(cat "$statfile" 2>/dev/null) || continue
    rest=\${before##*) }; read -r -a fields <<< "$rest"
    start=\${fields[19]}
    [[ "$start" =~ ^[1-9][0-9]*$ ]] || continue
    value=$(base64 < "$file" 2>/dev/null) || continue
    value=$(printf '%s' "$value" | tr -d '\\r\\n')
    [ -n "$value" ] || continue
    pid=\${file#/proc/}; pid=\${pid%/cmdline}
    after=$(cat "$statfile" 2>/dev/null) || continue
    rest=\${after##*) }; read -r -a fields <<< "$rest"
    [ "$start" = "\${fields[19]}" ] || continue
    printf '%s\\t%s\\t%s\\n' "$pid" "$value" "$start"
    ;;
  esac
done
printf 'CC_HAHA_JAVA_END\\t%s\\n' "$unreadable"`
export const JAVA_PROCESS_COMMAND = `exec bash -c ${quoteShellArgument(JAVA_PROCESS_SCRIPT)}`

export function javaHeapArguments(args: string[]): Pick<JavaProcess, 'xms' | 'xmx'> {
  let xmx: string | null = null
  let xms: string | null = null
  const takesValue = new Set(['-cp', '-classpath', '--class-path', '-p', '--module-path', '--upgrade-module-path', '--add-modules', '--limit-modules', '--add-exports', '--add-opens', '--add-reads', '--patch-module', '--enable-native-access', '--source'])
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '-jar' || arg === '-m' || arg === '--module' || arg.startsWith('--module=') || arg === '--' || !arg.startsWith('-')) break
    if (takesValue.has(arg)) { i++; continue }
    const min = /^-Xms(\d+[kKmMgGtT]?)$/.exec(arg) ?? /^-XX:InitialHeapSize=(\d+[kKmMgGtT]?)$/.exec(arg)
    const max = /^-Xmx(\d+[kKmMgGtT]?)$/.exec(arg) ?? /^-XX:MaxHeapSize=(\d+[kKmMgGtT]?)$/.exec(arg)
    if (min) xms = min[1]!
    if (max) xmx = max[1]!
  }
  return { xms, xmx }
}
export function parseJavaProcesses(text: string): { processes: JavaProcess[]; unreadable: number } {
  const lines = text.trimEnd().split('\n')
  if (lines.shift() !== 'CC_HAHA_JAVA_V1') throw new Error('PROCESS_RESPONSE_INVALID')
  const end = /^CC_HAHA_JAVA_END\t(\d+)$/.exec(lines.pop() ?? '')
  if (!end || !Number.isSafeInteger(Number(end[1])) || lines.length > 10000) throw new Error('PROCESS_RESPONSE_INVALID')
  const seen = new Set<number>()
  const processes = lines.map(line => {
    const match = /^([1-9]\d*)\t([A-Za-z0-9+/]+={0,2})(?:\t([1-9]\d{0,19}))?$/.exec(line)
    if (!match) throw new Error('PROCESS_RESPONSE_INVALID')
    const pid = Number(match[1])
    const data = Buffer.from(match[2]!, 'base64')
    if (!Number.isSafeInteger(pid) || seen.has(pid) || data.toString('base64') !== match[2] || data.at(-1) !== 0) throw new Error('PROCESS_RESPONSE_INVALID')
    seen.add(pid)
    const args = data.toString('utf8').slice(0, -1).split('\0')
    if (!/^(java|java.bin)$/.test(args[0]!.split('/').at(-1)!)) throw new Error('PROCESS_RESPONSE_INVALID')
    const commandLine = args.map(arg => arg && !/[\s'"\\]/.test(arg) ? arg : JSON.stringify(arg)).join(' ')
    return { pid, commandLine, ...javaHeapArguments(args), ...(match[3] ? { startTime: match[3] } : {}) }
  })
  return { processes: processes.sort((a, b) => a.pid - b.pid), unreadable: Number(end[1]) }
}
