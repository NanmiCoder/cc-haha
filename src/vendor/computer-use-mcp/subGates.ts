import type { CuSubGates } from './types.js'

export const ALL_SUB_GATES_ON: CuSubGates = {
  pixelValidation: false,
  clipboardPasteMultiline: true,
  mouseAnimation: true,
  hideBeforeAction: true,
  autoTargetDisplay: true,
  clipboardGuard: true,
}

export const ALL_SUB_GATES_OFF: CuSubGates = {
  pixelValidation: false,
  clipboardPasteMultiline: false,
  mouseAnimation: false,
  hideBeforeAction: false,
  autoTargetDisplay: false,
  clipboardGuard: false,
}
