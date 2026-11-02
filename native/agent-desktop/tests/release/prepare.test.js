const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { test } = require('node:test');
const { releaseVersion } = require('../../scripts/release-version');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ad-release-gate-'));
  for (const name of ['scripts', 'npm', 'tools']) mkdirSync(join(root, name));
  writeFileSync(join(root, 'npm/package.json'), '{"version":"0.9.0"}');
  writeFileSync(join(root, 'Cargo.toml'), '[workspace.package]\nversion = "0.10.2"\n');
  writeFileSync(join(root, 'scripts/check-release-consistency.sh'), 'exit 0\n');
  writeFileSync(join(root, 'tools/npm'), '#!/bin/sh\nprintf "%s\\n" "$TEST_NPM_VERSION"\n', { mode: 0o755 });
  writeFileSync(join(root, 'tools/gh'), '#!/bin/sh\nif [ "$1" = release ]; then exit "$TEST_GITHUB_STATUS"; fi\nprintf "%s\\n" "$*" >> "$TEST_GH_LOG"\n', { mode: 0o755 });
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Release Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('add', '.');
  git('commit', '-qm', 'test: create release fixture');
  return { root, git };
}

for (const scenario of [
  { name: 'unchanged published version skips publication', npm: '0.10.2', github: '0', release: 'false', githubRelease: 'false' },
  { name: 'new version prepares publication', npm: '0.10.1', github: '1', release: 'true', githubRelease: 'true' },
  { name: 'missing GitHub release rebuilds the tagged source without republishing npm', npm: '0.10.2', github: '1', release: 'false', githubRelease: 'true', tagged: true },
]) {
  test(scenario.name, { skip: process.platform === 'win32' }, () => {
    const { root, git } = fixture();
    const source = git('rev-parse', 'HEAD');
    if (scenario.tagged) {
      git('tag', '--no-sign', '-m', 'test: release fixture', 'v0.10.2');
      writeFileSync(join(root, 'later.txt'), 'subsequent main commit');
      git('add', '.');
      git('commit', '-qm', 'test: advance main after tag');
    }
    const output = join(root, 'output');
    const log = join(root, 'gh.log');
    writeFileSync(log, '');
    execFileSync('bash', [resolve(__dirname, '../../scripts/prepare-release.sh')], {
      cwd: root,
      env: { ...process.env, PATH: `${join(root, 'tools')}:${process.env.PATH}`,
        GH_REPO: 'fixture/agent-desktop', GITHUB_OUTPUT: output,
        TEST_NPM_VERSION: scenario.npm, TEST_GITHUB_STATUS: scenario.github, TEST_GH_LOG: log },
    });
    const values = Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map((line) => line.split('=')));
    assert.equal(values.should_release, scenario.release);
    assert.equal(values.needs_github_release, scenario.githubRelease);
    assert.equal(values.source_sha, source);
    assert.equal(values.tag_name, 'v0.10.2');
    const calls = readFileSync(log, 'utf8');
    if (scenario.release === 'true') assert.ok(calls.includes(`sha=${source}`));
    else assert.equal(calls, '');
  });
}

test('release checkout accepts only commits in the triggering history', { skip: process.platform === 'win32' }, () => {
  const { root, git } = fixture();
  const ancestor = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'later.txt'), 'trusted main change');
  git('add', '.');
  git('commit', '-qm', 'test: advance trusted main');
  const workflow = git('rev-parse', 'HEAD');
  git('checkout', '--orphan', 'unrelated');
  git('commit', '-qm', 'test: create unrelated history');
  const unrelated = git('rev-parse', 'HEAD');
  git('checkout', '--detach', workflow);
  for (const scenario of [
    { source: unrelated }, { source: 'main; exit 0' }, { source: ancestor },
    { source: ancestor, differentOwner: '1' },
  ]) {
    git('checkout', '--detach', workflow);
    const { source, differentOwner } = scenario;
    const result = spawnSync('bash', [resolve(__dirname, '../../scripts/checkout-release-source.sh')], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, RELEASE_SOURCE_SHA: source, RELEASE_WORKFLOW_SHA: workflow,
        GIT_TEST_ASSUME_DIFFERENT_OWNER: differentOwner },
    });
    assert.equal(result.status, source === ancestor ? 0 : 1, result.stderr);
    assert.equal(git('rev-parse', 'HEAD'), source === ancestor ? ancestor : workflow);
  }
});

test('version comes only from the workspace package section', () => {
  const toml = '[package]\nversion = "9.9.9"\n[workspace.package]\nversion = "1.2.3"\n[dependencies]\nversion = "8.8.8"\n';
  assert.equal(releaseVersion(toml), '1.2.3');
  assert.equal(releaseVersion(toml.replaceAll('\n', '\r\n')), '1.2.3');
  for (const version of ['', '1.2', 'v1.2.3', '1.2.3;echo bad', '01.2.3']) {
    assert.throws(() => releaseVersion(`[workspace.package]\nversion = "${version}"\n`));
  }
  assert.throws(() => releaseVersion('[package]\nversion = "1.2.3"\n'));
});
