import { pathToFileURL } from 'node:url'

export function searchTransportBunOptions(preloadPath: string): string {
  // BUN_OPTIONS splits paths containing whitespace, even when quoted. A base64
  // entrypoint survives that parser and remains valid in children with another cwd.
  const source = `await import(${JSON.stringify(pathToFileURL(preloadPath).href)})`
  return `--no-env-file --preload=data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
}
