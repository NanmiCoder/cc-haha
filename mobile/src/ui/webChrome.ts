import { Platform } from 'react-native'
import { isH5 } from '../state/h5'

/**
 * The dev web preview (`bun run web`) draws an iPhone in the desktop browser: a 54pt status bar at the top, 
 * and 34pt home indicator padding at the bottom, for easy comparison with the design. H5 runs in a real phone browser, 
 * using the real safe area given by the browser (viewport-fit=cover in index.html), handled the same as native.
 */
export const simulatedPhoneChrome = Platform.OS === 'web' && !isH5
