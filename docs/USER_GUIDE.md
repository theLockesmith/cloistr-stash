# Cloistr Drive User Guide

## What is Cloistr Drive?

Cloistr Drive is a zero-knowledge file manager - a Google Drive replacement where **we cannot read your files**. All encryption happens in your browser before files are uploaded. Your Nostr identity is your login.

## Getting Started

### Prerequisites

You need a Nostr identity to use Cloistr Drive. There are two ways to authenticate:

1. **NIP-07 Browser Extension** (recommended)
   - Install a Nostr signer extension like [Alby](https://getalby.com), [nos2x](https://github.com/fiatjaf/nos2x), or [Nostr Connect](https://github.com/nicklaros/nostr-connect)
   - Create or import your Nostr keys in the extension

2. **NIP-46 Remote Signer**
   - Use a bunker URL from services like [nsecBunker](https://nsecbunker.com)
   - This keeps your keys on a separate device

### Connecting Your Account

1. Visit [drive.cloistr.xyz](https://drive.cloistr.xyz)
2. Click **Connect with Extension** (NIP-07) or **Connect with Bunker** (NIP-46)
3. Approve the connection request in your signer
4. You're now logged in with your Nostr identity

---

## File Management

### Uploading Files

**Method 1: Upload Button**
1. Click the **Upload** button in the toolbar
2. Select one or more files from your computer
3. Wait for the upload to complete

**Method 2: Drag and Drop**
1. Drag files from your desktop or file explorer
2. Drop them onto the Drive window (you'll see a blue overlay)
3. Files will upload automatically

### Downloading Files

1. Right-click on a file
2. Select **Download** from the context menu
3. Or double-click the file to preview/download

### Deleting Files

1. Right-click on a file
2. Select **Delete** from the context menu
3. The file moves to Trash (can be restored for 30 days)

### Batch Operations

1. Hold **Shift** and click to select multiple files
2. Or click the checkbox that appears when hovering
3. Use the batch action buttons that appear in the toolbar

---

## Folder Organization

### Creating Folders

1. Click **New Folder** in the toolbar
2. Enter a folder name
3. The folder is created in your current location

### Navigating Folders

- **Double-click** a folder to open it
- Use the **breadcrumb trail** at the top to navigate back
- Click **Home** to return to the root folder

### Moving Files

1. Right-click on a file or folder
2. Select **Move to...**
3. Choose the destination folder

### Folder Customization

Right-click on a folder to:
- Change the folder **color**
- Set a custom **icon**
- Add a **description**

---

## Searching and Filtering

### Quick Search

1. Type in the **search box** in the toolbar
2. Results filter as you type
3. Press Enter to search

### Advanced Filters

Click the **filter icon** next to search to filter by:
- **File type**: Images, Videos, Documents, Audio, Archives, Code
- **Date**: Today, This week, This month, This year
- **Size**: Small (<1MB), Medium (1-10MB), Large (10-100MB), Huge (>100MB)

### Sorting

Use the **Sort** dropdown to sort files by:
- Name (A-Z or Z-A)
- Date (Newest or Oldest)
- Size (Largest or Smallest)
- Type (by extension)

---

## Sharing Files

### Share with Nostr Users

1. Right-click on a file
2. Select **Share**
3. Enter the recipient's:
   - Nostr public key (npub or hex)
   - NIP-05 identifier (e.g., name@domain.com)
4. Set permissions (read or write)
5. Optionally set an expiration date
6. Click **Share**

The recipient will see the shared file in their **Shared with me** view.

### Create Public Link

1. Right-click on a file
2. Select **Get Link**
3. Configure options:
   - Expiration time
   - Maximum downloads
   - Password protection
4. Click **Create Link**
5. Copy the link to share

**Important:** The decryption key is in the URL fragment (after #) and is never sent to our servers.

### Managing Shares

1. Click **Shared** in the sidebar
2. View files you've shared and files shared with you
3. Right-click to revoke access or manage permissions

---

## Views

### My Files
Your personal files and folders.

### Shared
- **Shared by me**: Files you've shared with others
- **Shared with me**: Files others have shared with you

### Starred
Files you've marked as favorites. Right-click a file and select **Star** to add it.

### Recent
Files you've recently accessed or modified.

### Trash
Deleted files waiting to be permanently removed (30 days).

---

## Preview and Media

Cloistr Drive supports previewing many file types directly in the browser:

### Images
- Click to view full size
- Supports: JPEG, PNG, GIF, WebP, SVG, BMP

### Videos
- Click to play with built-in player
- Supports: MP4, WebM, MOV

### Audio
- Click to play with audio player
- Supports: MP3, WAV, OGG, FLAC, M4A

### Documents
- **PDF**: Full preview with page navigation
- **Text files**: Syntax highlighting for code
- **Markdown**: Rendered preview

### Code Files
Syntax highlighting for: JavaScript, Python, Go, Rust, HTML, CSS, JSON, YAML, and more.

---

## File Versions

Cloistr Drive automatically tracks file versions:

1. Right-click on a file
2. Select **Version History**
3. View all previous versions with timestamps
4. Click a version to preview or restore

---

## Comments and Notes

### Adding Comments

1. Right-click on a file
2. Select **Add Comment**
3. Enter your comment
4. Comments are visible only to you (client-side encrypted)

### Viewing Comments

Comments appear in the file details panel when you select a file.

---

## Settings and Preferences

### Theme

Click the **moon/sun icon** in the header to toggle between dark and light themes.

### Storage Usage

View your storage usage in the sidebar:
- Current usage
- Quota limit (if applicable)
- Available space

### Activity Log

Click **Activity** in the sidebar to view:
- Recent uploads
- Downloads
- Shares created
- Files deleted

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Delete` | Delete selected files |
| `Ctrl+A` | Select all files |
| `Escape` | Clear selection |
| `Enter` | Open selected file/folder |
| `Ctrl+F` | Focus search box |

---

## Privacy and Security

### Zero-Knowledge Architecture

- All files are encrypted **before** leaving your browser
- Encryption keys are derived from your Nostr identity
- We cannot read your files, even if we wanted to
- File names can optionally be encrypted

### Key Management

- Your master key is derived from your Nostr private key
- Each folder has its own key (derived from the master)
- Files use keys derived from their folder key
- Shared files use NIP-44 encrypted key exchange

### Public Links

- The decryption key is in the URL fragment (#)
- URL fragments are never sent to the server
- The server only knows the encrypted blob exists
- Password protection adds another encryption layer

---

## Offline Support

Cloistr Drive works offline for:
- Viewing cached files
- Queuing uploads (synced when online)
- Managing starred and recent lists

A banner appears when you're offline, and queued actions sync automatically when connection is restored.

---

## Troubleshooting

### Can't Connect

- Ensure your browser extension is installed and unlocked
- Check that you've granted permission to the site
- Try refreshing the page

### Upload Failed

- Check your internet connection
- Verify you haven't exceeded your storage quota
- Try uploading smaller files to test

### Can't See Shared Files

- Ask the sender to verify they shared with the correct pubkey
- Check the **Shared with me** view
- The share may have expired

### File Won't Preview

- Some file types don't have preview support
- Very large files may not preview
- Try downloading the file instead

---

## Support

For help or to report issues:
- GitHub Issues: [github.com/coldforge/cloistr-drive/issues](https://github.com/coldforge/cloistr-drive/issues)
- Nostr: Follow @cloistr on Nostr for updates

---

**Remember:** Your files are encrypted with keys only you control. If you lose access to your Nostr identity, you lose access to your files. Back up your keys safely!
