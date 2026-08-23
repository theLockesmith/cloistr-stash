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
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { API } from '../lib/api'
import { Keys } from '../lib/keys'
import { Crypto } from '../lib/crypto'
import { Events } from '../lib/events'
import { authPort } from '../lib/authBridge'
import {
  delay,
  deleteFolders,
  fileIdOf,
  moveFile as opMoveFile,
  permanentDeleteFile as opPermanentDeleteFile,
  renameFile as opRenameFile,
  renameFolder as opRenameFolder,
  restoreFile as opRestoreFile,
  RELAY_THROTTLE_MS,
  softDeleteFile,
} from '../lib/operations'
import { uploadFiles as libUploadFiles, copyFile as libCopyFile, type UploadItem } from '../lib/upload'
import { Search, type SearchResult } from '../lib/search'
import { Sharing, type DecryptedIncomingShare } from '../lib/sharing'
import type { FolderPathItem, StashFile, StashFolder, StashNotification, StashView } from './types'

interface RecentEntry {
  sha256: string
  accessedAt: number
}

const STARRED_KEY = 'cloistr-starred'
const RECENT_KEY = 'cloistr-recent'
const NOTIFICATIONS_KEY = 'cloistr-notifications'
/** Poll for new received shares every 30 s (mirrors legacy startNotificationPolling). */
const NOTIFICATION_POLL_MS = 30_000
/** First check is deferred 5 s after auth, so the initial file load completes first. */
const NOTIFICATION_INITIAL_DELAY_MS = 5_000

function loadStoredNotifications(): StashNotification[] {
  try {
    const raw = localStorage.getItem(NOTIFICATIONS_KEY)
    return raw ? (JSON.parse(raw) as StashNotification[]) : []
  } catch {
    return []
  }
}

function saveStoredNotifications(list: StashNotification[]): void {
  try {
    localStorage.setItem(NOTIFICATIONS_KEY, JSON.stringify(list))
  } catch (err) {
    console.warn('Failed to save notifications:', err)
  }
}

export interface StashContextValue {
  // Data
  files: StashFile[]
  folders: StashFolder[]
  folderTreeData: StashFolder[]
  /** Files shown for the active special view (starred/recent/trash). */
  specialFiles: StashFile[]
  /** Unencrypted files detected after a load — non-empty triggers MigrationModal. */
  migrationFiles: StashFile[]
  dismissMigration: () => void
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
  selectAll: () => void
  clearSelection: () => void
  setSelectionMode: (on: boolean) => void
  deleteFile: (file: StashFile) => Promise<void>
  deleteFolder: (folderId: string) => Promise<void>
  deleteSelected: () => Promise<void>
  /** Move every selected file to targetFolderId ('' = root). Folders in the selection are not moved. */
  moveSelected: (targetFolderId: string) => Promise<void>
  /** Restore a file from trash (re-publish without deletedAt). */
  restoreFile: (file: StashFile) => Promise<void>
  /** Permanently delete a file via NIP-09 kind:5 event. */
  permanentDeleteFile: (file: StashFile) => Promise<void>
  /** Permanently delete every file in the trash via a single batch kind:5 event. */
  emptyTrash: () => Promise<void>
  renameFile: (file: StashFile, newName: string) => Promise<void>
  renameFolder: (folder: StashFolder, newName: string) => Promise<void>
  moveFile: (file: StashFile, targetFolderId: string) => Promise<void>
  /**
   * Copy a file to a folder. Downloads the encrypted blob, decrypts it with
   * the source key, re-encrypts under a new fileId in the target folder, and
   * uploads. The original is not modified. targetFolderId '' = root.
   */
  copyFile: (file: StashFile, targetFolderId: string | null) => Promise<void>
  uploadItems: UploadItem[]
  uploadFiles: (files: File[]) => Promise<void>
  searchResults: SearchResult[] | null
  runSearch: (query: string) => Promise<void>
  clearSearch: () => void
  sharedItems: DecryptedIncomingShare[]
  acceptShare: (share: DecryptedIncomingShare) => Promise<void>
  /** Create a new encrypted folder in the current directory. */
  createFolder: (name: string) => Promise<void>
  // Notifications (ported from app.js notifications subsystem)
  notifications: StashNotification[]
  unreadNotificationCount: number
  markNotificationRead: (id: string) => void
  markAllNotificationsRead: () => void
  acceptNotification: (id: string) => void
  declineNotification: (id: string) => void
  /**
   * Storage quota from the server. null while loading or when the server
   * returns no quota. Fields mirror the legacy quota API response.
   */
  quota: {
    enabled: boolean
    usedHuman: string
    limitHuman: string
    percent: number
    unlimited: boolean
  } | null
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
  const [uploadItems, setUploadItems] = useState<UploadItem[]>([])
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null)
  const [sharedItems, setSharedItems] = useState<DecryptedIncomingShare[]>([])
  const [migrationFiles, setMigrationFiles] = useState<StashFile[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notifications, setNotifications] = useState<StashNotification[]>(() => loadStoredNotifications())
  const [quota, setQuota] = useState<StashContextValue['quota']>(null)
  /**
   * Retry ticker for the quota fetch.
   *
   * The quota effect bails when auth is not ready yet, and authPort is a module
   * singleton rather than React state, so nothing re-renders this provider when
   * the connection later comes up. With an empty dependency array the effect
   * therefore ran exactly once, lost the race on a cold load, and the storage
   * bar simply never appeared — silently, because the guard returns rather than
   * throwing.
   *
   * Bumping this on an interval while unresolved gives the effect a reason to
   * run again. It stops as soon as quota is set, so a settled app is not
   * polling the API forever.
   */
  const [quotaAttempt, setQuotaAttempt] = useState(0)

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

      // Ported from legacy checkMigration(): scan for unencrypted files. The
      // legacy version checked `!f.encrypted && !f.encryption`; we keep the
      // same predicate. Only run for authenticated sessions — no point surfacing
      // the modal before the key store is ready.
      if (authPort.isConnected) {
        const unencrypted = visibleFiles.filter((f) => !f.encrypted && !f.encryption)
        setMigrationFiles(unencrypted)
      }
    } catch (err) {
      console.error('loadFiles: Failed -', err)
      setError('Failed to load files')
    } finally {
      setLoading(false)
    }
  }, [])

  const loadFiles = useCallback(() => loadFilesFor(folderIdRef.current), [loadFilesFor])

  const dismissMigration = useCallback(() => setMigrationFiles([]), [])

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

  const loadShared = useCallback(async () => {
    if (!authPort.isConnected) return
    setLoading(true)
    setError(null)
    try {
      setSharedItems(await Sharing.listIncomingShares())
    } catch (err) {
      console.error('loadShared failed', err)
      setError('Failed to load shares')
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
      } else if (next === 'shared') {
        await loadShared()
      }
    },
    [loadFilesFor, loadSpecialView, loadShared],
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

  const selectAll = useCallback(() => {
    if (view === 'my-files') {
      setSelectedFiles(new Set(files.map((f) => f.sha256)))
      setSelectedFolders(new Set(folders.map((f) => f.id)))
    } else {
      setSelectedFiles(new Set(specialFiles.map((f) => f.sha256)))
      setSelectedFolders(new Set())
    }
  }, [view, files, folders, specialFiles])

  const reloadCurrentView = useCallback(async () => {
    if (view === 'my-files') await loadFilesFor(folderIdRef.current)
    else if (view === 'starred' || view === 'recent' || view === 'trash') await loadSpecialView(view)
  }, [view, loadFilesFor, loadSpecialView])

  const deleteFile = useCallback(
    async (file: StashFile) => {
      setLoading(true)
      setError(null)
      try {
        await softDeleteFile(file)
        await reloadCurrentView()
      } catch (err) {
        console.error('deleteFile failed', err)
        setError('Failed to delete file')
      } finally {
        setLoading(false)
      }
    },
    [reloadCurrentView],
  )

  const deleteFolder = useCallback(
    async (folderId: string) => {
      setLoading(true)
      setError(null)
      try {
        await deleteFolders([folderId])
        await Promise.all([reloadCurrentView(), loadFolderTree()])
      } catch (err) {
        console.error('deleteFolder failed', err)
        setError('Failed to delete folder')
      } finally {
        setLoading(false)
      }
    },
    [reloadCurrentView, loadFolderTree],
  )

  // Port of app.js bulkDelete: soft-delete each selected file (throttled to
  // respect relay rate limits), then one batched kind:5 event for folders.
  const deleteSelected = useCallback(async () => {
    const shas = [...selectedFiles]
    const folderIds = [...selectedFolders]
    if (shas.length === 0 && folderIds.length === 0) return

    setLoading(true)
    setError(null)
    try {
      const pool = [...files, ...specialFiles]
      for (const sha of shas) {
        const file = pool.find((f) => f.sha256 === sha)
        if (file) {
          await softDeleteFile(file)
          await delay(RELAY_THROTTLE_MS)
        }
      }
      await deleteFolders(folderIds)
      clearSelection()
      await Promise.all([reloadCurrentView(), loadFolderTree()])
    } catch (err) {
      console.error('deleteSelected failed', err)
      setError('Failed to delete selection')
    } finally {
      setLoading(false)
    }
  }, [selectedFiles, selectedFolders, files, specialFiles, clearSelection, reloadCurrentView, loadFolderTree])

  // Move every selected file to targetFolderId. Folders in the selection are
  // not moved (no folder-move operation exists). Mirrors deleteSelected's
  // throttling pattern to respect relay rate limits.
  const moveSelected = useCallback(
    async (targetFolderId: string) => {
      const shas = [...selectedFiles]
      if (shas.length === 0) return

      setLoading(true)
      setError(null)
      try {
        const pool = [...files, ...specialFiles]
        for (const sha of shas) {
          const file = pool.find((f) => f.sha256 === sha)
          if (file) {
            await opMoveFile(file, targetFolderId)
            await delay(RELAY_THROTTLE_MS)
          }
        }
        clearSelection()
        await reloadCurrentView()
      } catch (err) {
        console.error('moveSelected failed', err)
        setError('Failed to move selection')
      } finally {
        setLoading(false)
      }
    },
    [selectedFiles, files, specialFiles, clearSelection, reloadCurrentView],
  )

  const restoreFile = useCallback(
    async (file: StashFile) => {
      setLoading(true)
      setError(null)
      try {
        await opRestoreFile(file)
        await loadSpecialView('trash')
      } catch (err) {
        console.error('restoreFile failed', err)
        setError('Failed to restore file')
      } finally {
        setLoading(false)
      }
    },
    [loadSpecialView],
  )

  const permanentDeleteFile = useCallback(
    async (file: StashFile) => {
      setLoading(true)
      setError(null)
      try {
        await opPermanentDeleteFile(file)
        await loadSpecialView('trash')
      } catch (err) {
        console.error('permanentDeleteFile failed', err)
        setError('Failed to permanently delete file')
      } finally {
        setLoading(false)
      }
    },
    [loadSpecialView],
  )

  // Permanently delete every file in the trash with one batch kind:5 event.
  // Mirrors legacy emptyTrash() at app.js:3089.
  const emptyTrash = useCallback(async () => {
    const trashFiles = specialFiles.filter((f) => f.deleted_at || f.deletedAt)
    if (trashFiles.length === 0) return
    setLoading(true)
    setError(null)
    try {
      const fileIds = trashFiles.map((f) => fileIdOf(f)).filter(Boolean)
      if (fileIds.length > 0) {
        const event = await Events.createBatchDeleteEvent(fileIds, [])
        await authPort.publishEvent(event)
      }
      await loadSpecialView('trash')
    } catch (err) {
      console.error('emptyTrash failed', err)
      setError('Failed to empty trash')
    } finally {
      setLoading(false)
    }
  }, [specialFiles, loadSpecialView])

  const renameFile = useCallback(
    async (file: StashFile, newName: string) => {
      setError(null)
      try {
        await opRenameFile(file, newName)
        await reloadCurrentView()
      } catch (err) {
        console.error('renameFile failed', err)
        setError('Failed to rename file')
      }
    },
    [reloadCurrentView],
  )

  const renameFolder = useCallback(
    async (folder: StashFolder, newName: string) => {
      setError(null)
      try {
        await opRenameFolder(folder, newName)
        await Promise.all([reloadCurrentView(), loadFolderTree()])
      } catch (err) {
        console.error('renameFolder failed', err)
        setError('Failed to rename folder')
      }
    },
    [reloadCurrentView, loadFolderTree],
  )

  const moveFile = useCallback(
    async (file: StashFile, targetFolderId: string) => {
      setError(null)
      try {
        await opMoveFile(file, targetFolderId)
        await reloadCurrentView()
      } catch (err) {
        console.error('moveFile failed', err)
        setError('Failed to move file')
      }
    },
    [reloadCurrentView],
  )

  const copyFile = useCallback(
    async (file: StashFile, targetFolderId: string | null) => {
      setLoading(true)
      setError(null)
      try {
        await libCopyFile(file, targetFolderId)
        await reloadCurrentView()
      } catch (err) {
        console.error('copyFile failed', err)
        setError('Failed to copy file')
      } finally {
        setLoading(false)
      }
    },
    [reloadCurrentView],
  )

  const uploadFiles = useCallback(
    async (fileList: File[]) => {
      const list = Array.from(fileList)
      if (list.length === 0) return
      setUploadItems([])
      const upsert = (it: UploadItem) =>
        setUploadItems((prev) => {
          const idx = prev.findIndex((p) => p.id === it.id)
          if (idx === -1) return [...prev, it]
          const next = prev.slice()
          next[idx] = it
          return next
        })
      const existing = view === 'my-files' ? files : specialFiles
      await libUploadFiles(list, { folderId: folderIdRef.current || null, existing, onItem: upsert })
      await Promise.all([reloadCurrentView(), loadFolderTree()])
    },
    [view, files, specialFiles, reloadCurrentView, loadFolderTree],
  )

  const runSearch = useCallback(async (query: string) => {
    setSearchQuery(query)
    if (!query.trim()) {
      setSearchResults(null)
      return
    }
    try {
      setSearchResults(await Search.search(query))
    } catch (err) {
      console.error('search failed', err)
      setSearchResults([])
    }
  }, [])

  const clearSearch = useCallback(() => {
    setSearchQuery('')
    setSearchResults(null)
  }, [])

  const acceptShare = useCallback(
    async (share: DecryptedIncomingShare) => {
      setError(null)
      try {
        await Sharing.acceptShare(share)
        await Promise.all([loadFolderTree(), loadShared()])
      } catch (err) {
        console.error('acceptShare failed', err)
        setError('Failed to accept share')
      }
    },
    [loadFolderTree, loadShared],
  )

  // Port of app.js App.createFolder().
  // (1) Generate a random 16-byte folder ID; (2) derive and locally cache a fresh
  // AES key; (3) self-encrypt the key hex via NIP-44/NIP-04; (4) build a signed
  // kind:30079 event; (5) publish directly to the relay (client-side, no HTTP round-trip);
  // (6) reload files and folder tree.
  const createFolder = useCallback(
    async (name: string) => {
      const pubkey = authPort.pubkey
      if (!authPort.isConnected || !pubkey) throw new Error('Not connected')

      const folderId = Events.generateFolderId()
      const folderKey = await Keys.generateFolderKey(folderId)
      const folderKeyHex = Crypto.bytesToHex(folderKey)
      const encryptedFolderKey = await Keys.selfEncrypt(pubkey, folderKeyHex)

      const signedEvent = await Events.createEncryptedFolderEvent({
        id: folderId,
        name: name.trim(),
        parentId: folderIdRef.current || undefined,
        encryptedFolderKey,
      })

      await authPort.publishEvent(signedEvent)
      await Promise.all([loadFilesFor(folderIdRef.current), loadFolderTree()])
    },
    [loadFilesFor, loadFolderTree],
  )

  // ── Notifications ──────────────────────────────────────────────────────────
  // Ported from app.js: loadNotifications / startNotificationPolling /
  // checkForNewShares / addNotification / markNotificationRead /
  // markAllNotificationsRead / acceptShare (notification variant) /
  // declineShare.

  const unreadNotificationCount = useMemo(
    () => notifications.filter((n) => !n.read).length,
    [notifications],
  )

  // Persist and update state in one call.
  const applyNotifications = useCallback((next: StashNotification[]) => {
    saveStoredNotifications(next)
    setNotifications(next)
  }, [])

  const markNotificationRead = useCallback(
    (id: string) => {
      setNotifications((prev) => {
        const next = prev.map((n) => (n.id === id ? { ...n, read: true } : n))
        saveStoredNotifications(next)
        return next
      })
    },
    [],
  )

  const markAllNotificationsRead = useCallback(() => {
    setNotifications((prev) => {
      const next = prev.map((n) => ({ ...n, read: true }))
      saveStoredNotifications(next)
      return next
    })
  }, [])

  const acceptNotification = useCallback(
    (id: string) => {
      setNotifications((prev) => {
        const next = prev.map((n) =>
          n.id === id ? { ...n, read: true, accepted: true } : n,
        )
        saveStoredNotifications(next)
        return next
      })
      // Refresh shared view so the newly-accepted share appears.
      void loadShared()
    },
    [loadShared],
  )

  const declineNotification = useCallback(
    (id: string) => {
      setNotifications((prev) => {
        const next = prev.map((n) =>
          n.id === id ? { ...n, read: true, declined: true } : n,
        )
        saveStoredNotifications(next)
        return next
      })
    },
    [],
  )

  // Polling: mirrors checkForNewShares() + startNotificationPolling() in app.js.
  // Uses a stable ref to avoid re-creating the interval when notifications change.
  const notificationsRef = useRef<StashNotification[]>(notifications)
  notificationsRef.current = notifications

  const checkForNewShares = useCallback(async () => {
    const pubkey = authPort.pubkey
    if (!authPort.isConnected || !pubkey) return

    try {
      const response = (await API.listShares(pubkey, 'received')) as unknown as {
        received?: Array<{ id: string; owner_pubkey: string; name?: string; isFolder?: boolean }>
        shares?: Array<{ id: string; owner_pubkey: string; name?: string; isFolder?: boolean }>
      }
      // The API may return shares under `received` (type='received') or `shares`.
      const shares = response.received ?? response.shares ?? []

      const existingIds = new Set(
        notificationsRef.current
          .filter((n) => n.type === 'share_received' || n.type === 'share_folder')
          .map((n) => n.data.shareId),
      )

      const newNotifications: StashNotification[] = []
      for (const share of shares) {
        if (existingIds.has(share.id)) continue
        const from =
          share.owner_pubkey && share.owner_pubkey.length > 8
            ? `${share.owner_pubkey.slice(0, 8)}…`
            : share.owner_pubkey || 'Someone'
        const notif: StashNotification = {
          id: Date.now().toString() + Math.random().toString(36).slice(2),
          type: share.isFolder ? 'share_folder' : 'share_received',
          data: {
            shareId: share.id,
            name: share.name || 'Unknown',
            from,
          },
          timestamp: Date.now(),
          read: false,
        }
        newNotifications.push(notif)

        // Fire a Web Notifications API toast if permitted.
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          const body =
            notif.type === 'share_folder'
              ? `${from} shared folder "${notif.data.name}" with you`
              : `${from} shared "${notif.data.name}" with you`
          // eslint-disable-next-line no-new
          new Notification('Cloistr Stash', { body, icon: '/favicon.svg' })
        }
      }

      if (newNotifications.length > 0) {
        applyNotifications([...newNotifications, ...notificationsRef.current])
      }
    } catch (err) {
      console.warn('checkForNewShares failed:', err)
    }
  }, [applyNotifications])

  // Start polling when connected; stop when disconnected.
  const isConnectedForPolling = authPort.isConnected
  useEffect(() => {
    if (!isConnectedForPolling) return

    const initialTimer = setTimeout(() => {
      void checkForNewShares()
    }, NOTIFICATION_INITIAL_DELAY_MS)

    const interval = setInterval(() => {
      void checkForNewShares()
    }, NOTIFICATION_POLL_MS)

    return () => {
      clearTimeout(initialTimer)
      clearInterval(interval)
    }
  }, [isConnectedForPolling, checkForNewShares])

  // ── End notifications ──────────────────────────────────────────────────────

  // Give the quota fetch below another chance while it has no result yet.
  // Bounded: it clears the moment quota resolves.
  useEffect(() => {
    if (quota) return
    const id = setInterval(() => setQuotaAttempt((n) => n + 1), 3000)
    return () => clearInterval(id)
  }, [quota])

  // Fetch storage quota when connected. Mirrors legacy App.displayStorageUsage
  // at app.js:6069, which drives the #storage-bar-fill / #storage-details DOM.
  useEffect(() => {
    const pubkey = authPort.pubkey
    if (!authPort.isConnected || !pubkey) return
    API.getQuota(pubkey)
      .then((q) => {
        const raw = q as Record<string, unknown>
        const enabled = !!raw.enabled
        const limitBytes = Number(raw.limit ?? 0)
        setQuota({
          enabled,
          usedHuman: String(raw.used_human ?? '0 B'),
          limitHuman: String(raw.limit_human ?? ''),
          percent: Math.min(100, Math.max(0, Number(raw.percent ?? 0))),
          unlimited: !enabled || limitBytes === 0,
        })
      })
      .catch((err) => {
        console.warn('Failed to fetch quota:', err)
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quotaAttempt])

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
      selectAll,
      clearSelection,
      setSelectionMode,
      deleteFile,
      deleteFolder,
      deleteSelected,
      restoreFile,
      permanentDeleteFile,
      emptyTrash,
      renameFile,
      renameFolder,
      moveFile,
      moveSelected,
      copyFile,
      uploadItems,
      uploadFiles,
      searchResults,
      runSearch,
      clearSearch,
      sharedItems,
      acceptShare,
      createFolder,
      migrationFiles,
      dismissMigration,
      notifications,
      unreadNotificationCount,
      markNotificationRead,
      markAllNotificationsRead,
      acceptNotification,
      declineNotification,
      quota,
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
      selectAll,
      clearSelection,
      deleteFile,
      deleteFolder,
      deleteSelected,
      restoreFile,
      permanentDeleteFile,
      emptyTrash,
      renameFile,
      renameFolder,
      moveFile,
      moveSelected,
      copyFile,
      uploadItems,
      uploadFiles,
      searchResults,
      runSearch,
      clearSearch,
      sharedItems,
      acceptShare,
      createFolder,
      migrationFiles,
      dismissMigration,
      notifications,
      unreadNotificationCount,
      markNotificationRead,
      markAllNotificationsRead,
      acceptNotification,
      declineNotification,
      quota,
    ],
  )

  return <StashContext.Provider value={value}>{children}</StashContext.Provider>
}
