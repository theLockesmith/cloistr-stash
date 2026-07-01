import { useContext } from 'react'
import { StashContext, type StashContextValue } from './StashProvider'

/** Access the stash file-browser store. Must be used within <StashProvider>. */
export function useStash(): StashContextValue {
  const ctx = useContext(StashContext)
  if (!ctx) {
    throw new Error('useStash must be used within a StashProvider')
  }
  return ctx
}
