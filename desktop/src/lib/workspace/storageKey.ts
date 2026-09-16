/**
 * Storage identity for the unified workspace, kept free of imports.
 *
 * `persistenceMigrations` runs before anything else at startup and must be able
 * to normalize this key without pulling the workspace store — and every module
 * the store reaches — into the migration path.
 */
export const WORKSPACE_STORAGE_KEY = 'cc-haha.workspace'
export const WORKSPACE_STORAGE_VERSION = 2
