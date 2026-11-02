const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} = require('node:fs');
const { join } = require('node:path');
const { afterEach, test } = require('node:test');

const { LINUX_HELPER_NAME, resolve, tarballName } = require('../../npm/lib/platform.js');
const {
  createTemporaryRoots,
  postinstallAs,
  runScriptWithOsStub,
} = require('./helpers.js');

const { temporaryDirectory, drainRoots } = createTemporaryRoots();
const npmRoot = join(__dirname, '..', '..', 'npm');
const POSIX_ONLY = process.platform === 'win32' ? 'the curl double and tar fixtures are POSIX shell' : false;
const VERSION = JSON.parse(readFileSync(join(npmRoot, 'package.json'), 'utf8')).version;

afterEach(() => {
  for (const root of drainRoots()) {
    require('node:fs').rmSync(root, { recursive: true, force: true });
  }
});

const CURL_DOUBLE = [
  '#!/bin/sh',
  'url=""; out=""',
  'while [ $# -gt 0 ]; do',
  '  case "$1" in',
  '    -o) out="$2"; shift 2 ;;',
  '    --retry|--retry-delay) shift 2 ;;',
  '    -*) shift ;;',
  '    *) url="$1"; shift ;;',
  '  esac',
  'done',
  'echo "$url" >> "$AD_TEST_CURL_LOG"',
  'src="$AD_TEST_SERVE/${url##*/}"',
  '[ -f "$src" ] || exit 22',
  'cat "$src" > "$out"',
  '',
].join('\n');

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function toolPath(name) {
  for (const directory of ['/usr/bin', '/bin']) {
    if (existsSync(join(directory, name))) return join(directory, name);
  }
  throw new Error(`no ${name} on this host`);
}

function makeArchive(root, members) {
  const source = join(root, `source-${Math.random().toString(16).slice(2)}`);
  mkdirSync(source);
  for (const [name, contents] of Object.entries(members)) {
    writeFileSync(join(source, name), contents, { mode: 0o755 });
    chmodSync(join(source, name), 0o755);
  }
  const tarball = join(root, `archive-${Math.random().toString(16).slice(2)}.tar.gz`);
  execFileSync('tar', ['-czf', tarball, '-C', source, ...Object.keys(members)]);
  return tarball;
}

function packageCopy() {
  const dir = join(temporaryDirectory(), 'npm');
  mkdirSync(join(dir, 'bin'), { recursive: true });
  cpSync(join(npmRoot, 'bin', 'agent-desktop'), join(dir, 'bin', 'agent-desktop'));
  cpSync(join(npmRoot, 'lib'), join(dir, 'lib'), { recursive: true });
  cpSync(join(npmRoot, 'scripts'), join(dir, 'scripts'), { recursive: true });
  cpSync(join(npmRoot, 'package.json'), join(dir, 'package.json'));
  return dir;
}

const GOOD_MEMBERS = {
  'agent-desktop': 'cli-linux-build',
  [LINUX_HELPER_NAME]: 'helper-linux-build',
};

// Runs the installer as a subprocess on a stubbed linux-x64 identity against a
// fresh copy of the package, with a PATH that holds only a curl double and the
// tools the case keeps. Nothing in the repository's npm/bin is touched.
async function install({
  members = GOOD_MEMBERS,
  tarball,
  checksum,
  withCurl = true,
  withTar = true,
  withGzip = true,
  serveChecksumsAs,
  packageDir = packageCopy(),
  extraEnv = {},
} = {}) {
  const scratch = temporaryDirectory();
  const serve = join(scratch, 'serve');
  const tools = join(scratch, 'tools');
  mkdirSync(serve);
  mkdirSync(tools);
  const entry = resolve('linux', 'x64');
  const name = tarballName(VERSION, entry.target);
  const archivePath = tarball ?? makeArchive(scratch, members);
  writeFileSync(join(serve, name), readFileSync(archivePath));
  const hash = checksum ?? sha256(archivePath);
  writeFileSync(join(serve, 'checksums.txt'), serveChecksumsAs ?? `${hash}  ${name}\n`);
  if (withCurl) {
    writeFileSync(join(tools, 'curl'), CURL_DOUBLE, { mode: 0o755 });
    chmodSync(join(tools, 'curl'), 0o755);
  }
  symlinkSync(toolPath('cat'), join(tools, 'cat'));
  if (withTar) {
    symlinkSync(toolPath('tar'), join(tools, 'tar'));
    if (withGzip) symlinkSync(toolPath('gzip'), join(tools, 'gzip'));
  }
  const curlLog = join(scratch, 'curl.log');
  writeFileSync(curlLog, '');
  const { code, stderr } = await runScriptWithOsStub(
    join(packageDir, 'scripts', 'postinstall.js'),
    'linux',
    'x64',
    [],
    { PATH: tools, AD_TEST_SERVE: serve, AD_TEST_CURL_LOG: curlLog, ...extraEnv },
  );
  const requests = readFileSync(curlLog, 'utf8').split('\n').filter(Boolean);
  return { code, stderr, packageDir, binDir: join(packageDir, 'bin'), requests };
}

function binContents(binDir) {
  return readdirSync(binDir).sort();
}

test('a Linux install places the CLI and the helper under their own names and removes the staging', { skip: POSIX_ONLY }, async () => {
  const { code, stderr, binDir, requests } = await install();
  assert.equal(code, 0, stderr);
  assert.match(stderr, /Checksum verified/);
  assert.match(stderr, /Installed native executables: agent-desktop-linux-x64, agent-desktop-linux-clipboard-owner/);
  assert.doesNotMatch(stderr, /Could not move cleanup artifact to Trash/);
  assert.equal(readFileSync(join(binDir, 'agent-desktop-linux-x64'), 'utf8'), 'cli-linux-build');
  assert.equal(readFileSync(join(binDir, LINUX_HELPER_NAME), 'utf8'), 'helper-linux-build');
  for (const file of ['agent-desktop-linux-x64', LINUX_HELPER_NAME]) {
    assert.equal(statSync(join(binDir, file)).mode & 0o111, 0o111, `${file} must be executable`);
    assert.equal(readFileSync(join(binDir, `${file}.sha256`), 'utf8').trim(), sha256(join(binDir, file)));
  }
  assert.deepEqual(binContents(binDir), [
    'agent-desktop',
    'agent-desktop-linux-clipboard-owner',
    'agent-desktop-linux-clipboard-owner.sha256',
    'agent-desktop-linux-x64',
    'agent-desktop-linux-x64.sha256',
  ]);
  assert.equal(requests.length, 2);
  assert.match(requests[0], /agent-desktop-v.*-x86_64-unknown-linux-gnu\.tar\.gz$/);
  assert.match(requests[1], /checksums\.txt$/);
});

test('a second install reuses the recorded digests and downloads nothing', { skip: POSIX_ONLY }, async () => {
  const first = await install();
  assert.equal(first.code, 0, first.stderr);
  const second = await install({ packageDir: first.packageDir });
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.requests.length, 0, 'the second install must make zero downloads');
  assert.match(second.stderr, /Native executables ready: agent-desktop-linux-x64, agent-desktop-linux-clipboard-owner/);
});

test('a tampered helper makes the next install download again', { skip: POSIX_ONLY }, async () => {
  const first = await install();
  writeFileSync(join(first.binDir, LINUX_HELPER_NAME), 'tampered');
  const second = await install({ packageDir: first.packageDir });
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.requests.length, 2, 'a helper that differs from its recorded digest must be fetched again');
  assert.equal(readFileSync(join(second.binDir, LINUX_HELPER_NAME), 'utf8'), 'helper-linux-build');
});

test('GNU tar without gzip fails the install explicitly and cleans up', {
  skip: process.platform !== 'linux' ? 'GNU tar requires an external gzip on Linux' : false,
}, async () => {
  const { code, stderr, binDir } = await install({ withGzip: false });
  assert.equal(code, 1, stderr);
  assert.match(stderr, /gzip: Cannot exec|gzip:.*not found/);
  assert.match(stderr, /Download manually from:/);
  assert.deepEqual(binContents(binDir), ['agent-desktop']);
});

for (const [name, options, expected] of [
  ['a corrupt archive with a matching checksum', null, /tar|gzip|not in gzip format|Unrecognized archive/i],
  ['a checksum that does not match', { checksum: 'f'.repeat(64) }, /Checksum verification failed/],
  ['a checksums file with no entry for the archive', { serveChecksumsAs: `${'a'.repeat(64)}  other.tar.gz\n` }, /Checksum entry missing/],
  ['an archive with an unexpected member', { members: { ...GOOD_MEMBERS, extra: 'x' } }, /unexpected entries: agent-desktop, agent-desktop-linux-clipboard-owner, extra/],
  ['an archive that omits the helper', { members: { 'agent-desktop': 'cli-only' } }, /unexpected entries: agent-desktop$/m],
  ['no curl on PATH', { withCurl: false }, /spawnSync curl ENOENT/],
  ['no tar on PATH', { withTar: false }, /spawnSync tar ENOENT/],
]) {
  test(`${name} fails the install explicitly and leaves nothing behind`, { skip: POSIX_ONLY }, async () => {
    const scratch = temporaryDirectory();
    let args = options;
    if (args === null) {
      const corrupt = join(scratch, 'corrupt.tar.gz');
      writeFileSync(corrupt, 'this is not a gzip stream');
      args = { tarball: corrupt };
    }
    const { code, stderr, binDir } = await install(args);
    assert.equal(code, 1, stderr);
    assert.match(stderr, expected);
    assert.match(stderr, /Download manually from:/);
    assert.match(stderr, /agent-desktop-linux-clipboard-owner/, 'the fallback names the helper destination');
    assert.deepEqual(binContents(binDir), ['agent-desktop'], 'a failed install keeps no archive, checksums, staging or executable');
  });
}

test('the wrapper identifies an incomplete package when the bundled native binary is missing', { skip: POSIX_ONLY }, async () => {
  const dir = packageCopy();
  const { code, stderr } = await runScriptWithOsStub(
    join(dir, 'bin', 'agent-desktop'),
    'linux',
    'x64',
    ['version'],
  );
  assert.equal(code, 1);
  assert.match(stderr, /Error: Native binary not found for linux-x64/);
  assert.match(stderr, /installed package is incomplete/);
  assert.match(stderr, /Expected: .*agent-desktop-linux-x64/);
});

test('AGENT_DESKTOP_BINARY_PATH on Linux installs the helper found beside the binary', { skip: POSIX_ONLY }, async () => {
  const scratch = temporaryDirectory();
  const custom = join(scratch, 'agent-desktop');
  writeFileSync(custom, 'custom-cli', { mode: 0o755 });
  writeFileSync(join(scratch, LINUX_HELPER_NAME), 'custom-helper', { mode: 0o755 });
  const packageDir = packageCopy();
  const { code, stderr } = await runScriptWithOsStub(
    join(packageDir, 'scripts', 'postinstall.js'),
    'linux',
    'x64',
    [],
    { AGENT_DESKTOP_BINARY_PATH: custom, PATH: '' },
  );
  assert.equal(code, 0, stderr);
  assert.equal(readFileSync(join(packageDir, 'bin', 'agent-desktop-linux-x64'), 'utf8'), 'custom-cli');
  assert.equal(readFileSync(join(packageDir, 'bin', LINUX_HELPER_NAME), 'utf8'), 'custom-helper');

  const lonely = join(temporaryDirectory(), 'agent-desktop');
  writeFileSync(lonely, 'custom-cli', { mode: 0o755 });
  const missing = await runScriptWithOsStub(
    join(packageCopy(), 'scripts', 'postinstall.js'),
    'linux',
    'x64',
    [],
    { AGENT_DESKTOP_BINARY_PATH: lonely, PATH: '' },
  );
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, new RegExp(`${LINUX_HELPER_NAME} not found at`));
});

test('staging cleanup removes nested files on every platform without external tools', () => {
  const priorPath = process.env.PATH;
  process.env.PATH = temporaryDirectory();
  try {
    for (const platform of ['linux', 'darwin', 'win32']) {
      const installer = postinstallAs(platform);
      const staged = join(temporaryDirectory(), 'staged');
      mkdirSync(staged);
      writeFileSync(join(staged, 'agent-desktop'), 'copy');
      installer.cleanupStaging(staged);
      assert.equal(existsSync(staged), false, platform);
    }
  } finally {
    process.env.PATH = priorPath;
  }
});

test('the manual fallback on Linux names both destinations', () => {
  const entry = resolve('linux', 'x64');
  const { printManualFallback } = require('../../npm/scripts/postinstall.js');
  const chunks = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    printManualFallback('https://example.invalid/a.tar.gz', 'https://example.invalid/checksums.txt', entry);
  } finally {
    process.stderr.write = write;
  }
  const text = chunks.join('');
  assert.match(text, /agent-desktop-linux-x64/);
  assert.match(text, /agent-desktop-linux-clipboard-owner/);
});
