import React from 'react'
import { createRoot } from 'react-dom/client'
import { SharedAuthProvider, ToastProvider } from '@cloistr/ui/components'
import '@cloistr/ui/styles'
import App from './App'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SharedAuthProvider>
      <ToastProvider>
        <App />
      </ToastProvider>
    </SharedAuthProvider>
  </React.StrictMode>,
)
