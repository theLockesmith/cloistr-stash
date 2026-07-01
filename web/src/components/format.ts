// Display formatting helpers, ported from legacy Upload.formatSize /
// Upload.getFileIcon and the inline date formatting in ui.js.

export function formatFileSize(bytes?: number): string {
  if (bytes == null) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

export function formatDate(unixSeconds?: number): string {
  return unixSeconds ? new Date(unixSeconds * 1000).toLocaleDateString() : '-'
}

// Emoji file icon (ported from Upload.getFileIcon); 🔒 for encrypted blobs.
export function getFileIcon(mimeType?: string, encrypted?: boolean): string {
  if (encrypted) return '🔒'
  if (!mimeType) return '📄'
  if (mimeType.startsWith('image/')) return '🖼️'
  if (mimeType.startsWith('video/')) return '🎬'
  if (mimeType.startsWith('audio/')) return '🎵'
  if (mimeType.startsWith('text/')) return '📝'
  if (mimeType.includes('pdf')) return '📕'
  if (mimeType.includes('zip') || mimeType.includes('tar') || mimeType.includes('compressed')) return '📦'
  if (mimeType.includes('json') || mimeType.includes('javascript')) return '📜'
  return '📄'
}
