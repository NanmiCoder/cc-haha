import { createContext } from 'react'
import type { ToolImageLoader } from '../../core/toolImages'

/** The chat page provides the loader of the host it is connected to. */
export const ToolImageLoaderContext = createContext<ToolImageLoader | null>(null)
