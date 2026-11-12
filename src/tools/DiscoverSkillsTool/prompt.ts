// @generated stub from scan-missing-imports
// Auto-generated; corresponds to an ant-internal feature()-gated module.
// No external build code path ever executes this after DCE; this is only
// a placeholder for the bun build resolver.
const __target = function noop() {}
const __handler: ProxyHandler<any> = {
  get(_t, prop) {
    if (prop === '__esModule') return true
    if (prop === 'default') return new Proxy(__target, __handler)
    if (prop === Symbol.toPrimitive) return () => undefined
    if (prop === Symbol.iterator) return function* () {}
    if (prop === Symbol.asyncIterator) return async function* () {}
    if (prop === 'then') return undefined
    return new Proxy(__target, __handler)
  },
  apply() {
    return new Proxy(__target, __handler)
  },
  construct() {
    return new Proxy(__target, __handler)
  },
}
const stub: any = new Proxy(__target, __handler)
export default stub
export const __stubMissing = true
// Common named exports for compatibility; anything not listed falls back to the default Proxy
export const createCachedMCState = stub
export const isCachedMicrocompactEnabled = stub
export const isModelSupportedForCacheEditing = stub
export const getCachedMCConfig = stub
export const markToolsSentToAPI = stub
export const resetCachedMCState = stub
export const checkProtectedNamespace = stub
export const getCoordinatorUserContext = stub
