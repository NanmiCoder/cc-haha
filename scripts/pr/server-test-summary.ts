export function readServerTestSummary(output: string, exitCode: number) {
  const count = (label: 'pass' | 'fail' | 'skip') => Number(
    output.match(new RegExp(`^\\s*(\\d+) ${label}$`, 'm'))?.[1] ?? 0,
  )
  const passedTests = count('pass')
  const failedTests = count('fail')
  const skippedTests = count('skip')
  const reportedFiles = Number(
    output.match(/Ran\s+\d+\s+tests?\s+across\s+(\d+)\s+files?\./)?.[1] ?? 0,
  )
  const evidenceComplete = exitCode === 0 && reportedFiles === 1 &&
    failedTests === 0 && passedTests + skippedTests > 0
  return { passedTests, failedTests, skippedTests, evidenceComplete }
}
