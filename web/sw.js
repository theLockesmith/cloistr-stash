// Service Worker for Cloistr Drive - Offline Support
// Caches app shell and provides offline functionality

const CACHE_VERSION = 'v34';
const CACHE_NAME = `cloistr-drive-${CACHE_VERSION}`;

// App shell files to cache
const APP_SHELL = [
    '/',
    '/index.html',
    '/css/style.css',
    '/js/api.js',
    '/js/relay.js',
    '/js/relayprefs.js',
    '/js/auth.js',
    '/js/nip46.js',
    '/js/crypto.js',
    '/js/keys.js',
    '/js/sharing.js',
    '/js/versioning.js',
    '/js/collaboration.js',
    '/js/search.js',
    '/js/upload.js',
    '/js/ui.js',
    '/js/app.js',
    '/vendor/libsodium.js',
    '/vendor/libsodium-wrappers.js',
    '/vendor/sodium.js',
];

// CDN resources to cache
const CDN_RESOURCES = [
    'https://cdn.jsdelivr.net/npm/libsodium-wrappers@0.7.13/dist/sodium.js',
    'https://cdn.jsdelivr.net/npm/yjs@13.6.10/dist/yjs.min.js',
    'https://cdn.jsdelivr.net/npm/y-protocols@1.0.6/dist/y-protocols.min.js',
];

// Install event - cache app shell
self.addEventListener('install', (event) => {
    console.log('[SW] Installing service worker...');

    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('[SW] Caching app shell');
                // Cache app shell files
                return Promise.all([
                    cache.addAll(APP_SHELL).catch(err => {
                        console.warn('[SW] Some app shell files failed to cache:', err);
                    }),
                    // Try to cache CDN resources (may fail due to CORS)
                    ...CDN_RESOURCES.map(url =>
                        cache.add(url).catch(() => {
                            console.log('[SW] Could not cache CDN resource:', url);
                        })
                    ),
                ]);
            })
            .then(() => {
                console.log('[SW] App shell cached');
                return self.skipWaiting();
            })
    );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
    console.log('[SW] Activating service worker...');

    event.waitUntil(
        caches.keys()
            .then((cacheNames) => {
                return Promise.all(
                    cacheNames
                        .filter((name) => name.startsWith('cloistr-drive-') && name !== CACHE_NAME)
                        .map((name) => {
                            console.log('[SW] Deleting old cache:', name);
                            return caches.delete(name);
                        })
                );
            })
            .then(() => {
                console.log('[SW] Service worker activated');
                return self.clients.claim();
            })
    );
});

// Fetch event - serve from cache, fallback to network
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Skip non-GET requests
    if (event.request.method !== 'GET') {
        return;
    }

    // Skip API requests (they need fresh data)
    if (url.pathname.startsWith('/api/')) {
        event.respondWith(
            fetch(event.request)
                .catch(() => {
                    // Return offline response for API errors
                    return new Response(JSON.stringify({
                        error: 'offline',
                        message: 'You are offline. Please check your connection.',
                    }), {
                        status: 503,
                        headers: { 'Content-Type': 'application/json' },
                    });
                })
        );
        return;
    }

    // Skip WebSocket connections
    if (url.protocol === 'wss:' || url.protocol === 'ws:') {
        return;
    }

    // Cache-first strategy for app shell and static assets
    event.respondWith(
        caches.match(event.request)
            .then((cachedResponse) => {
                if (cachedResponse) {
                    // Return cached version and update cache in background
                    fetchAndCache(event.request);
                    return cachedResponse;
                }

                // Not in cache, fetch from network
                return fetchAndCache(event.request);
            })
            .catch(() => {
                // If both cache and network fail, return offline page
                if (event.request.mode === 'navigate') {
                    return caches.match('/index.html');
                }
                return new Response('Offline', { status: 503 });
            })
    );
});

// Fetch and cache helper
async function fetchAndCache(request) {
    try {
        const response = await fetch(request);

        // Don't cache error responses
        if (!response.ok) {
            return response;
        }

        // Clone the response before caching
        const responseToCache = response.clone();

        // Cache the response
        const cache = await caches.open(CACHE_NAME);
        cache.put(request, responseToCache);

        return response;
    } catch (err) {
        // Network request failed, try to return from cache
        const cachedResponse = await caches.match(request);
        if (cachedResponse) {
            return cachedResponse;
        }
        throw err;
    }
}

// Background sync for offline uploads
self.addEventListener('sync', (event) => {
    if (event.tag === 'upload-sync') {
        console.log('[SW] Background sync triggered for uploads');
        event.waitUntil(syncUploads());
    }
});

// Sync pending uploads
async function syncUploads() {
    // This would sync pending uploads from IndexedDB
    // Implementation depends on how offline uploads are queued
    console.log('[SW] Syncing uploads...');
}

// Handle push notifications (for share notifications)
self.addEventListener('push', (event) => {
    if (!event.data) return;

    try {
        const data = event.data.json();

        const options = {
            body: data.body || 'New notification',
            icon: '/icon-192.png',
            badge: '/badge-72.png',
            data: data.url || '/',
            actions: [
                { action: 'open', title: 'Open' },
                { action: 'dismiss', title: 'Dismiss' },
            ],
        };

        event.waitUntil(
            self.registration.showNotification(data.title || 'Cloistr Drive', options)
        );
    } catch (err) {
        console.error('[SW] Push notification error:', err);
    }
});

// Handle notification clicks
self.addEventListener('notificationclick', (event) => {
    event.notification.close();

    if (event.action === 'dismiss') {
        return;
    }

    const url = event.notification.data || '/';

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true })
            .then((windowClients) => {
                // Focus existing window if available
                for (const client of windowClients) {
                    if (client.url === url && 'focus' in client) {
                        return client.focus();
                    }
                }
                // Open new window
                if (clients.openWindow) {
                    return clients.openWindow(url);
                }
            })
    );
});

// Message handler for communication with main app
self.addEventListener('message', (event) => {
    if (event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }

    if (event.data.type === 'GET_VERSION') {
        event.ports[0].postMessage({ version: CACHE_VERSION });
    }

    if (event.data.type === 'CLEAR_CACHE') {
        caches.delete(CACHE_NAME).then(() => {
            event.ports[0].postMessage({ cleared: true });
        });
    }
});

console.log('[SW] Service worker loaded');
