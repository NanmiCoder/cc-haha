const assert = require('node:assert/strict');
const { spawnSync, execFileSync } = require('node:child_process');
const { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { afterEach, test } = require('node:test');

const { createTemporaryRoots } = require('./helpers.js');

const { temporaryDirectory, drainRoots } = createTemporaryRoots();
const root = join(__dirname, '..', '..');
const script = join(root, 'scripts', 'check-linux-archive-contents.sh');
const HELPER = 'agent-desktop-linux-clipboard-owner';
const POSIX_ONLY = process.platform === 'win32' ? 'the check is a bash script' : false;

afterEach(() => {
  for (const dir of drainRoots()) rmSync(dir, { recursive: true, force: true });
});

function writeMember(dir, relative, contents, mode = 0o755) {
  const path = join(dir, relative);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents);
  chmodSync(path, mode);
}

function cliArchive({ omit = [], extra = {}, modes = {} } = {}) {
  const dir = temporaryDirectory();
  const members = { 'agent-desktop': 'cli', [HELPER]: 'helper', ...extra };
  for (const name of omit) delete members[name];
  for (const [name, contents] of Object.entries(members)) writeMember(dir, name, contents, modes[name] ?? 0o755);
  const tarball = join(temporaryDirectory(), 'cli.tar.gz');
  execFileSync('tar', ['-czf', tarball, '-C', dir, ...Object.keys(members)]);
  return tarball;
}

function ffiReadme({ drop = [] } = {}) {
  let text = `# agent-desktop FFI\n${readFileSync(join(root, 'scripts', 'ffi-archive-readme-linux.md'), 'utf8')}`;
  text += `- \`lib/${HELPER}\` - helper\n`;
  for (const phrase of drop) text = text.split(phrase).join('removed');
  return text;
}

function ffiArchive({ omit = [], modes = {}, readme = ffiReadme() } = {}) {
  const dir = temporaryDirectory();
  const stage = 'agent-desktop-ffi-v0.0.0-x86_64-unknown-linux-gnu';
  const members = {
    'lib/libagent_desktop_ffi.so': 'lib',
    [`lib/${HELPER}`]: 'helper',
    'include/agent_desktop.h': 'header',
    LICENSE: 'license',
    'README.md': readme,
    SHA256SUMS: 'sums',
  };
  for (const name of omit) delete members[name];
  for (const [name, contents] of Object.entries(members)) {
    writeMember(dir, join(stage, name), contents, modes[name] ?? (name === `lib/${HELPER}` ? 0o755 : 0o644));
  }
  const tarball = join(temporaryDirectory(), 'ffi.tar.gz');
  execFileSync('tar', ['-czf', tarball, '-C', dir, stage]);
  return tarball;
}

function run(...args) {
  const result = spawnSync('bash', [script, ...args], { encoding: 'utf8', cwd: root });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

test('a CLI archive with exactly the executable and the helper passes', { skip: POSIX_ONLY }, () => {
  const { code, out } = run('cli', cliArchive());
  assert.equal(code, 0, out);
});

test('a CLI archive that omits the helper fails and names the listing', { skip: POSIX_ONLY }, () => {
  const { code, out } = run('cli', cliArchive({ omit: [HELPER] }));
  assert.equal(code, 1);
  assert.match(out, /expected exactly/);
});

test('a CLI archive with an extra member fails', { skip: POSIX_ONLY }, () => {
  const { code } = run('cli', cliArchive({ extra: { stray: 'x' } }));
  assert.equal(code, 1);
});

test('a CLI archive whose helper is not executable fails', { skip: POSIX_ONLY }, () => {
  const { code, out } = run('cli', cliArchive({ modes: { [HELPER]: 0o644 } }));
  assert.equal(code, 1);
  assert.match(out, /not all executable/);
});

test('an FFI archive with the library, the helper beside it and the README text passes', { skip: POSIX_ONLY }, () => {
  const { code, out } = run('ffi', ffiArchive());
  assert.equal(code, 0, out);
});

test('an FFI archive that omits the helper fails', { skip: POSIX_ONLY }, () => {
  const { code, out } = run('ffi', ffiArchive({ omit: [`lib/${HELPER}`] }));
  assert.equal(code, 1);
  assert.match(out, new RegExp(`does not list .*lib/${HELPER}`));
});

test('an FFI archive that omits the library fails', { skip: POSIX_ONLY }, () => {
  const { code, out } = run('ffi', ffiArchive({ omit: ['lib/libagent_desktop_ffi.so'] }));
  assert.equal(code, 1);
  assert.match(out, /libagent_desktop_ffi\.so/);
});

test('an FFI archive whose helper is not executable fails', { skip: POSIX_ONLY }, () => {
  const { code, out } = run('ffi', ffiArchive({ modes: { [`lib/${HELPER}`]: 0o644 } }));
  assert.equal(code, 1);
  assert.match(out, /is not executable/);
});

test('an FFI archive whose README drops a stated limit fails', { skip: POSIX_ONLY }, () => {
  for (const phrase of ['glibc 2.35', 'SONAME', 'one at a time', 'carry text only', 'wl-clipboard']) {
    const { code, out } = run('ffi', ffiArchive({ readme: ffiReadme({ drop: [phrase] }) }));
    assert.equal(code, 1, `dropping "${phrase}" must fail the check`);
    assert.match(out, new RegExp(`README does not state '${phrase}'`));
  }
});

test('the npm table check passes for both Linux keys and refuses any other key', { skip: POSIX_ONLY }, () => {
  for (const key of ['linux-x64', 'linux-arm64']) {
    const { code, out } = run('npm', key);
    assert.equal(code, 0, out);
  }
  assert.equal(run('npm', 'darwin-arm64').code, 2);
});

test('the combined check fails when any one channel fails', { skip: POSIX_ONLY }, () => {
  const good = { cli: cliArchive(), ffi: ffiArchive() };
  const passing = run('all', good.cli, good.ffi, 'linux-x64');
  assert.equal(passing.code, 0, passing.out);
  assert.equal(run('all', cliArchive({ omit: [HELPER] }), good.ffi, 'linux-x64').code, 1);
  assert.equal(run('all', good.cli, ffiArchive({ omit: [`lib/${HELPER}`] }), 'linux-x64').code, 1);
});

test('bad arguments are a usage error', { skip: POSIX_ONLY }, () => {
  assert.equal(run().code, 2);
  assert.equal(run('cli').code, 2);
  assert.equal(run('unknown', 'x').code, 2);
});
