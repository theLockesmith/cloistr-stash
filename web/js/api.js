// API client for communicating with the Drive backend

const API = {
    baseURL: '',

    // Upload a file to the server with Blossom auth
    async uploadFile(file, authHeader) {
        const formData = new FormData();
        formData.append('file', file);

        const headers = {};
        if (authHeader) {
            headers['X-Blossom-Auth'] = authHeader;
        }

        const response = await fetch(`${this.baseURL}/api/files`, {
            method: 'POST',
            headers: headers,
            body: formData,
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(error || `Upload failed: ${response.status}`);
        }

        return response.json();
    },

    // List all files for a pubkey
    async listFiles(pubkey) {
        const url = pubkey
            ? `${this.baseURL}/api/files?pubkey=${pubkey}`
            : `${this.baseURL}/api/files`;

        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(`Failed to list files: ${response.status}`);
        }

        return response.json();
    },

    // Publish file metadata event to relay
    async publishMetadata(signedEvent) {
        const response = await fetch(`${this.baseURL}/api/metadata`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(signedEvent),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(error || `Failed to publish metadata: ${response.status}`);
        }

        return response.json();
    },

    // Get file metadata by ID
    async getFile(id) {
        const response = await fetch(`${this.baseURL}/api/files/${id}`);

        if (!response.ok) {
            throw new Error(`Failed to get file: ${response.status}`);
        }

        return response.json();
    },

    // Delete a file with Blossom auth
    async deleteFile(sha256, authHeader) {
        const headers = {};
        if (authHeader) {
            headers['X-Blossom-Auth'] = authHeader;
        }

        const response = await fetch(`${this.baseURL}/api/files/${sha256}`, {
            method: 'DELETE',
            headers: headers,
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(error || `Failed to delete file: ${response.status}`);
        }

        return response.json();
    },

    // Get download URL for a file
    getDownloadURL(sha256) {
        return `${this.baseURL}/api/files/${sha256}/download`;
    },

    // Check server health
    async health() {
        const response = await fetch(`${this.baseURL}/health`);
        return response.ok;
    },

    // Check authentication and authorization status
    async checkAuthStatus(authHeader) {
        const headers = {};
        if (authHeader) {
            headers['Authorization'] = authHeader;
        }

        const response = await fetch(`${this.baseURL}/api/auth/status`, {
            headers: headers,
        });

        if (!response.ok) {
            throw new Error(`Failed to check auth status: ${response.status}`);
        }

        return response.json();
    },

    // List all folders for a pubkey
    async listFolders(pubkey, parentId = null) {
        let url = `${this.baseURL}/api/folders?pubkey=${pubkey}`;
        if (parentId !== null) {
            url += `&parent=${parentId}`;
        }

        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(`Failed to list folders: ${response.status}`);
        }

        return response.json();
    },

    // Create a folder by publishing a signed folder event
    async createFolder(signedEvent) {
        const response = await fetch(`${this.baseURL}/api/folders`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(signedEvent),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(error || `Failed to create folder: ${response.status}`);
        }

        return response.json();
    },

    // Get folder by ID
    async getFolder(id, pubkey) {
        const response = await fetch(`${this.baseURL}/api/folders/${id}?pubkey=${pubkey}`);

        if (!response.ok) {
            throw new Error(`Failed to get folder: ${response.status}`);
        }

        return response.json();
    },

    // Delete a folder by publishing a signed deletion event
    async deleteFolder(id, signedEvent) {
        const response = await fetch(`${this.baseURL}/api/folders/${id}`, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(signedEvent),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(error || `Failed to delete folder: ${response.status}`);
        }

        return response.json();
    },

    // List files in a specific folder (or root if folderId is empty)
    async listFilesInFolder(pubkey, folderId = '') {
        const url = `${this.baseURL}/api/files?pubkey=${pubkey}&folder=${folderId}`;

        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(`Failed to list files: ${response.status}`);
        }

        return response.json();
    },
};
