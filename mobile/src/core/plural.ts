/** "1 file" / "3 files". Pass `plural` when adding an "s" is wrong ("1 query" / "2 queries"). */
export function plural(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`
}
