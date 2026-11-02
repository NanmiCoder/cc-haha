const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs');
const { join } = require('node:path');
const { afterEach, test } = require('node:test');

const postinstall = require('../../npm/scripts/postinstall.js');
const {
  PLATFORMS,
  helperNames,
  resolve,
  tarCommand,
  tarballName,
} = require('../../npm/lib/platform.js');
const { createTemporaryRoots, postinstallAs, runScriptWithOsStub } = require('./helpers.js');

const postinstallScriptPath = join(__dirname, '..', '..', 'npm', 'scripts', 'postinstall.js');

const { temporaryDirectory, trackRoot, drainRoots } = createTemporaryRoots();

afterEach(() => {
  delete process.env.AGENT_DESKTOP_MACOS_HELPER_PATH;
  for (const root of drainRoots()) {
    rmSync(root, { recursive: true, force: true });
  }
});

function archive(entries) {
  const root = temporaryDirectory();
  const source = join(root, 'source');
  mkdirSync(source);
  for (const [name, contents] of Object.entries(entries)) {
    const path = join(source, name);
    writeFileSync(path, contents, { mode: 0o755 });
    chmodSync(path, 0o755);
  }
  const tarball = join(root, 'release.tar.gz');
  execFileSync(tarCommand(process.platform, process.env), [
    '-czf',
    tarball,
    '-C',
    source,
    ...Object.keys(entries),
  ]);
  return { root, tarball };
}

function stagingLeftovers() {
  const packageBin = join(__dirname, '..', '..', 'npm', 'bin');
  return readdirSync(packageBin).filter((name) => name.startsWith('.extract-')).sort();
}

function captureWarnings(run) {
  const warnings = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => {
    warnings.push(String(chunk));
    return true;
  };
  try {
    run();
    return warnings.join('');
  } finally {
    process.stderr.write = write;
  }
}


test('checksum lookup requires an exact archive name', () => {
  const hash = 'a'.repeat(64);
  assert.equal(postinstall.checksumFor(`${hash}  release.tar.gz\n`, 'release.tar.gz'), hash);
  assert.throws(
    () => postinstall.checksumFor(`${hash}  old-release.tar.gz\n`, 'release.tar.gz'),
    /Checksum entry missing/,
  );
});

test('archive validation rejects missing and additional payloads on the darwin entry set', () => {
  const valid = archive({
    'agent-desktop': 'cli',
    'agent-desktop-macos-helper': 'helper',
  });
  postinstall.validateArchive(valid.tarball, ['agent-desktop', 'agent-desktop-macos-helper']);

  const extra = archive({
    'agent-desktop': 'cli',
    'agent-desktop-macos-helper': 'helper',
    'unexpected': 'payload',
  });
  assert.throws(
    () => postinstall.validateArchive(extra.tarball, ['agent-desktop', 'agent-desktop-macos-helper']),
    /unexpected entries/,
  );
});

test('archive validation is platform-correct on the win32 single-entry set', () => {
  const valid = archive({ 'agent-desktop.exe': 'cli' });
  postinstall.validateArchive(valid.tarball, ['agent-desktop.exe']);

  const extra = archive({
    'agent-desktop.exe': 'cli',
    'unexpected.exe': 'payload',
  });
  assert.throws(
    () => postinstall.validateArchive(extra.tarball, ['agent-desktop.exe']),
    /unexpected entries/,
  );
});

test('archive installation preserves the exact paired executables', () => {
  const payload = archive({
    'agent-desktop': 'cli-build-v1',
    'agent-desktop-macos-helper': 'helper-build-v1',
  });
  const destination = temporaryDirectory();
  const binary = join(destination, 'agent-desktop-darwin-arm64');
  const helper = join(destination, 'agent-desktop-macos-helper');

  postinstall.installArchive(payload.tarball, binary, helper, resolve('darwin', 'arm64'));

  assert.equal(readFileSync(binary, 'utf8'), 'cli-build-v1');
  assert.equal(readFileSync(helper, 'utf8'), 'helper-build-v1');
});

test('archive installation places the windows executable and leaves no staging directory behind', () => {
  const payload = archive({ 'agent-desktop.exe': 'cli-win-build' });
  const destination = temporaryDirectory();
  const binary = join(destination, 'agent-desktop-win32-x64.exe');
  const unusedHelper = join(destination, 'unused-helper');

  const before = readdirSync(destination);
  const stagingBefore = stagingLeftovers();
  postinstall.installArchive(payload.tarball, binary, unusedHelper, resolve('win32', 'x64'));

  assert.equal(readFileSync(binary, 'utf8'), 'cli-win-build');
  assert.deepEqual(stagingLeftovers(), stagingBefore, 'installArchive stages in the package bin directory and must remove it');
  const newEntries = readdirSync(destination).filter((name) => !before.includes(name));
  assert.deepEqual(
    newEntries.map((name) => join(destination, name)).sort(),
    [binary, `${binary}.sha256`].sort(),
    'installing leaves the executable and its digest sidecar, and nothing else',
  );
  assert.ok(
    postinstall.matchesRecordedDigest(binary),
    'the recorded digest must match the installed bytes',
  );
});

test('a corrupted installed binary is not served by the fast path', () => {
  const payload = archive({ 'agent-desktop.exe': 'cli-win-build' });
  const destination = temporaryDirectory();
  const binary = join(destination, 'agent-desktop-win32-x64.exe');

  postinstall.installArchive(
    payload.tarball,
    binary,
    join(destination, 'unused-helper'),
    resolve('win32', 'x64'),
  );
  assert.ok(postinstall.matchesRecordedDigest(binary));

  writeFileSync(binary, 'tampered-or-truncated');
  assert.equal(
    postinstall.matchesRecordedDigest(binary),
    false,
    'a binary whose bytes changed since install must not be declared ready',
  );

  unlinkSync(`${binary}.sha256`);
  assert.equal(
    postinstall.matchesRecordedDigest(binary),
    false,
    'a binary with no recorded digest is unverifiable, so it re-downloads once',
  );
});

test('staging cleanup removes its own extract directory and a planted survivor is detectable', () => {
  const payload = archive({ 'agent-desktop.exe': 'cli-win-build' });
  const destination = temporaryDirectory();
  const binary = join(destination, 'agent-desktop-win32-x64.exe');
  const npmBin = join(__dirname, '..', '..', 'npm', 'bin');
  const planted = join(npmBin, '.extract-invert-survivor');
  mkdirSync(planted);
  try {
    postinstall.installArchive(
      payload.tarball,
      binary,
      join(destination, 'unused-helper'),
      resolve('win32', 'x64'),
    );
    const leftovers = readdirSync(npmBin).filter((name) => name.startsWith('.extract-'));
    assert.deepEqual(
      leftovers.sort(),
      ['.extract-invert-survivor'],
      'the real staging must be cleaned while a planted survivor stays detectable',
    );
  } finally {
    rmSync(planted, { recursive: true, force: true });
  }
});

test('archive installation removes its staging directory on macOS', () => {
  const payload = archive({
    'agent-desktop': 'cli-build-v2',
    'agent-desktop-macos-helper': 'helper-build-v2',
  });
  const destination = temporaryDirectory();
  const binary = join(destination, 'agent-desktop-darwin-arm64');
  const helper = join(destination, 'agent-desktop-macos-helper');

  const darwin = postinstallAs('darwin');
  const stagingBefore = stagingLeftovers();
  const warnings = captureWarnings(() =>
    darwin.installArchive(
      payload.tarball,
      binary,
      helper,
      resolve('darwin', 'arm64'),
    ),
  );

  assert.equal(readFileSync(binary, 'utf8'), 'cli-build-v2');
  assert.equal(readFileSync(helper, 'utf8'), 'helper-build-v2');
  assert.equal(warnings, '');
  assert.deepEqual(stagingLeftovers(), stagingBefore, 'installArchive stages in the package bin directory and must remove it');
});

test('custom helper override must be absolute', () => {
  process.env.AGENT_DESKTOP_MACOS_HELPER_PATH = 'relative-helper';
  assert.throws(
    () => postinstall.customHelperPath('/tmp/agent-desktop'),
    /must be an absolute path/,
  );
});

const EXPECTED_PLATFORM_ROWS = {
  'darwin-arm64': {
    target: 'aarch64-apple-darwin',
    binaryName: 'agent-desktop-darwin-arm64',
    entries: ['agent-desktop', 'agent-desktop-macos-helper'],
    released: true,
  },
  'darwin-x64': {
    target: 'x86_64-apple-darwin',
    binaryName: 'agent-desktop-darwin-x64',
    entries: ['agent-desktop', 'agent-desktop-macos-helper'],
    released: true,
  },
  'linux-arm64': {
    target: 'aarch64-unknown-linux-gnu',
    binaryName: 'agent-desktop-linux-arm64',
    entries: ['agent-desktop', 'agent-desktop-linux-clipboard-owner'],
    released: true,
  },
  'linux-x64': {
    target: 'x86_64-unknown-linux-gnu',
    binaryName: 'agent-desktop-linux-x64',
    entries: ['agent-desktop', 'agent-desktop-linux-clipboard-owner'],
    released: true,
  },
  'win32-arm64': {
    target: 'aarch64-pc-windows-msvc',
    binaryName: 'agent-desktop-win32-arm64.exe',
    entries: ['agent-desktop.exe'],
    released: true,
  },
  'win32-x64': {
    target: 'x86_64-pc-windows-msvc',
    binaryName: 'agent-desktop-win32-x64.exe',
    entries: ['agent-desktop.exe'],
    released: true,
  },
};

test('tar resolves to the in-box Windows archiver and to PATH everywhere else', () => {
  const fakeSystemRoot = temporaryDirectory();
  const system32 = join(fakeSystemRoot, 'System32');
  mkdirSync(system32);
  const inBox = join(system32, 'tar.exe');
  writeFileSync(inBox, 'stand-in');

  assert.equal(
    tarCommand('win32', { SystemRoot: fakeSystemRoot }),
    inBox,
    'Windows must use the in-box bsdtar by absolute path: a PATH-resolved tar finds GNU tar on any machine with Git for Windows, and GNU tar reads a drive-letter path as a remote host',
  );
  assert.equal(
    tarCommand('win32', { windir: fakeSystemRoot }),
    inBox,
    'windir is the older spelling of the same variable and must resolve identically',
  );
  assert.equal(
    tarCommand('win32', {}),
    'tar',
    'a Windows without SystemRoot falls back to PATH rather than refusing to install',
  );
  assert.equal(
    tarCommand('win32', { SystemRoot: temporaryDirectory() }),
    'tar',
    'a Windows whose System32 has no tar.exe falls back to PATH',
  );
  for (const other of ['darwin', 'linux']) {
    assert.equal(tarCommand(other, { SystemRoot: fakeSystemRoot }), 'tar');
  }
});

test('resolve returns target triple, binary name, entry set and released flag for every platform row', () => {
  assert.deepEqual(Object.keys(PLATFORMS).sort(), Object.keys(EXPECTED_PLATFORM_ROWS).sort());
  for (const [key, expected] of Object.entries(EXPECTED_PLATFORM_ROWS)) {
    const separator = key.indexOf('-');
    const entry = resolve(key.slice(0, separator), key.slice(separator + 1));
    assert.deepEqual(entry, expected, `unexpected resolution for ${key}`);
  }
  assert.equal(resolve('sunos', 'x64'), undefined);
  for (const key of ['linux-x64', 'linux-arm64']) {
    assert.deepEqual(helperNames(PLATFORMS[key]), ['agent-desktop-linux-clipboard-owner'], key);
  }
  assert.deepEqual(helperNames(PLATFORMS['win32-x64']), []);
});

test('tarball name matches the template postinstall previously constructed inline', () => {
  assert.equal(tarballName('0.8.3', 'aarch64-apple-darwin'), 'agent-desktop-v0.8.3-aarch64-apple-darwin.tar.gz');
  assert.equal(tarballName('0.8.3', 'x86_64-pc-windows-msvc'), 'agent-desktop-v0.8.3-x86_64-pc-windows-msvc.tar.gz');
});

test('postinstall refuses unsupported platforms with exit code 0 and names the released keys', async () => {
  for (const [osPlatform, osArch] of [['linux', 'riscv64'], ['freebsd', 'x64']]) {
    const { code, stderr } = await runScriptWithOsStub(postinstallScriptPath, osPlatform, osArch);
    assert.equal(code, 0, `expected exit 0 for ${osPlatform}-${osArch}`);
    const lines = stderr.split('\n').filter((line) => line.startsWith('agent-desktop: '));
    assert.equal(
      lines[0],
      `agent-desktop: agent-desktop has no released native binary for ${osPlatform}-${osArch}.`,
      `unexpected refusal output for ${osPlatform}-${osArch}`,
    );
    assert.match(lines[1], /^agent-desktop: Released platform keys today: darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-arm64, win32-x64\.$/);
    assert.equal(lines[2], 'agent-desktop: See: https://github.com/vercel-labs/agent-desktop');
  }
});

test('the manual fallback names installed destinations the wrapper resolves', () => {
  const warnings = captureWarnings(() =>
    postinstall.printManualFallback(
      'https://example.invalid/tarball.tar.gz',
      'https://example.invalid/checksums.txt',
      resolve('win32', 'arm64'),
    ),
  );
  assert.match(warnings, /Download manually from:/);
  assert.match(warnings, /https:\/\/example\.invalid\/tarball\.tar\.gz/);
  assert.match(warnings, /bin\\agent-desktop-win32-arm64\.exe|bin\/agent-desktop-win32-arm64\.exe/);
  assert.ok(!warnings.includes('agent-desktop-macos-helper'));
  const darwin = captureWarnings(() =>
    postinstall.printManualFallback(
      'https://example.invalid/tarball.tar.gz',
      'https://example.invalid/checksums.txt',
      resolve('darwin', 'arm64'),
    ),
  );
  assert.match(darwin, /agent-desktop-darwin-arm64/);
  assert.match(darwin, /agent-desktop-macos-helper/);
  assert.match(warnings, /curl -fsSL https:\/\/example\.invalid\/checksums\.txt/);
  assert.match(warnings, /sha256sum <downloaded-archive>/);
  assert.match(warnings, /gh attestation verify <downloaded-archive> --repo vercel-labs\/agent-desktop/);
});

function promptSkillOutputFor(osPlatform) {
  const os = require('node:os');
  const originalPlatform = os.platform;
  os.platform = () => osPlatform;
  const modulePath = require.resolve('../../npm/scripts/postinstall.js');
  try {
    delete require.cache[modulePath];
    const fresh = require('../../npm/scripts/postinstall.js');
    return captureWarnings(() => {
      fresh.promptSkillInstall();
      return '';
    });
  } finally {
    os.platform = originalPlatform;
    delete require.cache[modulePath];
  }
}

test('prompted skills are a subset of the skill packages that exist', () => {
  const skillsDir = join(__dirname, '..', '..', 'skills');
  for (const osPlatform of ['darwin', 'win32', 'linux']) {
    const output = promptSkillOutputFor(osPlatform);
    const advertised = [...output.matchAll(/--skill ([a-z0-9-]+)/g)].map((m) => m[1]);
    assert.ok(advertised.includes('agent-desktop'), `${osPlatform} must advertise the base skill`);
    for (const name of advertised) {
      assert.ok(existsSync(join(skillsDir, name, 'SKILL.md')), `advertised ${name} must exist`);
    }
  }
  assert.match(promptSkillOutputFor('win32'), /--skill agent-desktop-windows/);
  assert.match(promptSkillOutputFor('darwin'), /--skill agent-desktop-macos/);
  assert.doesNotMatch(promptSkillOutputFor('darwin'), /agent-desktop-windows/);
  assert.match(promptSkillOutputFor('linux'), /--skill agent-desktop-linux/);
  assert.doesNotMatch(promptSkillOutputFor('linux'), /agent-desktop-(macos|windows)/);
});

function binWithWrapper(segments = ['node_modules', 'agent-desktop', 'bin']) {
  const dir = join(temporaryDirectory(), ...segments);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'agent-desktop'), '#!/usr/bin/env node\n', { mode: 0o755 });
  writeFileSync(join(dir, 'agent-desktop-darwin-arm64'), 'native', { mode: 0o755 });
  return dir;
}

test('bin entry becomes a hard link to the native binary and stays executable', {
  skip: process.platform === 'win32',
}, () => {
  const dir = binWithWrapper();
  const warnings = captureWarnings(() => {
    assert.equal(postinstall.linkBinEntry(dir, 'agent-desktop-darwin-arm64', 'darwin'), true);
  });
  const entry = lstatSync(join(dir, 'agent-desktop'));
  const native = lstatSync(join(dir, 'agent-desktop-darwin-arm64'));
  assert.equal(entry.ino, native.ino);
  assert.ok(entry.mode & 0o111, 'linked entry must be executable');
  assert.equal(readFileSync(join(dir, 'agent-desktop'), 'utf8'), 'native');
  assert.match(warnings, /Native binary linked: each call runs without the Node launcher/);
  assert.deepEqual(readdirSync(dir).filter((name) => name.includes('.link-')), []);
});

test('linking the bin entry twice is a no-op', {
  skip: process.platform === 'win32',
}, () => {
  const dir = binWithWrapper();
  postinstall.linkBinEntry(dir, 'agent-desktop-darwin-arm64', 'darwin');
  const warnings = captureWarnings(() => {
    assert.equal(postinstall.linkBinEntry(dir, 'agent-desktop-darwin-arm64', 'darwin'), false);
  });
  assert.equal(warnings, '');
});

test('bin entry is relinked after the native binary is replaced', {
  skip: process.platform === 'win32',
}, () => {
  const dir = binWithWrapper();
  postinstall.linkBinEntry(dir, 'agent-desktop-darwin-arm64', 'darwin');
  const native = join(dir, 'agent-desktop-darwin-arm64');
  writeFileSync(`${native}.next`, 'newer', { mode: 0o755 });
  renameSync(`${native}.next`, native);
  assert.equal(postinstall.linkBinEntry(dir, 'agent-desktop-darwin-arm64', 'darwin'), true);
  assert.equal(readFileSync(join(dir, 'agent-desktop'), 'utf8'), 'newer');
});

test('bin entry is untouched outside node_modules', () => {
  const dir = binWithWrapper(['checkout', 'bin']);
  assert.equal(postinstall.linkBinEntry(dir, 'agent-desktop-darwin-arm64', 'darwin'), false);
  assert.equal(readFileSync(join(dir, 'agent-desktop'), 'utf8'), '#!/usr/bin/env node\n');
});

test('bin entry is untouched on win32', () => {
  const dir = binWithWrapper();
  assert.equal(postinstall.linkBinEntry(dir, 'agent-desktop-darwin-arm64', 'win32'), false);
  assert.equal(readFileSync(join(dir, 'agent-desktop'), 'utf8'), '#!/usr/bin/env node\n');
});

test('bin entry keeps the wrapper when the native binary is missing', () => {
  const dir = join(temporaryDirectory(), 'node_modules', 'agent-desktop', 'bin');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'agent-desktop'), '#!/usr/bin/env node\n', { mode: 0o755 });
  const warnings = captureWarnings(() => {
    assert.equal(postinstall.linkBinEntry(dir, 'agent-desktop-darwin-arm64', 'darwin'), false);
  });
  assert.equal(readFileSync(join(dir, 'agent-desktop'), 'utf8'), '#!/usr/bin/env node\n');
  assert.match(warnings, /keeping the Node wrapper/);
  assert.notEqual(process.exitCode, 1);
});

test('bin entry is untouched under an unrelated node_modules ancestor', () => {
  const dir = binWithWrapper(['node_modules', 'sandbox', 'agent-desktop', 'npm', 'bin']);
  assert.equal(postinstall.linkBinEntry(dir, 'agent-desktop-darwin-arm64', 'darwin'), false);
  assert.equal(readFileSync(join(dir, 'agent-desktop'), 'utf8'), '#!/usr/bin/env node\n');
});

test('a leftover temporary link does not block linking', {
  skip: process.platform === 'win32',
}, () => {
  const dir = binWithWrapper();
  writeFileSync(join(dir, `agent-desktop.link-${process.pid}`), 'stale');
  captureWarnings(() => {
    assert.equal(postinstall.linkBinEntry(dir, 'agent-desktop-darwin-arm64', 'darwin'), true);
  });
  assert.equal(readFileSync(join(dir, 'agent-desktop'), 'utf8'), 'native');
});

test('a failed relink that leaves an older native entry fails the install', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, () => {
  const dir = binWithWrapper();
  captureWarnings(() => postinstall.linkBinEntry(dir, 'agent-desktop-darwin-arm64', 'darwin'));
  const native = join(dir, 'agent-desktop-darwin-arm64');
  writeFileSync(`${native}.next`, 'newer', { mode: 0o755 });
  renameSync(`${native}.next`, native);
  chmodSync(dir, 0o555);
  try {
    const warnings = captureWarnings(() => {
      assert.equal(postinstall.linkBinEntry(dir, 'agent-desktop-darwin-arm64', 'darwin'), false);
    });
    assert.match(warnings, /Could not link bin entry to the installed native binary/);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = 0;
    chmodSync(dir, 0o755);
  }
});

test('postinstall links the bin entry of an installed package to the native binary', {
  skip: process.platform === 'win32',
}, async () => {
  const root = join(temporaryDirectory(), 'node_modules', 'agent-desktop');
  for (const part of ['package.json', 'bin/agent-desktop', 'lib/platform.js', 'scripts/postinstall.js']) {
    mkdirSync(join(root, part, '..'), { recursive: true });
    writeFileSync(join(root, part), readFileSync(join(__dirname, '..', '..', 'npm', part)), { mode: 0o755 });
  }
  const source = join(temporaryDirectory(), 'release');
  mkdirSync(source);
  writeFileSync(join(source, 'agent-desktop'), 'native', { mode: 0o755 });
  writeFileSync(join(source, 'agent-desktop-macos-helper'), 'helper', { mode: 0o755 });
  process.env.AGENT_DESKTOP_BINARY_PATH = join(source, 'agent-desktop');
  try {
    const { code, stderr } = await runScriptWithOsStub(join(root, 'scripts', 'postinstall.js'), 'darwin', 'arm64');
    assert.equal(code, 0, stderr);
    assert.match(stderr, /Native binary linked: each call runs without the Node launcher/);
  } finally {
    delete process.env.AGENT_DESKTOP_BINARY_PATH;
  }
  const entry = lstatSync(join(root, 'bin', 'agent-desktop'));
  assert.equal(entry.ino, lstatSync(join(root, 'bin', 'agent-desktop-darwin-arm64')).ino);
  assert.equal(readFileSync(join(root, 'bin', 'agent-desktop-macos-helper'), 'utf8'), 'helper');
});
