/** Keep raw patch bytes: CR is content and Git's no-newline marker is structural. */
export function splitReviewHunks(diff: string): Array<{ patch: string }> {
  if (/^(?:old mode|new mode|rename from|rename to|copy from|copy to|GIT binary patch|Binary files)/m.test(diff)) return []
  const starts = [...diff.matchAll(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@.*$/gm)].map(match => match.index!)
  if (starts.length === 0) return []
  const header = diff.slice(0, starts[0])
  return starts.map((start, index) => ({ patch: header + diff.slice(start, starts[index + 1] ?? diff.length) }))
}
