import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import './theme/globals.css'
import { initializeTheme } from './stores/uiStore'

initializeTheme()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
