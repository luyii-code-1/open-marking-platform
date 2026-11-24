import './pwaCoordinator'
import { initThemeMode } from './themeMode'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { PwaRuntime } from './PwaStatus'
import './login.css'
initThemeMode()
createRoot(document.getElementById('root')!).render(<React.StrictMode><PwaRuntime><App /></PwaRuntime></React.StrictMode>)
