import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import type { FakeSftpTransport } from '../../../electron/services/managedResources/sftpTestTransport'
import { applicationScriptCommand } from '../../../electron/services/managedResources/applicationScriptCommand'
import { processInspectionCommand, processListCommand } from '../../../electron/services/managedResources/serviceProcessProtocol'

export const HOST_TOOLS_FIXTURE_ROOT = '/workspace/host-tools'
export const HOST_TOOLS_FIXTURE_COMMAND = applicationScriptCommand(HOST_TOOLS_FIXTURE_ROOT + '/bin/bin', 'verify.sh', 'deploy')
export const HOST_TOOLS_JAVA_FRAME = 'CC_HAHA_JAVA_V1\n' + [
  [101, ['/jdk/bin/java', '-Xms512m', '-Xmx2g', '-jar', '/srv/mon 服务.jar']],
  [202, ['/jdk/bin/java', '-Xmx1g', 'demo.Scheduler']],
].map(([pid, args]) => `${pid}\t${Buffer.from((args as string[]).join('\0') + '\0').toString('base64')}\t123456\n`).join('') + 'CC_HAHA_JAVA_END\t0\n'

export const PROCESS_FIXTURE_REPLIES = new Map<string, string>()
for (const [kind, pid, name] of [['java', 101, 'java'], ['mysql', 301, 'mysqld'], ['redis', 302, 'redis-server']] as const) {
  if (kind !== 'java') PROCESS_FIXTURE_REPLIES.set(processListCommand(kind), `CC_HAHA_PROCESS_V1\t${kind}\n${pid}\t123456\t${name}\t${Buffer.from(`${name}\0--fixture-only\0`).toString('base64')}\nCC_HAHA_PROCESS_END\t0\n`)
  for (const probe of ['top', 'ports', 'connections'] as const) {
    const text = probe === 'top' ? `PID USER %CPU %MEM RES\n${pid} fixture 12.5 2.0 128m\n`
      : probe === 'ports' ? `tcp LISTEN 0 128 [::]:3337 [::]:* users:(("${name}",pid=${pid},fd=9))\n`
      : `tcp ESTAB 0 0 127.0.0.1:3337 127.0.0.1:52345 users:(("${name}",pid=${pid},fd=12))\n`
    PROCESS_FIXTURE_REPLIES.set(processInspectionCommand({ pid, startTime: '123456', processKind: kind, probe }), `CC_HAHA_INSPECTION_V1\t${pid}\t${probe}\n${Buffer.from(text).toString('base64')}\nCC_HAHA_INSPECTION_END\n`)
  }
}

type Controls = {
  clickButton: (key: string, selector?: string, scope?: string) => Promise<void>
  clickExpression: (expression: string) => Promise<void>
  waitFor: (expression: string, label: string, timeout?: number) => Promise<void>
  type: (selector: string, value: string) => Promise<void>
}

/** Production UI and persistence, real IPC and SSH; remote processes remain explicit fixtures. */
export async function verifyHostTools(win: BrowserWindow, controls: Controls, remote: FakeSftpTransport, commands: string[], output: string) {
  const { clickButton, clickExpression, waitFor, type } = controls
  for (const file of ['apps/service.jar', 'conf/app.conf', 'logs/server.log', 'bin/bin/verify.sh']) {
    await remote.seedFile(`${HOST_TOOLS_FIXTURE_ROOT}/${file}`, '# host tools fixture only\n')
  }
  await clickExpression('document.querySelector("[data-testid=host-applications-tab]")')
  await clickButton('managedResources.newApplication')
  await type('#app-name-input', 'Host tools fixture application')
  await type('#app-install-paths-input', HOST_TOOLS_FIXTURE_ROOT)
  await clickButton('common.save', 'button[type="submit"]')
  await waitFor('!document.querySelector("[role=dialog]")', 'fixture application saved')
  const userInput = '[data-testid=application-execution-user] input'
  await waitFor(`document.querySelector('${userInput}')?.disabled === false`, 'execution preferences loaded')
  await type(userInput, 'deploy')
  await clickButton('common.save', 'button', 'document.querySelector("[data-testid=application-execution-user]")')
  await waitFor(`document.querySelector('${userInput}')?.disabled === false`, 'execution user saved')
  const toggle = (name: string) => `document.querySelector('[data-app-directory="${name}"] button[aria-expanded]')`
  for (const directory of ['apps', 'conf']) await clickExpression(toggle(directory))
  await waitFor(`${toggle('conf')}.getAttribute('aria-expanded') === 'false'`, 'two folds saved')
  await fs.writeFile(path.join(output, 'host-tools-execution-user.png'), (await win.webContents.capturePage()).toPNG())
  await clickExpression(`Array.from(document.querySelectorAll('[data-app-directory="bin/bin"] button')).find(button => button.getAttribute('aria-label') === window.m2Smoke.label('managedResources.appOperations.execute') + ': verify.sh')`)
  await waitFor('Boolean(document.querySelector("[role=dialog]"))', 'script confirmation')
  assert.equal(await win.webContents.executeJavaScript('document.querySelector("[role=dialog]").textContent.includes("deploy")'), true)
  assert.equal(commands.length, 0)
  await clickButton('managedResources.appOperations.execute', 'button', 'document.querySelector("[role=dialog]")')
  await waitFor('document.querySelector("[role=dialog] pre")?.textContent.includes("HOST_TOOLS_FIXTURE_OUTPUT")', 'script fixture output')
  assert.deepEqual(commands, [HOST_TOOLS_FIXTURE_COMMAND])
  await clickButton('common.close', 'button[aria-label]', 'document.querySelector("[role=dialog]")')
  await clickExpression('document.querySelector("[data-testid=host-java-tab]")')
  await waitFor('document.querySelectorAll("[data-java-pid]").length === 2', 'automatic Java rows')
  const row = await win.webContents.executeJavaScript(`document.querySelector('[data-java-pid="101"]').textContent`)
  assert.ok(row.includes('2g') && row.includes('512m') && row.includes('mon 服务.jar'))
  await type('[data-testid=java-processes-panel] input[type=search]', 'mon')
  await clickButton('managedResources.hostTools.saveKeyword')
  await waitFor('Array.from(document.querySelectorAll("[data-testid=java-processes-panel] button")).some(button => button.textContent.trim() === "mon")', 'keyword saved')
  await fs.writeFile(path.join(output, 'host-tools-java-processes.png'), (await win.webContents.capturePage()).toPNG())
  await clickExpression('document.querySelector("[data-testid=host-applications-tab]")')
  await waitFor(`${toggle('apps')}?.getAttribute('aria-expanded') === 'false' && ${toggle('conf')}?.getAttribute('aria-expanded') === 'false'`, 'fold state restored after remount')
  await waitFor(`document.querySelector('${userInput}')?.value === 'deploy'`, 'execution user restored')
  await clickExpression('document.querySelector("[data-testid=host-java-tab]")')
  await waitFor('document.querySelector("[data-testid=java-processes-panel] input[type=search]")?.value === "mon" && document.querySelectorAll("[data-java-pid]").length === 1', 'last search and filtering restored without a keyword click')
  await type('[data-testid=java-processes-panel] input[type=search]', '')
  await clickExpression('document.querySelector("[data-testid=host-applications-tab]")')
  await clickExpression('document.querySelector("[data-testid=host-java-tab]")')
  await waitFor('document.querySelector("[data-testid=java-processes-panel] input[type=search]")?.value === "" && document.querySelectorAll("[data-java-pid]").length === 2', 'cleared search restored after reopen')
  await clickExpression('Array.from(document.querySelectorAll("[data-testid=java-processes-panel] button")).find(button => button.textContent.trim() === "mon")')
  await waitFor('document.querySelectorAll("[data-java-pid]").length === 1', 'saved keyword selected by click')
  await clickExpression('document.querySelector("[data-testid=host-applications-tab]")')
  await clickExpression('document.querySelector("[data-testid=host-java-tab]")')
  await waitFor('document.querySelector("[data-testid=java-processes-panel] input[type=search]")?.value === "mon" && document.querySelectorAll("[data-java-pid]").length === 1', 'clicked keyword restored as last search')
  await type('[data-testid=java-processes-panel] input[type=search]', '不存在 Scheduler')
  await waitFor('document.querySelectorAll("[data-java-pid]").length === 1 && document.querySelector("[data-java-pid]")?.getAttribute("data-java-pid") === "202"', 'OR selects the second term independently')
  await type('[data-testid=java-processes-panel] input[type=search]', 'mon Scheduler')
  await waitFor('document.querySelectorAll("[data-java-pid]").length === 2', 'OR returns both disjoint matches')
  await clickButton('managedResources.hostTools.saveKeyword')
  await waitFor('Array.from(document.querySelectorAll("[data-testid=java-processes-panel] button")).some(button => button.textContent.trim() === "mon Scheduler")', 'multi-term keyword saved')
  await clickExpression('document.querySelector("[data-testid=host-applications-tab]")')
  await clickExpression('document.querySelector("[data-testid=host-java-tab]")')
  await waitFor('document.querySelector("[data-testid=java-processes-panel] input[type=search]")?.value === "mon Scheduler" && document.querySelectorAll("[data-java-pid]").length === 2', 'multi-term search restored after reopen')
  await type('[data-testid=java-processes-panel] input[type=search]', 'missing')
  await waitFor('document.querySelectorAll("[data-java-pid]").length === 0', 'non-matching filter excludes rows')
  await clickExpression('Array.from(document.querySelectorAll("[data-testid=java-processes-panel] button")).find(button => button.textContent.trim() === "mon Scheduler")')
  await waitFor('document.querySelectorAll("[data-java-pid]").length === 2', 'multi-term saved keyword selects both rows')
  await fs.writeFile(path.join(output, 'java-search-or.png'), (await win.webContents.capturePage()).toPNG())
  await fs.writeFile(path.join(output, 'java-search-or.json'), JSON.stringify({ status: 'passed', testedAt: new Date().toISOString(), orSearch: true, disjointTerms: true, lastQueryRestored: true, savedMultiTermKeyword: true, fakeRemoteProcesses: true }, null, 2) + '\n')
  const javaColumns = await win.webContents.executeJavaScript('Array.from(document.querySelectorAll("[data-testid=java-processes-panel] th")).map(cell => cell.textContent)')
  assert.deepEqual(javaColumns, ['PID', 'Command line', 'Xmx / Xms', 'Inspect'])
  for (const [kind, pid] of [['java', 101], ['mysql', 301], ['redis', 302]] as const) {
    await clickExpression(`document.querySelector('[data-testid=host-${kind}-tab]')`)
    await waitFor(`Boolean(document.querySelector('[data-process-kind="${kind}"][data-java-pid="${pid}"]'))`, `${kind} native process entry`)
    const target = `document.querySelector('[data-process-kind="${kind}"][data-java-pid="${pid}"] button')`
    await clickExpression(target)
    await waitFor('document.querySelector("[data-testid=process-inspection] pre")?.textContent.includes("12.5 2.0 128m")', `${kind} native Top probe`)
    await clickButton('managedResources.process.ports', '[role=tab]', 'document.querySelector("[data-testid=process-inspection]")')
    await waitFor('document.querySelector("[data-testid=process-inspection] pre")?.textContent.includes("tcp LISTEN")', `${kind} native listening ports`)
    await clickButton('managedResources.process.connections', '[role=tab]', 'document.querySelector("[data-testid=process-inspection]")')
    await waitFor('document.querySelector("[data-testid=process-inspection] pre")?.textContent.includes("tcp ESTAB")', `${kind} native connections`)
    await fs.writeFile(path.join(output, `${kind}-process-inspection.png`), (await win.webContents.capturePage()).toPNG())
    await clickButton('common.close', 'button[aria-label]', 'document.querySelector("[role=dialog]")')
    if (kind !== 'java') {
      await type(`[data-testid=${kind}-processes-panel] input[type=search]`, kind === 'mysql' ? 'mysqld absent' : 'redis-server absent')
      await clickButton('managedResources.hostTools.saveKeyword')
      await waitFor(`Array.from(document.querySelectorAll('[data-testid=${kind}-processes-panel] button')).some(button => button.textContent.includes('absent'))`, `${kind} saved OR search`)
    }
  }
  await clickExpression('document.querySelector("[data-testid=host-mysql-tab]")')
  await waitFor('document.querySelector("[data-testid=mysql-processes-panel] input[type=search]")?.value === "mysqld absent"', 'MySQL search restored independently')
  await fs.writeFile(path.join(output, 'process-inspection.json'), JSON.stringify({ status: 'passed', javaColumns, processKinds: ['java', 'mysql', 'redis'], probes: ['top', 'ports', 'connections'], mysqlSearchRestored: true, fakeRemoteProcesses: true }, null, 2) + '\n')
  await fs.writeFile(path.join(output, 'host-tools-native.json'), JSON.stringify({ status: 'passed', testedAt: new Date().toISOString(), executionUserSaved: true, scriptConfirmedThroughIpc: true, foldRestore: true, javaColumns, keywordSaveAndSelectAfterRemount: true, lastSearchRestoredOnReopen: true, clearedSearchRestored: true, clickedKeywordRestored: true, fakeSftp: true, fakeRemoteProcesses: true, realCredentials: false }, null, 2) + '\n')
  await clickExpression('document.querySelector("[data-testid=host-applications-tab]")')
  await clickButton('managedResources.deleteApp')
  await clickButton('common.delete', 'button', 'document.querySelector("[role=dialog]")')
  await waitFor('!document.querySelector("[data-testid=application-file-lists]")', 'fixture app removed')
}
