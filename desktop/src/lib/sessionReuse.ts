/**
 * Helper for the "Continue from here" hand-off path on the welcome screen.
 *
 * The classic stray-tab case: a user clicks "New session in X" from the
 * sidebar, gets a pristine empty session, decides not to use it, closes
 * the tab to declutter, lands back on the EmptySession welcome screen,
 * and then clicks "Continue from here" on a recent activity card.
 *
 * Without intervention, the welcome path would call createSession and
 * mint yet ANOTHER pristine session, leaving the previously-created empty
 * session as a stray entry in the sidebar. Callers run this picker first,
 * and only fall back to createSession when no reusable candidate exists.
 *
 * Filters:
 * - `workDir` matches exactly. We don't merge across projects.
 * - `messageCount === 0` — the session was never used. Reusing a session
 *   with even one assistant turn would corrupt the user's history.
 * - `id !== excludeSessionId` — never reuse the previous session that we're
 *   handing off FROM.
 *
 * Sorted by `modifiedAt` desc so the freshest empty session wins.
 */

export type ReusableSessionShape = {
  id: string
  workDir: string | null
  messageCount: number
  modifiedAt: string
}

export function pickReusableEmptySession(
  sessions: ReadonlyArray<ReusableSessionShape>,
  workDir: string,
  excludeSessionId?: string,
): string | null {
  if (!workDir) return null
  const candidates = sessions
    .filter(
      (s) =>
        s.workDir === workDir &&
        s.messageCount === 0 &&
        s.id !== excludeSessionId,
    )
    .sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1))
  return candidates[0]?.id ?? null
}
