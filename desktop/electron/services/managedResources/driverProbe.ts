/**
 * Side-effect-free capability probe for the Electron-managed resource drivers.
 *
 * The function exists only to confirm that the five M0.2 pinned packages can
 * be loaded into the current Electron Node main process and that each package
 * exposes the entry point the rest of the Electron-side feature module will
 * later consume. It must not open a connection, query, run a transaction,
 * register globals, or read configuration or environment variables. Any load
 * failure or missing entry is surfaced as a real thrown error rather than a
 * silently swallowed false.
 */

export type ManagedResourceDrivers = {
  ssh: boolean
  mysql: boolean
  postgres: boolean
  postgresCursor: boolean
  redis: boolean
}

function requireEntry<T extends string>(
  label: string,
  value: unknown,
  entry: T,
): asserts value is Record<T, unknown> {
  if (value === null || typeof value !== 'object') {
    throw new Error(`${label} did not return a module object`)
  }
  if (typeof (value as Record<string, unknown>)[entry] !== 'function') {
    throw new Error(`${label} is missing required function entry '${entry}'`)
  }
}

export async function probeManagedResourceDrivers(): Promise<ManagedResourceDrivers> {
  const sshModule = await import('ssh2')
  requireEntry('ssh2', sshModule, 'Client')

  const mysqlModule = await import('mysql2/promise')
  requireEntry('mysql2/promise', mysqlModule, 'createConnection')

  const pgModule = await import('pg')
  requireEntry('pg', pgModule, 'Client')

  const pgCursorModule = await import('pg-cursor')
  // pg-cursor ships as `module.exports = Cursor` in its CJS entry and
  // `export default Cursor` in its ESM wrapper, so the default-exported
  // constructor is reachable either as `default` (ESM dynamic import) or
  // as the module itself (CJS createRequire). Accept either shape so the
  // probe and the Electron subprocess test agree on the same entry point.
  const pgCursorEntry =
    pgCursorModule && typeof pgCursorModule === 'object' && 'default' in pgCursorModule
      ? pgCursorModule.default
      : (pgCursorModule as unknown)
  if (typeof pgCursorEntry !== 'function') {
    throw new Error("pg-cursor default export is not a constructor")
  }

  const redisModule = await import('@redis/client')
  requireEntry('@redis/client', redisModule, 'createClient')

  return {
    ssh: true,
    mysql: true,
    postgres: true,
    postgresCursor: true,
    redis: true,
  }
}