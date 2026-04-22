# Cloistr Stash - Retest Checklist

Items fixed in commit `ae44753` that need verification after deployment.

## Fixed Issues to Verify

### 1. Authentication - NIP-07 Session Persistence
**Original issue:** Session did not persist after page refresh with browser extension
**Fix:** Added localStorage-based session persistence in auth.js

- [ ] Connect with NIP-07 browser extension
- [ ] Refresh the page
- [ ] Verify still logged in (no re-auth required)

### 2. Folder Operations - Files in Folders After Refresh
**Original issue:** Files uploaded to folders disappeared after page refresh
**Fix:** Server now returns encrypted folder keys, client restores them on load

- [ ] Create a folder
- [ ] Upload a file into the folder
- [ ] Navigate into the folder, verify file is visible
- [ ] Refresh the page
- [ ] Navigate into the folder again
- [ ] Verify file is still visible and can be downloaded/previewed

### 3. File Operations - Rename
**Original issue:** No rename option in context menu
**Fix:** Added modal-based rename for files and folders

- [ ] Right-click a file, verify "Rename" option appears
- [ ] Click Rename, verify modal opens with current filename
- [ ] Rename the file, verify new name appears
- [ ] Right-click a folder, verify "Rename" option appears
- [ ] Rename a folder, verify new name appears
- [ ] Try invalid names (empty, special chars), verify rejection

### 4. Views - Starred/Recent/Trash Empty State
**Original issue:** Starred, Recent, and Trash views showed "No shared files" instead of appropriate messages
**Fix:** Moved empty-state element outside file-list-body in index.html

- [ ] Click Starred (with no starred files), verify shows "No starred files" message
- [ ] Click Recent (with no recent files), verify shows "No recent files" message
- [ ] Click Trash (with no deleted files), verify shows "Trash is empty" message
- [ ] Star a file, click Starred, verify file appears
- [ ] Delete a file, click Trash, verify file appears

### 5. Folder Operations - Customize Error
**Original issue:** `refreshFileList is not a function` error when customizing folders
**Fix:** Changed to `loadFiles()` which is the correct method name

- [ ] Right-click a folder, click "Customize"
- [ ] Select a color and/or icon
- [ ] Click Save
- [ ] Verify no error, folder appearance updates

### 6. Drag-Drop Overlay
**Original issue:** Drop overlay would not hide after dragging away
**Fix:** Added timeout fallback and fixed dragleave event filtering

- [ ] Drag a file over the page, verify overlay appears
- [ ] Drag the file away (don't drop), verify overlay hides within 1-2 seconds
- [ ] Drop a file, verify upload starts and overlay hides

### 7. Breadcrumbs Navigation
**Original issue:** Double slashes and weird paths when navigating via sidebar
**Fix:** Removed duplicate CSS separator, added `navigateToFolderAbsolute()` for sidebar

- [ ] Create nested folders (e.g., Folder1 > Folder2 > Folder3)
- [ ] Navigate using breadcrumbs, verify no double slashes
- [ ] Click folder in sidebar tree, verify breadcrumb shows correct absolute path
- [ ] Jump between folders using sidebar, verify breadcrumbs stay correct

### 8. Keyboard Shortcuts
**Original issue:** Shortcuts not working
**Fix:** Changed to single-key shortcuts, added help modal

- [ ] Press `?` - verify keyboard shortcuts help modal opens
- [ ] Press `u` - verify upload modal opens
- [ ] Press `n` - verify new folder modal opens
- [ ] Press `/` - verify search box focuses
- [ ] Press `Escape` - verify modals close
- [ ] Press `a` - verify all files selected (when in file list)

### 9. Relay Settings
**Original issue:** Add relay and toggle not persisting
**Fix:** Removed duplicate event listeners from app.js

- [ ] Open relay settings
- [ ] Add a new relay URL (e.g., `wss://relay.damus.io`)
- [ ] Verify it appears in the list
- [ ] Toggle read/write settings
- [ ] Save and reopen settings
- [ ] Verify changes persisted

---

## Items NOT Fixed (Known Issues)

These were documented in testing but not addressed in this commit:

1. **Large file chunking** - No visible progress/logs for chunked uploads
2. **Deduplication message** - Not shown when uploading duplicate file
3. **Text editor (Collaboration)** - Requires y-protocols bundle
4. **Search filters** - No filter button visible
5. **Version history** - Uploads new file instead of updating version
6. **Ctrl+click / Shift+click selection** - Only checkbox selection works
7. **Responsive/Mobile** - Not tested
8. **Offline/PWA** - Not tested

---

## Sharing/Collaboration Tests (Now Unblocked)

**Second key whitelisted:** `0b290298b6f9f5b45a923ff39a8cebbd3a7b90106395016afafcfb702dcad50a`

After ArgoCD syncs the config, you can now test:
- [ ] Section 6: Sharing (Share with Nostr User, Public Links, Manage Shares)
- [ ] Section 9: Notifications (requires second account)
- [ ] Connecting with different identity shows different files

---

**Generated:** 2026-03-19
