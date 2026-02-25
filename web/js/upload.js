// Upload handling module with client-side encryption
// Files are encrypted before upload - server only sees encrypted blobs

const Upload = {
    files: [],
    isUploading: false,
    targetFolderId: null,  // For uploading to specific folder

    // Add files to the upload queue
    addFiles(fileList) {
        for (const file of fileList) {
            // Check for duplicates
            const exists = this.files.some(f =>
                f.file.name === file.name && f.file.size === file.size
            );

            if (!exists) {
                this.files.push({
                    id: crypto.randomUUID(),
                    fileId: Crypto.generateFileId(), // Unique ID for key derivation
                    file: file,
                    status: 'pending', // pending, encrypting, hashing, uploading, publishing, success, error
                    progress: 0,
                    error: null,
                    result: null,
                    plaintextHash: null,   // SHA-256 of original file
                    encryptedHash: null,   // SHA-256 of encrypted blob (Blossom hash)
                    encryptedBlob: null,   // Encrypted file data
                });
            }
        }

        return this.files;
    },

    // Remove a file from the queue
    removeFile(id) {
        this.files = this.files.filter(f => f.id !== id);
        return this.files;
    },

    // Clear all files
    clear() {
        this.files = [];
        this.targetFolderId = null;
    },

    // Upload all pending files with client-side encryption
    async uploadAll(onProgress, onComplete) {
        if (this.isUploading) return;
        this.isUploading = true;

        // Ensure crypto is initialized
        await Crypto.init();

        const pending = this.files.filter(f => f.status === 'pending');
        console.log(`Upload: Starting encrypted upload of ${pending.length} files`);

        // Show floating progress indicator
        UI.showUploadProgress(0, pending.length);

        let completed = 0;

        for (const item of pending) {
            try {
                console.log(`Upload: Processing ${item.file.name} (${this.formatSize(item.file.size)})`);

                // Step 1: Read file content
                const fileBuffer = await item.file.arrayBuffer();
                const fileData = new Uint8Array(fileBuffer);

                // Step 2: Calculate plaintext hash (for our records and deduplication)
                item.plaintextHash = await Crypto.hash(fileData);
                console.log(`Upload: Plaintext hash: ${item.plaintextHash.slice(0, 16)}...`);

                // Step 2.5: Check for duplicate (same content already uploaded)
                const existingFile = App.files.find(f => f.plaintext_hash === item.plaintextHash || f.plaintextHash === item.plaintextHash);
                if (existingFile) {
                    console.log(`Upload: Duplicate detected - ${existingFile.name} has same content`);
                    item.status = 'duplicate';
                    item.error = `Duplicate of "${existingFile.name}"`;
                    item.duplicateOf = existingFile;
                    completed++;
                    if (onProgress) onProgress(item);
                    UI.updateUploadProgress(completed, pending.length);
                    continue; // Skip uploading this file
                }

                // Step 3: Get encryption key for this file
                item.status = 'encrypting';
                if (onProgress) onProgress(item);
                UI.updateUploadProgress(completed, pending.length, `Encrypting ${item.file.name}...`);

                const folderId = this.targetFolderId || App.currentFolderId || null;
                let fileKey;
                if (folderId) {
                    fileKey = await Keys.deriveFileKey(folderId, item.fileId);
                } else {
                    fileKey = await Keys.deriveRootFileKey(item.fileId);
                }

                // Step 4: Encrypt file content
                console.log('Upload: Encrypting file...');
                const encryptedData = await Crypto.encryptFile(fileData, fileKey, (progress) => {
                    item.progress = Math.round(progress * 50); // Encryption is 0-50%
                    if (onProgress) onProgress(item);
                });
                item.encryptedBlob = encryptedData;
                console.log(`Upload: Encrypted size: ${this.formatSize(encryptedData.length)} (overhead: +${encryptedData.length - fileData.length} bytes)`);

                // Step 5: Hash the encrypted content (this is the Blossom hash)
                item.status = 'hashing';
                if (onProgress) onProgress(item);
                UI.updateUploadProgress(completed, pending.length, `Hashing ${item.file.name}...`);

                item.encryptedHash = await Crypto.hash(encryptedData);
                console.log(`Upload: Encrypted hash: ${item.encryptedHash.slice(0, 16)}...`);

                // Step 6: Create auth event for the encrypted hash
                item.status = 'uploading';
                if (onProgress) onProgress(item);
                UI.updateUploadProgress(completed, pending.length, `Uploading ${item.file.name}...`);

                let authHeader = null;
                if (Auth.isConnected) {
                    console.log('Upload: Creating upload auth...');
                    authHeader = await Auth.createUploadAuth(
                        item.encryptedHash,
                        encryptedData.length,
                        'application/octet-stream' // Encrypted files are always octet-stream
                    );
                }

                // Step 7: Upload encrypted blob
                console.log('Upload: Sending encrypted blob to server...');
                const encryptedFile = new File([encryptedData], item.file.name + '.encrypted', {
                    type: 'application/octet-stream',
                });
                const result = await API.uploadFile(encryptedFile, authHeader);
                console.log(`Upload: Server responded with sha256: ${result.sha256?.slice(0, 16)}...`);

                // Step 8: Publish encrypted file metadata to relay
                if (Auth.isConnected) {
                    item.status = 'publishing';
                    if (onProgress) onProgress(item);
                    console.log('Upload: Publishing encrypted file metadata to relay...');
                    UI.updateUploadProgress(completed, pending.length, `Publishing ${item.file.name}...`);

                    const metadataEvent = await Auth.createEncryptedFileMetadataEvent({
                        fileId: item.fileId,
                        sha256: result.sha256,                    // Hash of encrypted blob
                        plaintextHash: item.plaintextHash,        // Hash of original file
                        name: item.file.name,
                        size: item.file.size,                     // Original size
                        encryptedSize: encryptedData.length,      // Encrypted size
                        mimeType: item.file.type || 'application/octet-stream',
                        folderId: folderId,
                        encrypted: true,
                    });

                    console.log('Upload: Metadata event details:', {
                        kind: metadataEvent.kind,
                        pubkey: metadataEvent.pubkey?.slice(0, 16) + '...',
                        id: metadataEvent.id?.slice(0, 16) + '...',
                        tags: metadataEvent.tags?.map(t => [t[0], t[1]?.slice(0, 16) + (t[1]?.length > 16 ? '...' : '')]),
                    });

                    // Publish directly to relay (client-side) - this must succeed
                    const publishResult = await Auth.publishEvent(metadataEvent);
                    console.log('Upload: Encrypted metadata published successfully:', publishResult);
                }

                // Wipe the encryption key from memory
                Crypto.wipeKey(fileKey);

                item.status = 'success';
                item.result = result;
                item.progress = 100;
                completed++;
                console.log(`Upload: Success! (${completed}/${pending.length})`);

                // Index the file for search (if search is initialized)
                if (typeof Search !== 'undefined' && Search.indexKey) {
                    try {
                        const fileInfo = {
                            file_id: item.fileId,
                            sha256: result.sha256,
                            name: item.file.name,
                            size: item.file.size,
                            mime_type: item.file.type,
                            encrypted: true,
                        };
                        // Index with plaintext content (still in fileData)
                        await Search.indexFile(fileInfo, fileData);
                        console.log('Upload: Indexed file for search');
                    } catch (indexErr) {
                        console.warn('Upload: Failed to index file:', indexErr);
                    }
                }

                // Clear encrypted data from memory
                item.encryptedBlob = null;

            } catch (err) {
                item.status = 'error';
                item.error = err.message;
                completed++;
                console.error(`Upload: Failed - ${err.message}`, err);
                // If this was a metadata publishing error, the blob is on Blossom but not tracked
                if (err.message.includes('Publish') || err.message.includes('auth')) {
                    console.error('Upload: Metadata publish failed! Blob uploaded to Blossom but not indexed.');
                    console.error('Upload: Encrypted blob hash:', item.encryptedHash);
                }
            }

            if (onProgress) onProgress(item);
            UI.updateUploadProgress(completed, pending.length);
        }

        this.isUploading = false;

        // Hide progress after a short delay
        setTimeout(() => UI.hideUploadProgress(), 2000);

        if (onComplete) onComplete(this.files);
    },

    // Format file size for display
    formatSize(bytes) {
        if (bytes === 0) return '0 B';

        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        const size = bytes / Math.pow(1024, i);

        return `${size.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
    },

    // Get file icon based on mime type
    getFileIcon(mimeType) {
        if (!mimeType) return '📄';

        if (mimeType.startsWith('image/')) return '🖼️';
        if (mimeType.startsWith('video/')) return '🎬';
        if (mimeType.startsWith('audio/')) return '🎵';
        if (mimeType.startsWith('text/')) return '📝';
        if (mimeType.includes('pdf')) return '📕';
        if (mimeType.includes('zip') || mimeType.includes('tar') || mimeType.includes('compressed')) return '📦';
        if (mimeType.includes('json') || mimeType.includes('javascript')) return '📜';

        return '📄';
    },
};
