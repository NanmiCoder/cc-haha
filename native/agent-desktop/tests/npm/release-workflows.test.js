const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');

const root = join(__dirname, '..', '..');
const read = (relative) => readFileSync(join(root, relative), 'utf8').replace(/\r\n/g, '\n');
const releaseWorkflow = read('.github/workflows/release.yml');
const dryRunWorkflow = read('.github/workflows/release-dry-run.yml');

const HELPER = 'agent-desktop-linux-clipboard-owner';
const CURRENT_HOSTS = /^ubuntu-24\.04(-arm)?$/;
const FLOOR_CONTAINER = /^ubuntu:22\.04@sha256:[0-9a-f]{64}$/;

function jobBlock(workflow, jobName) {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line === `  ${jobName}:`);
  assert.notEqual(start, -1, `workflow must define the ${jobName} job`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}\S/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

function matrixRows(jobText) {
  const rows = [];
  for (const line of jobText.split('\n')) {
    const target = line.match(/^\s*-\s+target:\s*(\S+)/);
    if (target) rows.push({ target: target[1] });
    const runner = line.match(/^\s+runner:\s*(\S+)/);
    if (runner && rows.length > 0) rows[rows.length - 1].runner = runner[1];
    const container = line.match(/^\s+container:\s*(\S+)/);
    if (container && rows.length > 0) rows[rows.length - 1].container = container[1];
  }
  return rows;
}

function linuxRows(jobText) {
  return matrixRows(jobText).filter((row) => row.target.includes('-linux-'));
}

const LINUX_BUILD_JOBS = [
  ['release.yml', releaseWorkflow, ['build', 'build-ffi', 'ffi-release-panic-guard']],
  ['release-dry-run.yml', dryRunWorkflow, ['cli', 'ffi']],
];

test('every Linux matrix row builds inside the pinned Ubuntu 22.04 container on a current runner', () => {
  for (const [file, workflow, jobs] of LINUX_BUILD_JOBS) {
    for (const job of jobs) {
      const rows = linuxRows(jobBlock(workflow, job));
      assert.equal(rows.length, 2, `${file} ${job} must build both Linux architectures`);
      for (const row of rows) {
        assert.match(row.runner ?? '', CURRENT_HOSTS, `${file} ${job} builds ${row.target} on ${row.runner}`);
        assert.match(row.container ?? '', FLOOR_CONTAINER, `${file} ${job} row ${row.target} needs the digest-pinned 22.04 container: a bare host carries its own glibc`);
      }
      assert.deepEqual(
        rows.map((row) => row.target).sort(),
        ['aarch64-unknown-linux-gnu', 'x86_64-unknown-linux-gnu'],
      );
    }
  }
});

test('no Linux build job names ubuntu-latest or a retiring 22.04 label, and each runs in its matrix container', () => {
  for (const [file, workflow, jobs] of LINUX_BUILD_JOBS) {
    for (const job of jobs) {
      const block = jobBlock(workflow, job);
      assert.doesNotMatch(block, /ubuntu-latest/, `${file} ${job}`);
      assert.doesNotMatch(block, /runner: ubuntu-22\.04/, `${file} ${job}`);
      assert.match(block, /^ {4}container: \$\{\{ matrix\.container \}\}$/m, `${file} ${job} must run its job in the matrix container`);
    }
  }
});

test('the Linux live consumers run on the hosted 24.04 desktop host, outside any container, on the archives built in the pinned container', () => {
  const block = jobBlock(dryRunWorkflow, 'linux-consumer');
  const rows = linuxRows(block);
  assert.deepEqual(
    rows.map((row) => [row.target, row.runner]).sort(),
    [
      ['aarch64-unknown-linux-gnu', 'ubuntu-24.04-arm'],
      ['x86_64-unknown-linux-gnu', 'ubuntu-24.04'],
    ],
  );
  for (const row of rows) {
    assert.equal(row.container, undefined, `${row.target} consumer must run on the bare supported desktop host`);
  }
  assert.doesNotMatch(block, /^ {4}container:/m, 'linux-consumer must not run its job in a container');
  assert.match(block, /^ {4}needs: \[cli, ffi\]$/m, 'linux-consumer must consume the archives the build jobs produced');
  assert.match(block, /pattern: "dry-run-\{binary,ffi\}-\$\{\{ matrix\.target \}\}"/, 'linux-consumer must download the container-built archives');
  assert.match(block, /defaults:\n {6}run:\n {8}shell: bash\n/);
});

test('the glibc gate reads every shipped ELF file in both workflows', () => {
  const gated = [
    ['release.yml build', jobBlock(releaseWorkflow, 'build')],
    ['release.yml build-ffi', jobBlock(releaseWorkflow, 'build-ffi')],
    ['release-dry-run.yml cli', jobBlock(dryRunWorkflow, 'cli')],
    ['release-dry-run.yml ffi', jobBlock(dryRunWorkflow, 'ffi')],
  ];
  for (const [name, job] of gated) {
    assert.match(job, /scripts\/check-elf-glibc-floor\.sh/, `${name} must run the glibc gate`);
    assert.match(job, /GLIBC_FLOOR: '2\.35'/, `${name} must pin the 2.35 floor`);
    assert.ok(job.includes(HELPER), `${name} must gate the clipboard owner helper`);
  }
  assert.match(jobBlock(releaseWorkflow, 'build-ffi'), /libagent_desktop_ffi\.so|matrix\.lib_name/);
  assert.match(jobBlock(dryRunWorkflow, 'ffi'), /libagent_desktop_ffi\.so/);
});

test('Linux container run steps select bash instead of the container default sh', () => {
  for (const [file, workflow, jobs] of LINUX_BUILD_JOBS) {
    for (const job of jobs) {
      const block = jobBlock(workflow, job);
      for (const step of block.split(/(?=^ {6}- )/m)) {
        if (/if: runner\.os == 'Linux'/.test(step) && /^ {8}run:/m.test(step)) {
          assert.match(step, /^ {8}shell: bash$/m, `${file} ${job}: ${step.split('\n')[0].trim()}`);
        }
      }
    }
  }
});

test('the Linux CLI archive is built from both executables and listed exactly', () => {
  for (const [name, job] of [
    ['release.yml', jobBlock(releaseWorkflow, 'build')],
    ['release-dry-run.yml', jobBlock(dryRunWorkflow, 'cli')],
  ]) {
    assert.match(job, /name: Create tarball \(Linux\)/, name);
    assert.ok(job.includes(`agent-desktop ${HELPER}`), `${name} must archive the helper beside agent-desktop`);
    assert.match(job, /check-linux-archive-contents\.sh cli/, name);
    assert.match(job, /-p agent-desktop-linux --bins/, `${name} must build the helper binary`);
  }
});

test('the release publishes thirteen assets and waits for the archive contents check', () => {
  assert.match(releaseWorkflow, /EXPECTED_ASSETS: 13/);
  assert.match(releaseWorkflow, /6 CLI tarballs \+ 4 FFI tarballs \+ 2 FFI zips \+ checksums\.txt/);
  const publish = releaseWorkflow.match(/publish-github:\n[\s\S]*?needs: \[([^\]]*)\]/);
  assert.ok(publish && publish[1].includes('linux-archive-contents'));
  assert.match(jobBlock(releaseWorkflow, 'linux-archive-contents'), /check-linux-archive-contents\.sh all/);
});

test('the dry run grants no write scope and has no publish step', () => {
  assert.match(dryRunWorkflow, /^permissions: \{\}$/m, 'top-level permissions must stay empty');
  assert.doesNotMatch(dryRunWorkflow, /:\s*write\b/, 'no permission scope may be write');
  assert.doesNotMatch(dryRunWorkflow, /\bnpm publish\b/);
  assert.doesNotMatch(dryRunWorkflow, /gh release (create|upload|edit)/);
  assert.doesNotMatch(dryRunWorkflow, /attest-build-provenance|secrets\./);
  const jobs = dryRunWorkflow.match(/^ {2}[a-z][a-z-]*:$/gm) ?? [];
  assert.deepEqual(
    jobs.map((job) => job.trim().slice(0, -1)).sort(),
    ['cli', 'ffi', 'linux-archives', 'linux-consumer'],
    'the dry run keeps its CLI, FFI, contents and consumer jobs and gains no publish job',
  );
  for (const job of jobs) {
    const body = jobBlock(dryRunWorkflow, job.trim().slice(0, -1));
    assert.match(body, /permissions:\n {6}contents: read\n/, `${job.trim()} must declare contents: read`);
  }
});

test('the Linux consumer job runs both architectures against the dry-run archives', () => {
  const job = jobBlock(dryRunWorkflow, 'linux-consumer');
  assert.match(job, /needs: \[cli, ffi\]/);
  assert.match(job, /if: \$\{\{ !cancelled\(\) \}\}/, 'an unrelated failed row must not skip the consumer');
  assert.match(job, /dry-run-\{binary,ffi\}-\$\{\{ matrix\.target \}\}/, 'it downloads its own architecture only');
  assert.match(job, /private-session\.sh --wm/);
  assert.match(job, /tests\/linux-dist\/run-consumer\.sh/);
  assert.match(job, /tests\/linux-dist\/run-npm-install\.sh/);
  assert.doesNotMatch(job, /cargo build/, 'the consumer extracts archives and never rebuilds');
});

test('the Linux FFI archive README text states the limits the C API has', () => {
  const readme = read('scripts/ffi-archive-readme-linux.md');
  for (const phrase of ['glibc 2.35', 'SONAME', '-rpath', 'one at a time', 'ad_snapshot', 'carry text only', HELPER, 'wl-clipboard']) {
    assert.ok(readme.includes(phrase), `README text must state "${phrase}"`);
  }
});
