const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, relative } = require('node:path');
const { test } = require('node:test');
const optimize = require('../../npm/lib/windows-bin');

test('Windows optimization changes only command shims targeting this installation', () => {
  const root = mkdtempSync(join(tmpdir(), 'ad-windows-bin-'));
  const bin = join(root, 'node_modules/agent-desktop/bin');
  mkdirSync(bin, { recursive: true });
  const binary = join(bin, 'agent-desktop-win32-x64.exe');
  writeFileSync(binary, 'native');
  const command = join(root, 'agent-desktop.cmd');
  const otherCommand = join(root, 'node_modules/.bin/agent-desktop.cmd');
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
  const unrelated = '@echo off\nnode other-package/cli.js %*\n';
  writeFileSync(otherCommand, unrelated);
  const target = relative(root, join(bin, 'agent-desktop'));
  writeFileSync(command, `@echo off\nnode "${target}" %*\n`);
  assert.equal(optimize(bin, 'agent-desktop-win32-x64.exe'), true);
  const installed = readFileSync(command, 'utf8');
  assert.ok(installed.includes(`"${binary}" %*`));
  assert.doesNotMatch(installed, /node(?:\.exe)?[ "\t]/);
  assert.equal(readFileSync(otherCommand, 'utf8'), unrelated);
});
