import { ExecutionUserSchema } from '../../../src/features/managed-resources/api/hostToolsApi.js'
import { quoteShellArgument as quote } from './applicationOperationsIo.js'

export function applicationScriptCommand(cwd: string, filename: string, runAsUser: string): string {
  ExecutionUserSchema.parse(runAsUser)
  const script = `cd -- ${quote(cwd)} && exec bash -- ${quote('./' + filename)}`
  if (!runAsUser) return script
  const user = quote(runAsUser)
  const verifyUser = `test "$(id -un)" = ${user} || { printf '%s\\n' 'RUN_AS_IDENTITY_MISMATCH' >&2; exit 126; }; `
  // Use the remote effective UID, not an editable host label. su login establishes HOME/PATH
  // before cd; no fallback branch ever retries the script as root after su fails.
  return `uid=$(id -u) || exit 126; if [ "$uid" = 0 ]; then exec su - ${user} -s /bin/bash -c ${quote(verifyUser + script)}; elif [ "$(id -un)" = ${user} ]; then ${script}; else printf '%s\\n' 'RUN_AS_REQUIRES_ROOT' >&2; exit 126; fi`
}
