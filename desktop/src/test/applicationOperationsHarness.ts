import { createHostToolsPreferences } from '../../electron/services/managedResources/hostToolsPreferences'
import { JAVA_PROCESS_COMMAND } from '../../electron/services/managedResources/javaProcessProtocol'
import fs from 'node:fs/promises'
import path from 'node:path'
import { waitFor } from '@testing-library/react'
import {
  createSshFixtureHostKey,
  SshFixtureServer,
  type SshFixtureConnection,
} from '../../electron/services/managedResources/applicationOperationsSshTestHarness'
import { createHostWorkbenchHarness } from './hostWorkbenchHarness'
import { useHostSshStore } from '../features/managed-resources/stores/hostSshStore'
import { useHostManagementStore } from '../features/managed-resources/stores/hostManagementStore'
import { createFakeSftpTransport } from '../../electron/services/managedResources/sftpTestTransport'
import { createSftpService, createTransferService } from '../../electron/services/managedResources/sftpService'

/** Real SSH channels and real IPC/services; only the remote filesystem/process is a fixture. */
export async function createApplicationOperationsHarness(root = '/srv/fixture app', options: { holdJava?: boolean } = {}) {
  const fixture = await createHostWorkbenchHarness()
  const remote = await createFakeSftpTransport()
  const peers = new Set<SshFixtureConnection>()
  const commands: string[] = []
  const tails = new Set<{ write: (data: string | Buffer) => unknown; close: () => unknown }>()
  let closedChannels = 0
  let javaOutput = 'CC_HAHA_JAVA_V1\nCC_HAHA_JAVA_END\t0\n'
  let javaExitCode = 0
  let javaQueries = 0
  const javaChannels = new Set<{ close: () => unknown }>()
  const server = new SshFixtureServer({ hostKeys: [createSshFixtureHostKey()] }, client => {
    peers.add(client)
    client.on('error', () => {})
    client.on('close', () => peers.delete(client))
    client.on('authentication', context => context.method === 'password' && context.password === 'APP_OPS_FIXTURE_ONLY' ? context.accept() : context.reject(['password']))
    client.on('ready', () => client.on('session', accept => {
      const session = accept()
      session.on('pty', acceptPty => acceptPty())
      session.on('shell', acceptShell => { acceptShell() })
      session.on('exec', (acceptExec, _reject, info) => {
        const channel = acceptExec()
        channel.resume() // Drain client EOF so ssh2 can complete its channel close handshake.
        if (info.command === JAVA_PROCESS_COMMAND) {
          javaQueries++
          javaChannels.add(channel)
          channel.once('close', () => javaChannels.delete(channel))
          if (!options.holdJava) { channel.write(javaOutput); channel.exit(javaExitCode); channel.end() }
          return
        }
        commands.push(info.command)
        channel.on('error', () => {})
        channel.once('close', () => { tails.delete(channel); closedChannels++ })
        if (info.command.startsWith('exec tail ') || info.command.includes('wait.sh')) {
          tails.add(channel)
          channel.write('initial log\n')
        } else {
          const text = Buffer.from('fixture script 中文\n')
          channel.write(text.subarray(0, 16)); channel.write(text.subarray(16))
          channel.stderr.write('fixture stderr\n')
          channel.exit(info.command.includes('fail.sh') ? 7 : 0)
          channel.end()
        }
      })
    }))
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  for (const dir of ['apps', 'conf', 'logs', 'bin/bin']) await fs.mkdir(path.join(remote.remoteRoot, root, dir), { recursive: true })
  await remote.seedFile(root + '/apps/app.jar', 'fixture jar')
  await remote.seedFile(root + '/conf/app.conf', 'fixture=true\n')
  await remote.seedFile(root + '/logs/server.log', 'initial log\n<script>inert</script>\n')
  await remote.seedFile(root + '/bin/bin/start.sh', '# fixture only\n')
  await remote.seedFile(root + '/bin/bin/wait.sh', '# fixture long job\n')
  await remote.seedFile(root + '/bin/bin/fail.sh', '# fixture failure\n')
  const saved = await useHostManagementStore.getState().saveHost({
    name: 'Application fixture', address: '127.0.0.1', port: (server.address() as { port: number }).port, username: 'fixture',
    auth: { type: 'password', credentialId: null }, credential: { storage: 'vault', secret: { kind: 'ssh-password', password: 'APP_OPS_FIXTURE_ONLY' } },
    tagIds: [], initialDirectory: root, notes: '', applications: [{ name: 'Fixture application', version: null, loginUrl: null, installPaths: [root], accessDescription: '', accessUrls: [], accounts: [], notes: '' }],
  })
  if (!saved.success) throw new Error('Fixture host create failed')
  const host = saved.host
  useHostManagementStore.getState().setSelectedHostId(host.id)
  await useHostSshStore.getState().start(host, 80, 24)
  const ssh = () => useHostSshStore.getState().byHostId[host.id]!
  await waitFor(() => { if (!ssh().challenge) throw new Error('Waiting for challenge') })
  await useHostSshStore.getState().answer(host.id, 'trust')
  await waitFor(() => { if (ssh().status !== 'ready') throw new Error('Waiting for SSH') })
  const resolveSession = (input: { connectionId: string; ownerId: string }) => {
    const actual = fixture.services.sshService.getInternalsForOwner(input.connectionId, input.ownerId)
    if (!actual) throw new Error('UNAUTHORIZED_OWNER')
    return { ...actual, client: remote.resolveSession(input).client }
  }
  fixture.services.sftpService.dispose()
  fixture.services.transferService.dispose()
  fixture.services.sftpService = createSftpService({ resolveSession, tempDir: fixture.tempDir })
  fixture.services.transferService = createTransferService({ resolveSession, sftpService: fixture.services.sftpService, localPathService: fixture.services.localPathService })
  return {
    fixture, remote, root, host, application: host.applications[0]!, commands, ssh,
    setJavaOutput(text: string, exitCode = 0) { javaOutput = text; javaExitCode = exitCode },
    get javaQueries() { return javaQueries },
    get activeJava() { return javaChannels.size },
    get closedChannels() { return closedChannels },
    get tails() { return tails.size },
    append(data: string | Buffer) { for (const channel of tails) channel.write(data) },
    async dispose() {
      await useHostSshStore.getState().disconnect(host.id)
      useHostSshStore.getState().teardownAll()
      fixture.services.sftpService.dispose(); fixture.services.transferService.dispose()
      // IPC preference saves may still be flushing after a React unmount. Drain the
      // per-file repository queue before the fixture removes its isolated directory.
      await createHostToolsPreferences(fixture.services.store).get({ hostId: host.id }).catch(() => undefined)
      await fixture.dispose()
      for (const client of peers) client.end()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await remote.dispose()
    },
  }
}
