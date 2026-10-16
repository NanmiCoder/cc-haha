// Subsystem values of the PE optional header (winnt.h).
const IMAGE_SUBSYSTEM_WINDOWS_GUI = 2
const IMAGE_SUBSYSTEM_WINDOWS_CUI = 3

export function readWindowsSubsystem(executable: Uint8Array): number {
  const view = new DataView(executable.buffer, executable.byteOffset, executable.byteLength)
  if (executable.byteLength < 0x40 || view.getUint16(0, true) !== 0x5a4d) {
    throw new Error('Not a PE executable: missing MZ header')
  }
  const peOffset = view.getUint32(0x3c, true)
  // PE signature (4 bytes) and COFF file header (20 bytes) precede the optional
  // header; Subsystem is at offset 68 in both its PE32 and PE32+ layouts.
  const subsystemOffset = peOffset + 24 + 68
  if (subsystemOffset + 2 > executable.byteLength || view.getUint32(peOffset, true) !== 0x00004550) {
    throw new Error('Not a PE executable: missing PE header')
  }
  return view.getUint16(subsystemOffset, true)
}

// The Windows sidecar must stay a console-subsystem program. Electron and Tauri
// start it, and it starts its CLI, with CREATE_NO_WINDOW, which gives a console
// program its own invisible console for its children to inherit. A GUI-subsystem
// build ignores that flag and owns no console, so each console program spawned
// without `windowsHide` (dependency probes, MCP servers, hooks) gets a new
// visible window. Bun 1.4 began honouring `compile.windows.hideConsole`, which
// silently switched v0.7.2 to GUI and flashed a window on every new session (#1583).
export function assertWindowsConsoleSubsystem(executable: Uint8Array, label: string): void {
  const subsystem = readWindowsSubsystem(executable)
  if (subsystem === IMAGE_SUBSYSTEM_WINDOWS_CUI) return
  const actual = subsystem === IMAGE_SUBSYSTEM_WINDOWS_GUI ? 'the GUI subsystem' : `subsystem ${subsystem}`
  throw new Error(
    `${label} must be a console-subsystem (CUI) executable but was built for ${actual}; `
      + 'child processes without windowsHide would open visible console windows',
  )
}
