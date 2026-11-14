/**
 * The 59-image regression performs real image encoding. Give it the whole CPU
 * after the ordinary pool drains, keeping its timeout and assertions intact.
 * Failed test results remain results; they never prevent the isolated stage.
 */
export async function runServerTestFiles<T>(
  selectedFiles: string[],
  concurrency: number,
  runTestFile: (file: string) => Promise<T>,
): Promise<T[]> {
  const isolatedFile = 'src/tools/FileReadTool/FileReadTool.imageContext.test.ts'
  const ordinaryFiles = selectedFiles.filter(file => file !== isolatedFile)
  let nextFile = 0
  const results: T[] = []
  async function runWorker() {
    while (nextFile < ordinaryFiles.length) {
      const file = ordinaryFiles[nextFile]!
      nextFile += 1
      results.push(await runTestFile(file))
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(concurrency, ordinaryFiles.length) },
    () => runWorker(),
  ))
  for (const file of selectedFiles) {
    if (file === isolatedFile) results.push(await runTestFile(file))
  }
  return results
}
