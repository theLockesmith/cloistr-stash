import type { UploadItem } from '@cloistr/stash-core/upload'

const FINAL = new Set(['success', 'duplicate', 'error'])

/** busy: still running; done: every upload succeeded; attention: finished with a failure or duplicate. */
export function uploadsSettled(items: Pick<UploadItem, 'status'>[]): 'busy' | 'done' | 'attention' {
  if (items.some((i) => !FINAL.has(i.status))) return 'busy'
  return items.every((i) => i.status === 'success') ? 'done' : 'attention'
}
