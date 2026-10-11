const startupStdout = process.env.MOCK_SDK_STARTUP_STDOUT || ''
const startupStderr = process.env.MOCK_SDK_STARTUP_STDERR || ''

function write(stream: NodeJS.WriteStream, text: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    stream.write(`${text}\n`, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

if (startupStdout) await write(process.stdout, startupStdout)
if (startupStderr) await write(process.stderr, startupStderr)

process.exitCode = Number(process.env.MOCK_SDK_STARTUP_EXIT_CODE || 1)
