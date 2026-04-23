/**
 * No-op replacement. The Python bridge is a synchronous subprocess call —
 * there is no CFRunLoop to pump. All former callers can just await their
 * promises directly.
 */
export async function drainRunLoop<T>(fn: () => Promise<T>): Promise<T> {
  return fn()
}

export const retainPump = () => {}
export const releasePump = () => {}
