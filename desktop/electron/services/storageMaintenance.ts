// Host writers share this barrier with the migration coordinator. Keep it
// process-local: the startup pointer and migration journal live in userData.
let frozen = false

export function setStorageWritesFrozen(value: boolean): void {
  frozen = value
}

export function areStorageWritesFrozen(): boolean {
  return frozen
}
