const assert = require('node:assert/strict');
const {
  chmodSync,
  closeSync,
  cpSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs');
const { dirname, join } = require('node:path');
const { afterEach, test } = require('node:test');

const { resolve } = require('../../npm/lib/platform.js');
const {
  createTemporaryRoots,
  osStubEnv,
  postinstallScriptPath,
  removeOsStub,
  runScriptWithOsStub,
  wrapperScriptPath,
  writeOsStub,
} = require('./helpers.js');
const { tmpdir } = require('node:os');

const { temporaryDirectory, drainRoots } = createTemporaryRoots();

test('OS stubs live in a private temporary directory', () => {
  const stub = writeOsStub('win32', 'x64');
  try {
    assert.notEqual(dirname(stub), tmpdir());
    if (process.platform !== 'win32') {
      assert.equal(statSync(dirname(stub)).mode & 0o077, 0);
    }
    assert.match(readFileSync(stub, 'utf8'), /const platform = process\.env/);
  } finally {
    removeOsStub(stub);
  }
});

afterEach(() => {
  delete process.env.AGENT_DESKTOP_MACOS_HELPER_PATH;
  // Installing now also writes a digest sidecar. Leaving one behind puts an
  // unexpected file in npm/bin, which `npm pack` would include and the package
  // contract gate rejects - so the sweep has to match what installing creates.
  try { unlinkSync(join(__dirname, '..', '..', 'npm', 'bin', '.launcher-notice-' + require('../../npm/package.json').version)); } catch {}
  for (const name of ['agent-desktop-win32-x64.exe', 'agent-desktop-win32-arm64.exe']) {
    const installed = join(__dirname, '..', '..', 'npm', 'bin', name);
    try { unlinkSync(installed); } catch {}
    try { unlinkSync(`${installed}.sha256`); } catch {}
  }
  for (const root of drainRoots()) {
    rmSync(root, { recursive: true, force: true });
  }
});

function missingBinaryWrapper() {
  const root = temporaryDirectory();
  mkdirSync(join(root, 'bin'));
  cpSync(wrapperScriptPath, join(root, 'bin/agent-desktop'));
  cpSync(join(__dirname, '../../npm/lib'), join(root, 'lib'), { recursive: true });
  return join(root, 'bin/agent-desktop');
}

test('wrapper resolves the released win32-x64 mapping and names the missing-binary cause', async () => {
  const { code, stderr } = await runScriptWithOsStub(missingBinaryWrapper(), 'win32', 'x64', ['version']);
  assert.equal(code, 1);
  assert.match(stderr, /Error: Native binary not found for win32-x64/);
  assert.match(stderr, /installed package is incomplete/);
});

test('wrapper resolves the released win32-arm64 mapping and exits non-zero when the binary is absent', async () => {
  const { code, stderr } = await runScriptWithOsStub(missingBinaryWrapper(), 'win32', 'arm64', ['version']);
  assert.equal(code, 1);
  assert.match(stderr, /Error: Native binary not found for win32-arm64/);
  assert.match(stderr, /Expected: .*agent-desktop-win32-arm64\.exe/);
});

test('wrapper refuses an unmapped platform key by name', async () => {
  const { code, stderr } = await runScriptWithOsStub(wrapperScriptPath, 'sunos', 'x64', ['version']);
  assert.equal(code, 1);
  assert.match(stderr, /Error: Unsupported platform: sunos-x64/);
});

test('wrapper reports a non-zero exit status when the child dies to a signal', {
  skip: process.platform === 'win32',
}, async () => {
  const entry = resolve('darwin', 'arm64');
  const fakeBinary = join(wrapperScriptPath, '..', entry.binaryName);
  const fakeHelper = join(wrapperScriptPath, '..', 'agent-desktop-macos-helper');
  writeFileSync(fakeBinary, '#!/usr/bin/env node\nprocess.kill(process.pid, "SIGKILL");\n', { mode: 0o755 });
  chmodSync(fakeBinary, 0o755);
  writeFileSync(fakeHelper, '#!/usr/bin/env node\n', { mode: 0o755 });
  chmodSync(fakeHelper, 0o755);
  try {
    const { code, stderr } = await runScriptWithOsStub(
      wrapperScriptPath,
      'darwin',
      'arm64',
      ['version'],
    );
    assert.notEqual(code, 0, 'a signal-killed child must not be reported as success');
    assert.match(stderr, /terminated by signal/);
  } finally {
    try { unlinkSync(fakeBinary); } catch {}
    try { unlinkSync(fakeHelper); } catch {}
  }
});

test('AGENT_DESKTOP_BINARY_PATH installs on windows without any helper present', () => {
  const scratch = temporaryDirectory();
  const customBinary = join(scratch, 'stand-in.exe');
  writeFileSync(customBinary, 'fake-win-binary');
  const installedBinary = join(__dirname, '..', '..', 'npm', 'bin', 'agent-desktop-win32-x64.exe');
  const stub = writeOsStub('win32', 'x64');
  let stderr = '';
  const env = { ...process.env };
  delete env.AGENT_DESKTOP_SKIP_DOWNLOAD;
  env.AGENT_DESKTOP_BINARY_PATH = customBinary;
  Object.assign(env, osStubEnv('win32', 'x64'));
  const errFile = join(scratch, 'child-stderr.txt');
  const errFd = openSync(errFile, 'w');
  try {
    require('node:child_process').execFileSync(
      process.execPath,
      ['-r', stub, postinstallScriptPath],
      { env, stdio: ['ignore', 'ignore', errFd] },
    );
  } finally {
    closeSync(errFd);
    stderr = readFileSync(errFile, 'utf8');
    removeOsStub(stub);
    try { unlinkSync(errFile); } catch {}
  }
  try {
    assert.equal(readFileSync(installedBinary, 'utf8'), 'fake-win-binary');
    assert.match(stderr, /Using binary from AGENT_DESKTOP_BINARY_PATH/);
    assert.doesNotMatch(stderr, /macOS helper not found/);
  } finally {
    try { unlinkSync(installedBinary); } catch {}
    try { unlinkSync(`${installedBinary}.sha256`); } catch {}
  }
});

function noticeWrapper() {
  const root = temporaryDirectory();
  const binDir = join(root, 'bin');
  mkdirSync(binDir);
  cpSync(wrapperScriptPath, join(binDir, 'agent-desktop'));
  cpSync(join(__dirname, '../../npm/lib'), join(root, 'lib'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '9.8.7' }));
  const entry = resolve('linux', 'x64');
  writeFileSync(
    join(binDir, entry.binaryName),
    '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));process.exit(3);\n',
    { mode: 0o755 },
  );
  chmodSync(join(binDir, entry.binaryName), 0o755);
  return { binDir, script: join(binDir, 'agent-desktop') };
}

async function runLinux(script) {
  const stub = writeOsStub('linux', 'x64');
  const { spawn } = require('node:child_process');
  try {
    return await new Promise((settle) => {
      let stdout = '';
      let stderr = '';
      const child = spawn(process.execPath, ['-r', stub, script, 'a', '--b'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...osStubEnv('linux', 'x64') },
      });
      child.stdout.on('data', (c) => { stdout += c; });
      child.stderr.on('data', (c) => { stderr += c; });
      child.on('close', (code) => settle({ code, stdout, stderr }));
    });
  } finally {
    removeOsStub(stub);
  }
}

test('launcher notice prints once per version and leaves stdout and exit code alone', {
  skip: process.platform === 'win32',
}, async () => {
  const { binDir, script } = noticeWrapper();
  const first = await runLinux(script);
  assert.equal(first.code, 3);
  assert.equal(first.stdout, '["a","--b"]\n');
  assert.match(first.stderr, /runs through the Node launcher/);
  assert.match(first.stderr, /--allow-scripts=agent-desktop/);
  assert.match(first.stderr, /npm install-scripts approve agent-desktop/);
  assert.equal(statSync(join(binDir, '.launcher-notice-9.8.7')).isFile(), true);
  const second = await runLinux(script);
  assert.equal(second.code, 3);
  assert.equal(second.stdout, first.stdout);
  assert.doesNotMatch(second.stderr, /Node launcher/);
});

test('launcher notice stays silent when the marker cannot be written', {
  skip: process.platform === 'win32' || (process.getuid && process.getuid() === 0),
}, async () => {
  const { binDir, script } = noticeWrapper();
  chmodSync(binDir, 0o555);
  try {
    const result = await runLinux(script);
    assert.equal(result.code, 3);
    assert.equal(result.stdout, '["a","--b"]\n');
    assert.doesNotMatch(result.stderr, /Node launcher/);
  } finally {
    chmodSync(binDir, 0o755);
  }
});
