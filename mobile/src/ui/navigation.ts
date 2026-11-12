import { router } from 'expo-router'

/**
 * Go home after switching, adding or removing a computer: go back to the home already in the stack (replace with home only if absent).
 * replace would push another home onto the stack, and each extra one rerenders all sessions with every list refresh.
 */
export function goHome() {
  router.dismissTo('/')
}
