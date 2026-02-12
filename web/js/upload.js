// Upload handling module

const Upload = {
    files: [],
    isUploading: false,

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
                    file: file,
                    status: 'pending', // pending, hashing, uploading, success, error
                    progress: 0,
                    error: null,
                    result: null,
                    hash: null,
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
    },

    // Upload all pending files with Blossom auth
    async uploadAll(onProgress, onComplete) {
        if (this.isUploading) return;
        this.isUploading = true;

        const pending = this.files.filter(f => f.status === 'pending');

        for (const item of pending) {
            try {
                // Step 1: Hash the file
                item.status = 'hashing';
                if (onProgress) onProgress(item);

                const fileHash = await Auth.hashFile(item.file);
                item.hash = fileHash;

                // Step 2: Create auth event (if connected)
                item.status = 'uploading';
                if (onProgress) onProgress(item);

                let authHeader = null;
                if (Auth.isConnected) {
                    authHeader = await Auth.createUploadAuth(
                        fileHash,
                        item.file.size,
                        item.file.type
                    );
                }

                // Step 3: Upload with auth
                const result = await API.uploadFile(item.file, authHeader);

                // Step 4: Publish metadata to relay (if connected)
                if (Auth.isConnected) {
                    try {
                        const metadataEvent = await Auth.createFileMetadataEvent({
                            sha256: result.sha256,
                            name: item.file.name,
                            size: result.size,
                            mimeType: result.mime_type,
                        });
                        await API.publishMetadata(metadataEvent);
                    } catch (metaErr) {
                        console.warn('Failed to publish metadata:', metaErr);
                        // Continue even if metadata fails - file is still uploaded
                    }
                }

                item.status = 'success';
                item.result = result;
                item.progress = 100;
            } catch (err) {
                item.status = 'error';
                item.error = err.message;
            }

            if (onProgress) onProgress(item);
        }

        this.isUploading = false;
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
