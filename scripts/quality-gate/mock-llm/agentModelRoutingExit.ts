/** Teammates intentionally keep their inbox alive after the parent result. */
export function isExpectedRoutingExit(exitCode: number | null, signalCode: string | null, stoppedTeammate: boolean): boolean {
  // The CLI's gracefulShutdown handler catches SIGTERM and exits with 143;
  // Bun then reports a normal exit with signalCode=null, rather than SIGTERM.
  return exitCode === 0 || stoppedTeammate && (signalCode === 'SIGTERM' || exitCode === 143 && signalCode === null)
}
