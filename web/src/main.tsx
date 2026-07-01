import React from 'react'
import { createRoot } from 'react-dom/client'
import { SharedAuthProvider, ToastProvider } from '@cloistr/ui/components'
import '@cloistr/ui/styles'
import App from './App'
import { StashProvider } from './state/StashProvider'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SharedAuthProvider>
      <ToastProvider>
        <StashProvider>
          <App />
        </StashProvider>
      </ToastProvider>
    </SharedAuthProvider>
  </React.StrictMode>,
)
