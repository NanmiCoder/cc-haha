const { spawn } = require('node:child_process');
const { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');

const postinstallScriptPath = join(__dirname, '..', '..', 'npm', 'scripts', 'postinstall.js');
const wrapperScriptPath = join(__dirname, '..', '..', 'npm', 'bin', 'agent-desktop');

const OS_STUB_PLATFORM_ENV = 'AGENT_DESKTOP_TEST_OS_PLATFORM';
const OS_STUB_ARCH_ENV = 'AGENT_DESKTOP_TEST_OS_ARCH';

// Read identity from env to avoid code-construction sink (CodeQL concern).
const OS_STUB_SOURCE = [
  "const os = require('os');",
  `const platform = process.env[${JSON.stringify(OS_STUB_PLATFORM_ENV)}];`,
  `const arch = process.env[${JSON.stringify(OS_STUB_ARCH_ENV)}];`,
  'os.platform = () => platform;',
  'os.arch = () => arch;',
  '',
].join('\n');

function writeOsStub(osPlatform, osArch) {
  const known = /^[a-zA-Z0-9]+$/;
  if (!known.test(osPlatform) || !known.test(osArch)) {
    throw new Error(`unsupported os stub identity: ${osPlatform}-${osArch}`);
  }
  const root = mkdtempSync(join(tmpdir(), 'agent-desktop-os-stub-'));
  const stub = join(root, 'stub.js');
  writeFileSync(stub, OS_STUB_SOURCE, { flag: 'wx' });
  return stub;
}

function removeOsStub(stub) {
  try { unlinkSync(stub); } catch {}
  try { rmdirSync(dirname(stub)); } catch {}
}

// The stub reads its identity from the environment, so any caller that spawns
// the stub itself must carry these alongside it.
function osStubEnv(osPlatform, osArch) {
  return { [OS_STUB_PLATFORM_ENV]: osPlatform, [OS_STUB_ARCH_ENV]: osArch };
}

function runScriptWithOsStub(scriptPath, osPlatform, osArch, args = [], environment = {}) {
  const stub = writeOsStub(osPlatform, osArch);
  const env = { ...process.env };
  delete env.AGENT_DESKTOP_SKIP_DOWNLOAD;
  Object.assign(env, osStubEnv(osPlatform, osArch), environment);
  return new Promise((settle) => {
    let settled = false;
    let stderr = '';
    const child = spawn(process.execPath, ['-r', stub, scriptPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const finish = (code) => {
      if (settled) return;
      settled = true;
      removeOsStub(stub);
      settle({ code, stderr });
    };
    child.on('close', finish);
    child.on('error', () => finish(-1));
  });
}

// Loads a fresh copy of the installer as if it ran on another OS: the installer
// reads os.platform() once at load, so the stub has to be in place before it.
function postinstallAs(osPlatform) {
  const os = require('node:os');
  const originalPlatform = os.platform;
  os.platform = () => osPlatform;
  const modulePath = require.resolve('../../npm/scripts/postinstall.js');
  try {
    delete require.cache[modulePath];
    return require('../../npm/scripts/postinstall.js');
  } finally {
    os.platform = originalPlatform;
    delete require.cache[modulePath];
  }
}

// Separate collections for each suite; their teardown strategies differ.
function createTemporaryRoots() {
  const roots = [];
  return {
    temporaryDirectory() {
      const root = mkdtempSync(join(tmpdir(), 'agent-desktop-npm-test-'));
      roots.push(root);
      return root;
    },
    trackRoot(root) {
      roots.push(root);
      return root;
    },
    drainRoots() {
      return roots.splice(0);
    },
  };
}

module.exports = {
  createTemporaryRoots,
  osStubEnv,
  postinstallAs,
  postinstallScriptPath,
  removeOsStub,
  runScriptWithOsStub,
  wrapperScriptPath,
  writeOsStub,
};
