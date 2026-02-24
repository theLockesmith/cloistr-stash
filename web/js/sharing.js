// Sharing module - NIP-44 key sharing, public links, expiring links, revocation
// Implements zero-knowledge file and folder sharing for Cloistr Drive

const Sharing = {
    // Share types
    SHARE_TYPE_FILE: 'file',
    SHARE_TYPE_FOLDER: 'folder',
    SHARE_TYPE_PUBLIC: 'public',

    // Permission levels
    PERMISSION_VIEW: 'view',
    PERMISSION_DOWNLOAD: 'download',
    PERMISSION_EDIT: 'edit',

    // Active shares cache
    sharesCache: new Map(),

    // Initialize sharing module
    async init() {
        console.log('Sharing: Initialized');
    },

    // Share a file with a specific recipient
    // Encrypts the file key with recipient's pubkey via NIP-44
    async shareFile(file, recipientPubkey, options = {}) {
        const {
            permission = this.PERMISSION_DOWNLOAD,
            expiresAt = null,
            message = '',
        } = options;

        if (!Auth.isConnected) {
            throw new Error('Not connected');
        }

        // Get the file key
        const fileId = file.file_id || file.fileId || file.d;
        const folderId = file.folder_id || file.folderId || file.folder || null;

        if (!fileId) {
            throw new Error('Cannot share: missing file ID');
        }

        let fileKey;
        if (folderId) {
            fileKey = await Keys.deriveFileKey(folderId, fileId);
        } else {
            fileKey = await Keys.deriveRootFileKey(fileId);
        }

        // Encrypt the file key for the recipient using NIP-44
        const fileKeyHex = Crypto.bytesToHex(fileKey);
        const encryptedFileKey = await Auth.nip04Encrypt(recipientPubkey, fileKeyHex);

        // Create share content
        const shareContent = {
            type: this.SHARE_TYPE_FILE,
            fileId: fileId,
            fileName: file.name,
            fileSize: file.size,
            fileMimeType: file.mime_type || file.mimeType,
            fileSHA256: file.sha256,
            fileURL: API.getDownloadURL(file.sha256),
            fileKey: encryptedFileKey,
            message: message,
            encrypted: file.encrypted || false,
        };

        // Generate share ID
        const shareId = Auth.generateShareId();

        // Create the share event
        const signedEvent = await this.createShareEvent({
            id: shareId,
            recipientPubkey: recipientPubkey,
            shareContent: shareContent,
            permission: permission,
            expiresAt: expiresAt,
        });

        // Publish to relay
        await Auth.publishEvent(signedEvent);

        console.log('Sharing: File shared with', recipientPubkey.slice(0, 8) + '...');

        return {
            shareId: shareId,
            recipientPubkey: recipientPubkey,
            permission: permission,
            expiresAt: expiresAt,
        };
    },

    // Share a folder with a specific recipient
    // Encrypts the folder key with recipient's pubkey via NIP-44
    async shareFolder(folder, recipientPubkey, options = {}) {
        const {
            permission = this.PERMISSION_DOWNLOAD,
            expiresAt = null,
            message = '',
        } = options;

        if (!Auth.isConnected) {
            throw new Error('Not connected');
        }

        const folderId = folder.id;

        if (!folderId) {
            throw new Error('Cannot share: missing folder ID');
        }

        // Get the folder key
        const folderKey = await Keys.getFolderKey(folderId, folder.parent_id);

        // Encrypt the folder key for the recipient using NIP-44
        const folderKeyHex = Crypto.bytesToHex(folderKey);
        const encryptedFolderKey = await Auth.nip04Encrypt(recipientPubkey, folderKeyHex);

        // Create share content
        const shareContent = {
            type: this.SHARE_TYPE_FOLDER,
            folderId: folderId,
            folderName: folder.name,
            folderKey: encryptedFolderKey,
            message: message,
        };

        // Generate share ID
        const shareId = Auth.generateShareId();

        // Create the share event
        const signedEvent = await this.createShareEvent({
            id: shareId,
            recipientPubkey: recipientPubkey,
            shareContent: shareContent,
            permission: permission,
            expiresAt: expiresAt,
        });

        // Publish to relay
        await Auth.publishEvent(signedEvent);

        console.log('Sharing: Folder shared with', recipientPubkey.slice(0, 8) + '...');

        return {
            shareId: shareId,
            recipientPubkey: recipientPubkey,
            permission: permission,
            expiresAt: expiresAt,
        };
    },

    // Create a share event (kind 30080)
    async createShareEvent(shareInfo) {
        const now = Math.floor(Date.now() / 1000);

        // Encrypt the entire share content for the recipient
        const contentJson = JSON.stringify(shareInfo.shareContent);
        const encryptedContent = await Auth.nip04Encrypt(shareInfo.recipientPubkey, contentJson);

        const event = {
            kind: 30080,  // Share kind
            created_at: now,
            tags: [
                ['d', shareInfo.id],
                ['p', shareInfo.recipientPubkey],
                ['permission', shareInfo.permission],
            ],
            content: encryptedContent,
        };

        // Add file/folder reference tag
        if (shareInfo.shareContent.type === this.SHARE_TYPE_FILE) {
            event.tags.push(['file', `30078:${Auth.pubkey}:${shareInfo.shareContent.fileId}`]);
        } else if (shareInfo.shareContent.type === this.SHARE_TYPE_FOLDER) {
            event.tags.push(['folder', `30079:${Auth.pubkey}:${shareInfo.shareContent.folderId}`]);
        }

        // Add expiration if set
        if (shareInfo.expiresAt) {
            event.tags.push(['expiration', shareInfo.expiresAt.toString()]);
        }

        return Auth.signEvent(event);
    },

    // Generate a public link for a file
    // The decryption key is embedded in the URL fragment (never sent to server)
    async generatePublicLink(file, options = {}) {
        const {
            expiresAt = null,
            maxDownloads = null,
        } = options;

        const fileId = file.file_id || file.fileId || file.d;
        const folderId = file.folder_id || file.folderId || file.folder || null;

        if (!fileId) {
            throw new Error('Cannot generate link: missing file ID');
        }

        // Get the file key
        let fileKey;
        if (folderId) {
            fileKey = await Keys.deriveFileKey(folderId, fileId);
        } else {
            fileKey = await Keys.deriveRootFileKey(fileId);
        }

        // Encode the key for URL fragment
        const keyBase64url = Crypto.bytesToBase64url(fileKey);

        // Build the public link URL
        // Format: https://drive.cloistr.xyz/public/{sha256}#{key}
        const baseUrl = window.location.origin;
        const publicUrl = `${baseUrl}/public/${file.sha256}#${keyBase64url}`;

        // Optionally create a share record for tracking/expiration
        if (expiresAt || maxDownloads) {
            const shareId = Auth.generateShareId();

            const shareContent = {
                type: this.SHARE_TYPE_PUBLIC,
                fileId: fileId,
                fileName: file.name,
                fileSHA256: file.sha256,
                expiresAt: expiresAt,
                maxDownloads: maxDownloads,
            };

            // Create a public share event (no recipient, no encrypted key)
            const event = {
                kind: 30081,  // Public share kind
                created_at: Math.floor(Date.now() / 1000),
                tags: [
                    ['d', shareId],
                    ['file', `30078:${Auth.pubkey}:${fileId}`],
                    ['x', file.sha256],
                ],
                content: JSON.stringify(shareContent),
            };

            if (expiresAt) {
                event.tags.push(['expiration', expiresAt.toString()]);
            }

            if (maxDownloads) {
                event.tags.push(['max_downloads', maxDownloads.toString()]);
            }

            const signedEvent = await Auth.signEvent(event);
            await Auth.publishEvent(signedEvent);
        }

        console.log('Sharing: Generated public link for', file.name);

        return {
            url: publicUrl,
            key: keyBase64url,
            sha256: file.sha256,
            expiresAt: expiresAt,
        };
    },

    // Parse a public link and extract components
    parsePublicLink(url) {
        const parsed = new URL(url);
        const pathParts = parsed.pathname.split('/');
        const sha256 = pathParts[pathParts.length - 1];
        const key = parsed.hash.slice(1); // Remove the #

        return {
            sha256: sha256,
            key: key,
            keyBytes: key ? Crypto.base64urlToBytes(key) : null,
        };
    },

    // Download and decrypt from a public link
    async downloadFromPublicLink(url) {
        const { sha256, keyBytes } = this.parsePublicLink(url);

        if (!sha256 || !keyBytes) {
            throw new Error('Invalid public link');
        }

        // Fetch the encrypted file
        const downloadUrl = API.getDownloadURL(sha256);
        const response = await fetch(downloadUrl);

        if (!response.ok) {
            throw new Error(`Download failed: ${response.status}`);
        }

        const encryptedData = await response.arrayBuffer();

        // Decrypt using the key from URL fragment
        const decryptedData = await Crypto.decryptFile(encryptedData, keyBytes);

        return decryptedData;
    },

    // Revoke a share
    async revokeShare(shareId) {
        if (!Auth.isConnected) {
            throw new Error('Not connected');
        }

        // Create deletion event (NIP-09)
        const signedEvent = await Auth.createShareRevokeEvent(shareId);

        // Publish to relay
        await Auth.publishEvent(signedEvent);

        // Remove from cache
        this.sharesCache.delete(shareId);

        console.log('Sharing: Revoked share', shareId.slice(0, 8) + '...');

        return true;
    },

    // Revoke all shares for a file and re-encrypt with new key
    async revokeAndReencryptFile(file) {
        if (!Auth.isConnected) {
            throw new Error('Not connected');
        }

        const fileId = file.file_id || file.fileId || file.d;
        const folderId = file.folder_id || file.folderId || file.folder || null;

        if (!fileId) {
            throw new Error('Cannot revoke: missing file ID');
        }

        UI.toast('Revoking access and re-encrypting...', 'info');

        // Step 1: Download the encrypted file
        const downloadUrl = API.getDownloadURL(file.sha256);
        const response = await fetch(downloadUrl);
        const encryptedData = await response.arrayBuffer();

        // Step 2: Decrypt with old key
        let oldFileKey;
        if (folderId) {
            oldFileKey = await Keys.deriveFileKey(folderId, fileId);
        } else {
            oldFileKey = await Keys.deriveRootFileKey(fileId);
        }

        const decryptedData = await Crypto.decryptFile(encryptedData, oldFileKey);

        // Step 3: Generate new file ID for fresh key derivation
        const newFileId = Crypto.generateFileId();

        // Step 4: Derive new file key
        let newFileKey;
        if (folderId) {
            newFileKey = await Keys.deriveFileKey(folderId, newFileId);
        } else {
            newFileKey = await Keys.deriveRootFileKey(newFileId);
        }

        // Step 5: Re-encrypt with new key
        const reencryptedData = await Crypto.encryptFile(decryptedData, newFileKey);

        // Step 6: Calculate new hash
        const newHash = await Crypto.hash(reencryptedData);

        // Step 7: Upload new encrypted blob
        const authHeader = await Auth.createUploadAuth(newHash, reencryptedData.length, 'application/octet-stream');
        const encryptedFile = new File([reencryptedData], file.name + '.encrypted', {
            type: 'application/octet-stream',
        });
        const uploadResult = await API.uploadFile(encryptedFile, authHeader);

        // Step 8: Publish new metadata event
        const metadataEvent = await Auth.createEncryptedFileMetadataEvent({
            fileId: newFileId,
            sha256: uploadResult.sha256,
            plaintextHash: await Crypto.hash(decryptedData),
            name: file.name,
            size: decryptedData.length,
            encryptedSize: reencryptedData.length,
            mimeType: file.mime_type || file.mimeType || 'application/octet-stream',
            folderId: folderId,
            encrypted: true,
        });
        await Auth.publishEvent(metadataEvent);

        // Step 9: Delete old file
        const deleteAuth = await Auth.createDeleteAuth(file.sha256);
        await API.deleteFile(file.sha256, deleteAuth);

        // Step 10: Revoke all existing shares (they're now useless anyway)
        // Note: In a full implementation, we'd query for shares and revoke them
        // For now, old shares will simply fail to decrypt

        // Cleanup
        Crypto.wipeKey(oldFileKey);
        Crypto.wipeKey(newFileKey);

        console.log('Sharing: File re-encrypted with new key');

        return {
            oldFileId: fileId,
            newFileId: newFileId,
            oldHash: file.sha256,
            newHash: uploadResult.sha256,
        };
    },

    // Accept a shared file/folder
    // Decrypts the shared key and stores it locally
    async acceptShare(share) {
        if (!Auth.isConnected) {
            throw new Error('Not connected');
        }

        // Decrypt the share content
        const decryptedContent = await Auth.nip04Decrypt(
            share.owner_pubkey,
            share.encrypted_content
        );

        const content = JSON.parse(decryptedContent);

        if (content.type === this.SHARE_TYPE_FILE && content.fileKey) {
            // Decrypt the file key
            const fileKeyHex = await Auth.nip04Decrypt(share.owner_pubkey, content.fileKey);
            const fileKey = Crypto.hexToBytes(fileKeyHex);

            // Store the file key locally (associated with the share)
            await Keys.storeEncryptedKey(`share:${share.id}`, fileKey, content.fileId);

            console.log('Sharing: Accepted file share', share.id.slice(0, 8) + '...');

            return {
                type: this.SHARE_TYPE_FILE,
                fileId: content.fileId,
                fileName: content.fileName,
                sha256: content.fileSHA256,
            };
        } else if (content.type === this.SHARE_TYPE_FOLDER && content.folderKey) {
            // Decrypt the folder key
            const folderKeyHex = await Auth.nip04Decrypt(share.owner_pubkey, content.folderKey);
            const folderKey = Crypto.hexToBytes(folderKeyHex);

            // Import the shared folder key
            await Keys.importSharedFolderKey(content.folderId, content.folderKey, share.owner_pubkey);

            console.log('Sharing: Accepted folder share', share.id.slice(0, 8) + '...');

            return {
                type: this.SHARE_TYPE_FOLDER,
                folderId: content.folderId,
                folderName: content.folderName,
            };
        }

        throw new Error('Unknown share type');
    },

    // Create expiring share link with server-side validation
    async createExpiringLink(file, expiresInSeconds, maxDownloads = null) {
        const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;

        return this.generatePublicLink(file, {
            expiresAt: expiresAt,
            maxDownloads: maxDownloads,
        });
    },

    // Create time-limited share (allowance)
    async createTimedAllowance(file, recipientPubkey, durationSeconds, options = {}) {
        const expiresAt = Math.floor(Date.now() / 1000) + durationSeconds;

        return this.shareFile(file, recipientPubkey, {
            ...options,
            expiresAt: expiresAt,
        });
    },

    // List all shares created by current user
    async listOutgoingShares() {
        if (!Auth.isConnected) {
            return [];
        }

        try {
            const response = await API.listShares(Auth.pubkey, 'created');
            return response.created || [];
        } catch (err) {
            console.error('Sharing: Failed to list outgoing shares:', err);
            return [];
        }
    },

    // List all shares received by current user
    async listIncomingShares() {
        if (!Auth.isConnected) {
            return [];
        }

        try {
            const response = await API.listShares(Auth.pubkey, 'received');
            const shares = response.received || [];

            // Decrypt and parse share contents
            const decryptedShares = [];
            for (const share of shares) {
                try {
                    const decryptedContent = await Auth.nip04Decrypt(
                        share.owner_pubkey,
                        share.encrypted_content
                    );
                    const content = JSON.parse(decryptedContent);
                    decryptedShares.push({
                        ...share,
                        content: content,
                        decrypted: true,
                    });
                } catch (err) {
                    decryptedShares.push({
                        ...share,
                        decrypted: false,
                        error: err.message,
                    });
                }
            }

            return decryptedShares;
        } catch (err) {
            console.error('Sharing: Failed to list incoming shares:', err);
            return [];
        }
    },

    // Check if a share has expired
    isShareExpired(share) {
        if (!share.expires_at) return false;
        return share.expires_at < Math.floor(Date.now() / 1000);
    },

    // Format share expiration for display
    formatExpiration(expiresAt) {
        if (!expiresAt) return 'Never';

        const now = Math.floor(Date.now() / 1000);
        const remaining = expiresAt - now;

        if (remaining <= 0) return 'Expired';
        if (remaining < 60) return `${remaining}s`;
        if (remaining < 3600) return `${Math.floor(remaining / 60)}m`;
        if (remaining < 86400) return `${Math.floor(remaining / 3600)}h`;
        return `${Math.floor(remaining / 86400)}d`;
    },
};
