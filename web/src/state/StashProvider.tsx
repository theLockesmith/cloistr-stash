// Stash state model + store.
//
// Replaces the legacy `const App = {}` global (app.js) with a React context.
// Holds the file-browser state and the load/navigate/select/view actions,
// backed by the ported data layer (api.ts, keys.ts) and the auth bridge.
//
// localStorage keys 'cloistr-starred' / 'cloistr-recent' are preserved verbatim
// for continuity with existing users' data.

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

interface RecentEntry {
  sha256: string
  accessedAt: number
}

const STARRED_KEY = 'cloistr-starred'
const RECENT_KEY = 'cloistr-recent'

export interface StashContextValue {
  // Data
  files: StashFile[]
  folders: StashFolder[]
  folderTreeData: StashFolder[]
  /** Files shown for the active special view (starred/recent/trash). */
  specialFiles: StashFile[]
  // Navigation
  currentFolderId: string
  folderPath: FolderPathItem[]
  view: StashView
  searchQuery: string
  // Selection
  selectedFiles: ReadonlySet<string>
  selectedFolders: ReadonlySet<string>
  selectionMode: boolean
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
  setView: (view: StashView) => Promise<void>
  setSearchQuery: (q: string) => void
  toggleStar: (sha256: string) => void
  recordFileAccess: (sha256: string) => void
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

function loadStarred(): Set<string> {
  try {
    const stored = localStorage.getItem(STARRED_KEY)
    if (stored) return new Set(JSON.parse(stored) as string[])
  } catch (err) {
    console.warn('Failed to load starred state:', err)
  }
  return new Set()
}

function loadRecent(): RecentEntry[] {
  try {
    const stored = localStorage.getItem(RECENT_KEY)
    if (stored) return JSON.parse(stored) as RecentEntry[]
  } catch (err) {
    console.warn('Failed to load recent state:', err)
  }
  return []
}

export function StashProvider({ children }: { children: ReactNode }) {
  const [files, setFiles] = useState<StashFile[]>([])
  const [folders, setFolders] = useState<StashFolder[]>([])
  const [folderTreeData, setFolderTreeData] = useState<StashFolder[]>([])
  const [specialFiles, setSpecialFiles] = useState<StashFile[]>([])
  const [currentFolderId, setCurrentFolderId] = useState('')
  const [folderPath, setFolderPath] = useState<FolderPathItem[]>([])
  const [view, setViewState] = useState<StashView>('my-files')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedFiles, setSelectedFiles] = useState<ReadonlySet<string>>(new Set())
  const [selectedFolders, setSelectedFolders] = useState<ReadonlySet<string>>(new Set())
  const [selectionMode, setSelectionMode] = useState(false)
  const [starredFiles, setStarredFiles] = useState<ReadonlySet<string>>(() => loadStarred())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const folderIdRef = useRef('')
  const treeRef = useRef<StashFolder[]>([])
  const recentRef = useRef<RecentEntry[]>(loadRecent())
  const starredRef = useRef<ReadonlySet<string>>(starredFiles)
  starredRef.current = starredFiles

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

  // Load the file set backing a special view (starred / recent / trash) from the
  // full file list. Ported from app.js loadStarredFiles/loadRecentFiles/loadTrashFiles.
  const loadSpecialView = useCallback(async (which: StashView) => {
    const pubkey = authPort.pubkey
    if (!authPort.isConnected || !pubkey) return
    setLoading(true)
    setError(null)
    try {
      const response = await API.listFiles(pubkey)
      const allFiles = (response.files || []) as StashFile[]

      let result: StashFile[] = []
      if (which === 'trash') {
        result = allFiles
          .filter((f) => f.deleted_at || f.deletedAt)
          .sort((a, b) => Number(b.deleted_at || b.deletedAt || 0) - Number(a.deleted_at || a.deletedAt || 0))
      } else if (which === 'starred') {
        const starred = starredRef.current
        result = allFiles.filter((f) => starred.has(f.sha256) && !f.deleted_at && !f.deletedAt)
      } else if (which === 'recent') {
        const recent = recentRef.current
        const order = new Map(recent.map((r) => [r.sha256, r.accessedAt]))
        result = allFiles
          .filter((f) => order.has(f.sha256) && !f.deleted_at && !f.deletedAt)
          .sort((a, b) => (order.get(b.sha256) || 0) - (order.get(a.sha256) || 0))
          .slice(0, 50)
      }
      setSpecialFiles(result)
    } catch (err) {
      console.error(`load ${which}: Failed -`, err)
      setError(`Failed to load ${which}`)
    } finally {
      setLoading(false)
    }
  }, [])

  const setView = useCallback(
    async (next: StashView) => {
      setViewState(next)
      if (next === 'my-files') {
        await loadFilesFor(folderIdRef.current)
      } else if (next === 'starred' || next === 'recent' || next === 'trash') {
        await loadSpecialView(next)
      }
    },
    [loadFilesFor, loadSpecialView],
  )

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
      setViewState('my-files')
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
      setViewState('my-files')
      folderIdRef.current = folderId
      setCurrentFolderId(folderId)
      setFolderPath(folderId === '' ? [] : getPathToFolder(folderId))
      await loadFilesFor(folderId)
    },
    [getPathToFolder, loadFilesFor],
  )

  const toggleStar = useCallback((sha256: string) => {
    setStarredFiles((prev) => {
      const next = new Set(prev)
      if (next.has(sha256)) next.delete(sha256)
      else next.add(sha256)
      try {
        localStorage.setItem(STARRED_KEY, JSON.stringify([...next]))
      } catch (err) {
        console.warn('Failed to save starred state:', err)
      }
      return next
    })
  }, [])

  const recordFileAccess = useCallback((sha256: string) => {
    const filtered = recentRef.current.filter((r) => r.sha256 !== sha256)
    filtered.unshift({ sha256, accessedAt: Math.floor(Date.now() / 1000) })
    recentRef.current = filtered.slice(0, 100)
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(recentRef.current))
    } catch (err) {
      console.warn('Failed to save recent state:', err)
    }
  }, [])

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
      specialFiles,
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
      toggleStar,
      recordFileAccess,
      toggleFileSelection,
      toggleFolderSelection,
      clearSelection,
      setSelectionMode,
    }),
    [
      files,
      folders,
      folderTreeData,
      specialFiles,
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
      toggleStar,
      recordFileAccess,
      toggleFileSelection,
      toggleFolderSelection,
      clearSelection,
    ],
  )

  return <StashContext.Provider value={value}>{children}</StashContext.Provider>
}
