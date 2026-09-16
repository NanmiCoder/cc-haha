// Test-only launch shell. The worker branch enters the real merged desktop
// sidecar; native calls use the production binder, executor and daemon client.
if (process.argv[2] === '--computer-use-repl-worker') {
  await import('../../../desktop/sidecars/claude-sidecar.ts')
} else {
  const { bindSessionContext } = await import('../../../src/vendor/computer-use-mcp/mcpServer.ts')
  const { createCliExecutor } = await import('../../../src/utils/computerUse/executor.ts')
  const { ComputerUseRepl } = await import('../../../src/utils/computerUse/replRuntime.ts')
  const { callDaemon, shutdownDaemon } = await import('../../../src/utils/computerUse/cuHelperDaemon.ts')
  const { ensureInstalledHelper } = await import('../../../src/utils/computerUse/cuHelperInstall.ts')
  const logger = { silly() {}, debug() {}, info() {}, warn() {}, error() {} }
  let dispatch: ReturnType<typeof bindSessionContext> | undefined
  const report: Record<string, unknown> = { stage: 'start' }
  try {
    report.packagedInstall = ensureInstalledHelper({ sourceApp: process.env.CU_FIXTURE_NESTED_HELPER }) !== null
    if (process.env.CU_FIXTURE_REQUIRE_PACKAGED_INSTALL === '1' && !report.packagedInstall) {
      throw new Error('The production packaged-helper installation rejected the explicitly signed fixture')
    }
    report.stage = 'daemon-attestation'
    report.ping = await callDaemon('ping')
    const { readdir, readFile, writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const { getRuntimePaths } = await import('../../../src/utils/computerUse/pythonBridge.ts')
    const stateRoot = getRuntimePaths().runtimeStateRoot
    const pidfile = (await readdir(stateRoot)).find(file => file.startsWith(`cu-helper.daemon.${process.pid}.`) && file.endsWith('.sock.pid'))
    if (!pidfile) throw new Error('Authenticated helper PID file was not found')
    const helperPID = (await readFile(join(stateRoot, pidfile), 'utf8')).trim()
    await writeFile(process.env.CU_FIXTURE_HELPER_PID_FILE!, helperPID)
    report.helperPID = Number(helperPID)
    const permissions = await callDaemon<{ accessibility: boolean, screenRecording: boolean }>('check_permissions')
    report.permissions = permissions
    report.stage = 'javascript'
    const executor = createCliExecutor({ getMouseAnimationEnabled: () => false, getHideBeforeActionEnabled: () => false })
    let screenshot: { width: number, height: number } | undefined
    if (executor.engine) {
      const getAppState = executor.engine.getAppState.bind(executor.engine)
      executor.engine.getAppState = async (...args) => {
        const state = await getAppState(...args)
        screenshot = state.screenshot
        return state
      }
    }
    dispatch = bindSessionContext({
      serverName: 'native-chain-fixture', logger,
      executor,
      // No permission card and no prompting in this deterministic fixture.
      // The authoritative probe above comes from the actual signed helper.
      ensureOsPermissions: async () => permissions.accessibility && permissions.screenRecording
        ? { granted: true } : { granted: false, ...permissions },
      isDisabled: () => false,
      getAutoUnhideEnabled: () => true,
      getSubGates: () => ({ pixelValidation: false, clipboardPasteMultiline: false, mouseAnimation: false, hideBeforeAction: false, autoTargetDisplay: false, clipboardGuard: false }),
      cropRawPatch: () => null,
      createReplRuntime: () => new ComputerUseRepl(),
    }, 'pixels', {
      getAllowedApps: () => [],
      getGrantFlags: () => ({ clipboardRead: false, clipboardWrite: false, systemKeyCombos: false }),
      getUserDeniedBundleIds: () => [],
      getSelectedDisplayId: () => undefined,
    })
    report.first = await dispatch('js', { code: 'let count = 1; nodeRepl.write(count)' })
    report.second = await dispatch('js', { code: 'nodeRepl.write(++count)' })
    const observation = await dispatch('js', {
      code: `let app = await cua.getApp(${JSON.stringify(process.env.CU_FIXTURE_TARGET_APP)})`,
    })
    report.nativeObservation = observation
    if (!observation.isError && screenshot) {
      const x = Math.floor(screenshot.width / 2)
      const y = Math.floor(screenshot.height / 2)
      const replay = await dispatch('js', {
        code: `for (let i = 0; i < 12; i++) await app.drag([${x},${y}], [${x} + i % 2,${y}]); await app.getAXStateAndScreenshot()`,
      })
      report.replay = {
        ...replay,
        content: replay.content.map(content => content.type === 'image'
          ? { type: 'image', mimeType: content.mimeType, base64Length: content.data.length } : content),
      }
    }
    report.stage = 'complete'
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error)
  } finally {
    await dispatch?.('js_reset', {})
    await shutdownDaemon()
    console.log(JSON.stringify(report))
  }
}
