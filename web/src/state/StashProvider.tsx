// Stash state model + store.
//
// Replaces the legacy `const App = {}` global (app.js) with a React context.
// Holds the file-browser state and the load/navigate/select actions, backed by
// the ported data layer (api.ts, keys.ts) and the auth bridge. Special-view
// loading (starred/recent/trash) lands in 4c; this provides the slots + the
// core my-files load + navigation + selection.

import {
  createContext,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { API } from '../lib/api'
import { Keys } from '../lib/keys'
import { authPort } from '../lib/authBridge'
import type { FolderPathItem, StashFile, StashFolder, StashView } from './types'

export interface StashContextValue {
  // Data
  files: StashFile[]
  folders: StashFolder[]
  folderTreeData: StashFolder[]
  // Navigation
  currentFolderId: string
  folderPath: FolderPathItem[]
  view: StashView
  searchQuery: string
  // Selection
  selectedFiles: ReadonlySet<string>
  selectedFolders: ReadonlySet<string>
  selectionMode: boolean
  /** SHA-256s of starred files (populated in 4c). */
  starredFiles: ReadonlySet<string>
  // Status
  loading: boolean
  error: string | null
  // Actions
  loadFiles: () => Promise<void>
  loadFolderTree: () => Promise<void>
  navigateToFolder: (folderId: string, folderName: string) => Promise<void>
  navigateToRoot: () => Promise<void>
  navigateToFolderAbsolute: (folderId: string) => Promise<void>
  setView: (view: StashView) => void
  setSearchQuery: (q: string) => void
  toggleFileSelection: (sha256: string) => void
  toggleFolderSelection: (folderId: string) => void
  clearSelection: () => void
  setSelectionMode: (on: boolean) => void
}

export const StashContext = createContext<StashContextValue | null>(null)

/** Restore self-encrypted folder keys into the key store (ported from app.js). */
async function restoreFolderKeys(folders: StashFolder[]): Promise<void> {
  const pubkey = authPort.pubkey
  if (!authPort.isConnected || !pubkey || folders.length === 0) return

  let restored = 0
  let errors = 0
  for (const folder of folders) {
    if (!folder.encrypted_key) continue
    if (await Keys.hasFolderKey(folder.id)) continue
    try {
      await Keys.importSharedFolderKey(folder.id, folder.encrypted_key, pubkey)
      restored++
    } catch (err) {
      console.error('Failed to restore folder key for', folder.id, ':', (err as Error).message)
      errors++
    }
  }
  if (restored > 0 || errors > 0) {
    console.log(`restoreFolderKeys: Restored ${restored} keys, ${errors} errors`)
  }
}

// Keep root-key/config events and deleted/trashed files out of the my-files view
// (ported verbatim from app.js loadFiles).
function isVisibleFile(f: StashFile): boolean {
  if (f.deleted_at || f.deletedAt) return false
  if (!f.sha256 || f.sha256.length < 16) return false
  const id = (f.id || (f.file_id as string) || (f.fileId as string) || (f.d as string) || '') as string
  if (id === 'root-key') return false
  return true
}

export function StashProvider({ children }: { children: ReactNode }) {
  const [files, setFiles] = useState<StashFile[]>([])
  const [folders, setFolders] = useState<StashFolder[]>([])
  const [folderTreeData, setFolderTreeData] = useState<StashFolder[]>([])
  const [currentFolderId, setCurrentFolderId] = useState('')
  const [folderPath, setFolderPath] = useState<FolderPathItem[]>([])
  const [view, setView] = useState<StashView>('my-files')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedFiles, setSelectedFiles] = useState<ReadonlySet<string>>(new Set())
  const [selectedFolders, setSelectedFolders] = useState<ReadonlySet<string>>(new Set())
  const [selectionMode, setSelectionMode] = useState(false)
  const [starredFiles] = useState<ReadonlySet<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Ref mirror so load actions read the latest folder without stale closures.
  const folderIdRef = useRef('')
  const treeRef = useRef<StashFolder[]>([])

  const loadFilesFor = useCallback(async (folderId: string) => {
    const pubkey = authPort.pubkey
    if (!authPort.isConnected || !pubkey) return

    setLoading(true)
    setError(null)
    try {
      const [foldersResponse, filesResponse] = await Promise.all([
        API.listFolders(pubkey, folderId),
        API.listFilesInFolder(pubkey, folderId),
      ])

      const loadedFolders = (foldersResponse.folders || []) as StashFolder[]
      const visibleFiles = ((filesResponse.files || []) as StashFile[]).filter(isVisibleFile)

      await restoreFolderKeys(loadedFolders)

      setFolders(loadedFolders)
      setFiles(visibleFiles)
    } catch (err) {
      console.error('loadFiles: Failed -', err)
      setError('Failed to load files')
    } finally {
      setLoading(false)
    }
  }, [])

  const loadFiles = useCallback(() => loadFilesFor(folderIdRef.current), [loadFilesFor])

  const loadFolderTree = useCallback(async () => {
    const pubkey = authPort.pubkey
    if (!authPort.isConnected || !pubkey) return
    try {
      const result = await API.listFolders(pubkey)
      const tree = (result.folders || []) as StashFolder[]
      treeRef.current = tree
      setFolderTreeData(tree)
      await restoreFolderKeys(tree)
    } catch (err) {
      console.error('loadFolderTree: Failed -', (err as Error).message)
    }
  }, [])

  // Walk parent_id up the folder tree to build an absolute breadcrumb path.
  const getPathToFolder = useCallback((folderId: string): FolderPathItem[] => {
    if (!folderId) return []
    const path: FolderPathItem[] = []
    const folderMap = new Map(treeRef.current.map((f) => [f.id, f]))
    let currentId: string | undefined = folderId
    while (currentId) {
      const folder = folderMap.get(currentId)
      if (!folder) break
      path.unshift({ id: folder.id, name: folder.name })
      currentId = folder.parent_id
    }
    return path
  }, [])

  const navigateToFolder = useCallback(
    async (folderId: string, folderName: string) => {
      if (folderId === '') {
        folderIdRef.current = ''
        setCurrentFolderId('')
        setFolderPath([])
      } else {
        setFolderPath((prev) => [...prev, { id: folderId, name: folderName }])
        folderIdRef.current = folderId
        setCurrentFolderId(folderId)
      }
      await loadFilesFor(folderIdRef.current)
    },
    [loadFilesFor],
  )

  const navigateToRoot = useCallback(() => navigateToFolder('', 'My Stash'), [navigateToFolder])

  const navigateToFolderAbsolute = useCallback(
    async (folderId: string) => {
      folderIdRef.current = folderId
      setCurrentFolderId(folderId)
      setFolderPath(folderId === '' ? [] : getPathToFolder(folderId))
      await loadFilesFor(folderId)
    },
    [getPathToFolder, loadFilesFor],
  )

  const toggleFileSelection = useCallback((sha256: string) => {
    setSelectedFiles((prev) => {
      const next = new Set(prev)
      if (next.has(sha256)) next.delete(sha256)
      else next.add(sha256)
      return next
    })
  }, [])

  const toggleFolderSelection = useCallback((folderId: string) => {
    setSelectedFolders((prev) => {
      const next = new Set(prev)
      if (next.has(folderId)) next.delete(folderId)
      else next.add(folderId)
      return next
    })
  }, [])

  const clearSelection = useCallback(() => {
    setSelectedFiles(new Set())
    setSelectedFolders(new Set())
  }, [])

  const value = useMemo<StashContextValue>(
    () => ({
      files,
      folders,
      folderTreeData,
      currentFolderId,
      folderPath,
      view,
      searchQuery,
      selectedFiles,
      selectedFolders,
      selectionMode,
      starredFiles,
      loading,
      error,
      loadFiles,
      loadFolderTree,
      navigateToFolder,
      navigateToRoot,
      navigateToFolderAbsolute,
      setView,
      setSearchQuery,
      toggleFileSelection,
      toggleFolderSelection,
      clearSelection,
      setSelectionMode,
    }),
    [
      files,
      folders,
      folderTreeData,
      currentFolderId,
      folderPath,
      view,
      searchQuery,
      selectedFiles,
      selectedFolders,
      selectionMode,
      starredFiles,
      loading,
      error,
      loadFiles,
      loadFolderTree,
      navigateToFolder,
      navigateToRoot,
      navigateToFolderAbsolute,
      toggleFileSelection,
      toggleFolderSelection,
      clearSelection,
    ],
  )

  return <StashContext.Provider value={value}>{children}</StashContext.Provider>
}
