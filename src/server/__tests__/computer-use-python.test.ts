import { describe, expect, test } from 'bun:test'
import { detectPythonRuntime } from '../api/computer-use-python.js'

describe('detectPythonRuntime', () => {
  test('prefers python3 on Windows when available', async () => {
    const calls: string[] = []
    const result = await detectPythonRuntime(
      'win32',
      async (cmd, args) => {
        calls.push(`${cmd} ${args.join(' ')}`.trim())
        if (cmd === 'python3' && args.join(' ') === '--version') {
          return { ok: true, stdout: 'Python 3.12.11', stderr: '', code: 0 }
        }
        if (cmd === 'where' && args[0] === 'python3') {
          return { ok: true, stdout: 'C:\\Python312\\python3.exe', stderr: '', code: 0 }
        }
        return { ok: false, stdout: '', stderr: '', code: 1 }
      },
    )

    expect(result.installed).toBe(true)
    expect(result.version).toBe('3.12.11')
    expect(result.path).toBe('C:\\Python312\\python3.exe')
    expect(result.command).toBe('python3')
    expect(result.prefixArgs).toEqual([])
    expect(result.source).toBe('system')
    expect(calls).toEqual(['python3 --version', 'where python3'])
  })

  test('falls back to py -3 on Windows', async () => {
    const result = await detectPythonRuntime(
      'win32',
      async (cmd, args) => {
        if (cmd === 'python3' || cmd === 'python') {
          return { ok: false, stdout: '', stderr: '', code: 1 }
        }
        if (cmd === 'py' && args.join(' ') === '-3 --version') {
          return { ok: true, stdout: '', stderr: 'Python 3.12.11', code: 0 }
        }
        if (cmd === 'where' && args[0] === 'py') {
          return { ok: true, stdout: 'C:\\Windows\\py.exe', stderr: '', code: 0 }
        }
        return { ok: false, stdout: '', stderr: '', code: 1 }
      },
    )

    expect(result.installed).toBe(true)
    expect(result.version).toBe('3.12.11')
    expect(result.path).toBe('C:\\Windows\\py.exe')
    expect(result.command).toBe('py')
    expect(result.prefixArgs).toEqual(['-3'])
    expect(result.source).toBe('system')
  })

  test('falls back to venv python when system python is not discoverable', async () => {
    const venvPython = 'C:\\Users\\Relakkes\\.claude\\.runtime\\venv\\Scripts\\python.exe'
    const result = await detectPythonRuntime(
      'win32',
      async (cmd, args) => {
        if (cmd === venvPython && args.join(' ') === '--version') {
          return { ok: true, stdout: 'Python 3.12.11', stderr: '', code: 0 }
        }
        return { ok: false, stdout: '', stderr: '', code: 1 }
      },
      venvPython,
    )

    expect(result.installed).toBe(true)
    expect(result.version).toBe('3.12.11')
    expect(result.path).toBe(venvPython)
    expect(result.command).toBe(venvPython)
    expect(result.prefixArgs).toEqual([])
    expect(result.source).toBe('venv')
  })
})
