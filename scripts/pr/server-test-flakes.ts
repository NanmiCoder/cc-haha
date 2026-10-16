/**
 * A failed server test file is re-run once, alone, only to label it. A file that
 * passes the second time is FLAKY, and that is still a failure: the gate never
 * turns a red run green. The label tells the reader whether to look for a race
 * or for a real regression.
 */
export type FlakeVerdict = {
  file: string
  verdict: 'flaky' | 'failed'
}

export type FlakeReport = {
  schemaVersion: 1
  verdicts: FlakeVerdict[]
  /** Always 1 when any file failed the first run. */
  exitCode: 0 | 1
}

export async function classifyFailedFiles(
  failedFiles: string[],
  rerunAlone: (file: string) => Promise<boolean>,
): Promise<FlakeReport> {
  const verdicts: FlakeVerdict[] = []
  for (const file of failedFiles) {
    verdicts.push({ file, verdict: (await rerunAlone(file)) ? 'flaky' : 'failed' })
  }
  return { schemaVersion: 1, verdicts, exitCode: failedFiles.length === 0 ? 0 : 1 }
}

export function formatFlakeReport(report: FlakeReport) {
  return report.verdicts.map(({ file, verdict }) => (
    verdict === 'flaky'
      ? `[server-tests] FLAKY ${file}: failed, then passed when re-run alone. Still a failure: fix the race.`
      : `[server-tests] FAILED ${file}: failed again when re-run alone.`
  ))
}
