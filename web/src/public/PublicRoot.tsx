// Entry for /public/{sha256}#{key}: no sign-in, no app chrome, no service
// worker. The key is read and cleared from the address bar before render.

import { ThemeProvider } from '@cloistr/ui/components'
import { PublicLinkPage, readAndClearLink } from './PublicLinkPage'
import '@cloistr/ui/styles'
import './public.css'

const parsed = readAndClearLink()

export default function PublicRoot() {
  return (
    <ThemeProvider>
      <PublicLinkPage parsed={parsed} />
    </ThemeProvider>
  )
}
