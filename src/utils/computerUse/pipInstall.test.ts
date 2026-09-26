import { describe, expect, test } from 'bun:test'

import { buildPipInstallAttempts } from './pipInstall.js'
import {
  bootstrapPipIntoVenv,
  getComputerUsePythonEnv,
  getCursorBadgeCommand,
  installRuntimeDependencies,
  pythonRuntimeFor,
  runPipInstallWithFallback,
} from './pythonBridge.js'

describe('buildPipInstallAttempts', () => {
  test('tries the configured mirror before falling back to the default index', () => {
    expect(buildPipInstallAttempts(['install', '-r', 'requirements.txt'])).toEqual([
      [
        'install',
        '-r',
        'requirements.txt',
        '-i',
        'https://pypi.tuna.tsinghua.edu.cn/simple/',
        '--trusted-host',
        'pypi.tuna.tsinghua.edu.cn',
      ],
      ['install', '-r', 'requirements.txt'],
    ])
  })
})

describe('pythonBridge runPipInstallWithFallback', () => {
  test('falls back to the default PyPI index after the mirror fails', async () => {
    const calls: string[][] = []

    await runPipInstallWithFallback(
      ['-m', 'pip', 'install', '--upgrade', 'pip'],
      'pip upgrade',
      async args => {
        calls.push(args)
        return {
          code: args.includes('-i') ? 1 : 0,
          stdout: args.includes('-i') ? '' : 'ok',
          stderr: args.includes('-i') ? 'mirror unavailable' : '',
        }
      },
    )

    expect(calls).toEqual([
      [
        '-m',
        'pip',
        'install',
        '--upgrade',
        'pip',
        '-i',
        'https://pypi.tuna.tsinghua.edu.cn/simple/',
        '--trusted-host',
        'pypi.tuna.tsinghua.edu.cn',
      ],
      ['-m', 'pip', 'install', '--upgrade', 'pip'],
    ])
  })

  test('throws the first pip failure when both indexes fail', async () => {
    await expect(runPipInstallWithFallback(
      ['-m', 'pip', 'install', '-r', 'requirements.txt'],
      'python dependency install',
      async args => ({
        code: 1,
        stdout: '',
        stderr: args.includes('-i') ? 'mirror unavailable' : 'official unavailable',
      }),
    )).rejects.toThrow('python dependency install failed with code 1: mirror unavailable')
  })
})

describe('Windows virtual cursor Python process identity', () => {
  test('shares one non-zero input tag with helper subprocesses on Windows', () => {
    const environment = getComputerUsePythonEnv()
    const command = getCursorBadgeCommand()

    if (process.platform === 'win32') {
      expect(environment?.PYTHONIOENCODING).toBe('utf-8')
      expect(environment?.PYTHONUTF8).toBe('1')
      expect(Number(environment?.CC_HAHA_COMPUTER_USE_INPUT_TAG)).toBeGreaterThan(0)
      expect(command.python.endsWith('Scripts\\python.exe')).toBe(true)
    } else {
      expect(environment).toBeUndefined()
      expect(command.python.endsWith('bin/python3')).toBe(true)
    }
    expect(command.script.endsWith('win_cursor_badge.py')).toBe(true)
  })
})

describe('bootstrapPipIntoVenv', () => {
  test('uses ensurepip when the interpreter has it', async () => {
    const calls: string[] = []
    await bootstrapPipIntoVenv({
      python: '/venv/bin/python3',
      run: async (file, args) => {
        calls.push(`${file} ${args.join(' ')}`)
        return ''
      },
      probe: async () => true,
    })
    expect(calls).toEqual(['/venv/bin/python3 -m ensurepip --upgrade'])
  })

  test('falls back to an existing pip when ensurepip is missing', async () => {
    // Debian/Ubuntu without python3-venv: `-m ensurepip` fails with the module
    // error, but a pip elsewhere on the machine can install into the venv.
    const calls: string[] = []
    await bootstrapPipIntoVenv({
      python: '/venv/bin/python3',
      run: async (file, args) => {
        calls.push(`${file} ${args.join(' ')}`)
        if (args[0] === '-m') throw new Error("No module named ensurepip")
        return ''
      },
      probe: async file => file === 'pip3',
    })
    expect(calls).toEqual([
      '/venv/bin/python3 -m ensurepip --upgrade',
      'pip3 --python /venv/bin/python3 install --upgrade pip',
    ])
  })

  test('names the Linux remedy when neither ensurepip nor a pip is available', async () => {
    await expect(
      bootstrapPipIntoVenv({
        python: '/venv/bin/python3',
        platform: 'linux',
        run: async () => {
          throw new Error('No module named ensurepip')
        },
        probe: async () => false,
      }),
    ).rejects.toThrow('python3-venv')
  })

  test('names the Windows remedy on win32 rather than the Debian package', async () => {
    // The remedy has to match the host: telling a Windows user to apt-install
    // python3-venv is the same dead end the raw module error was.
    const failure = bootstrapPipIntoVenv({
      python: 'C:\\venv\\Scripts\\python.exe',
      platform: 'win32',
      run: async () => {
        throw new Error('No module named ensurepip')
      },
      probe: async () => false,
    })
    await expect(failure).rejects.toThrow('ensurepip')
    await expect(failure).rejects.not.toThrow('python3-venv')
  })
})

describe('pythonRuntimeFor', () => {
  test('maps each Python-backed platform to its own helper and requirements', () => {
    // The two package sets are not interchangeable: the Windows list carries
    // pywin32/screeninfo, the Linux one python-xlib.
    expect(pythonRuntimeFor('win32')).toEqual({
      helper: 'win_helper.py',
      requirements: 'requirements-win.txt',
    })
    expect(pythonRuntimeFor('linux')).toEqual({
      helper: 'linux_helper.py',
      requirements: 'requirements-linux.txt',
    })
  })

  test('has no Python components on macOS or an unknown platform', () => {
    // macOS drives the signed native cu-helper; a two-way "Linux, else
    // Windows" choice used to hand it the Windows-only package set.
    expect(pythonRuntimeFor('darwin')).toBeNull()
    expect(pythonRuntimeFor('freebsd' as NodeJS.Platform)).toBeNull()
  })
})

describe('installRuntimeDependencies', () => {
  test('upgrades pip before installing requirements', async () => {
    const calls: string[] = []

    await installRuntimeDependencies('/tmp/requirements.txt', async (args, label) => {
      calls.push(`${label}: ${args.join(' ')}`)
    })

    expect(calls).toEqual([
      'pip upgrade: -m pip install --upgrade pip',
      'python dependency install: -m pip install -r /tmp/requirements.txt',
    ])
  })
})
