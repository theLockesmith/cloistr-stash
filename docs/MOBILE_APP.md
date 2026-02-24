# Cloistr Drive Mobile App

## Overview

Native mobile application for Cloistr Drive built with **Flutter**. Provides secure file access, camera upload, and seamless sync across iOS and Android.

## Why Flutter?

| Aspect | Flutter | React Native | Native |
|--------|---------|--------------|--------|
| Performance | Compiled (fast) | JS bridge (slower) | Best |
| Crypto | Good (native FFI) | Bridge overhead | Best |
| Codebase | Single | Single | Two |
| Dev speed | Fast | Fast | Slow |
| App size | ~15 MB | ~25 MB | ~5 MB |

**Decision:** Flutter provides the best balance of performance (critical for encryption), development speed, and maintainability.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Flutter Mobile App                        │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │                      UI Layer                           │ │
│  │                                                         │ │
│  │   • Material Design 3                                  │ │
│  │   • File browser                                       │ │
│  │   • Camera/scanner UI                                  │ │
│  │   • Settings                                           │ │
│  └──────────────────────┬──────────────────────────────────┘ │
│                         │                                    │
│  ┌──────────────────────▼──────────────────────────────────┐ │
│  │                   State Management                       │ │
│  │                      (Riverpod)                          │ │
│  └──────────────────────┬──────────────────────────────────┘ │
│                         │                                    │
│  ┌──────────────────────▼──────────────────────────────────┐ │
│  │                   Service Layer                          │ │
│  │                                                          │ │
│  │   • AuthService (Nostr keys, biometric)                 │ │
│  │   • CryptoService (XChaCha20, HKDF)                     │ │
│  │   • SyncService (upload/download queue)                 │ │
│  │   • CameraService (auto-upload)                         │ │
│  │   • StorageService (local file cache)                   │ │
│  └──────────────────────┬──────────────────────────────────┘ │
│                         │                                    │
│  ┌──────────────────────▼──────────────────────────────────┐ │
│  │                   Platform Layer                         │ │
│  │                                                          │ │
│  │   • Native crypto (libsodium via FFI)                   │ │
│  │   • Secure storage (Keychain/Keystore)                  │ │
│  │   • Background tasks (WorkManager/BGTaskScheduler)      │ │
│  │   • Share extension                                      │ │
│  │   • File provider (Files app integration)               │ │
│  └──────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Project Structure

```
cloistr-drive-mobile/
├── android/
│   ├── app/
│   │   └── src/main/
│   │       ├── kotlin/.../
│   │       │   ├── MainActivity.kt
│   │       │   └── ShareExtensionActivity.kt
│   │       └── AndroidManifest.xml
│   └── build.gradle
├── ios/
│   ├── Runner/
│   │   ├── AppDelegate.swift
│   │   └── Info.plist
│   ├── ShareExtension/           # Share from other apps
│   └── FileProvider/             # Files app integration
├── lib/
│   ├── main.dart
│   ├── app.dart
│   ├── core/
│   │   ├── crypto/
│   │   │   ├── crypto_service.dart
│   │   │   ├── xchacha20.dart
│   │   │   └── hkdf.dart
│   │   ├── auth/
│   │   │   ├── auth_service.dart
│   │   │   ├── nostr_keys.dart
│   │   │   └── biometric_service.dart
│   │   ├── sync/
│   │   │   ├── sync_service.dart
│   │   │   ├── upload_queue.dart
│   │   │   └── download_manager.dart
│   │   ├── storage/
│   │   │   ├── local_storage.dart
│   │   │   ├── secure_storage.dart
│   │   │   └── file_cache.dart
│   │   └── api/
│   │       ├── api_client.dart
│   │       └── blossom_client.dart
│   ├── features/
│   │   ├── files/
│   │   │   ├── files_screen.dart
│   │   │   ├── file_list.dart
│   │   │   ├── file_preview.dart
│   │   │   └── files_provider.dart
│   │   ├── camera/
│   │   │   ├── camera_screen.dart
│   │   │   ├── scanner_screen.dart
│   │   │   └── auto_upload_service.dart
│   │   ├── settings/
│   │   │   ├── settings_screen.dart
│   │   │   └── settings_provider.dart
│   │   ├── auth/
│   │   │   ├── login_screen.dart
│   │   │   └── nip46_screen.dart
│   │   └── sharing/
│   │       ├── share_screen.dart
│   │       └── public_link_screen.dart
│   ├── widgets/
│   │   ├── file_tile.dart
│   │   ├── folder_tile.dart
│   │   ├── sync_indicator.dart
│   │   └── encryption_badge.dart
│   └── utils/
│       ├── file_utils.dart
│       └── format_utils.dart
├── test/
├── pubspec.yaml
└── README.md
```

## Features

### Phase 1: Core App (Must Have)

#### Authentication
- [ ] NIP-07 deep link login (open signer app)
- [ ] NIP-46 bunker URL login
- [ ] Biometric unlock (Face ID, fingerprint)
- [ ] Secure key storage (Keychain/Keystore)
- [ ] Session persistence

#### File Browser
- [ ] List files and folders
- [ ] Grid and list view toggle
- [ ] Pull-to-refresh
- [ ] Search files
- [ ] Sort and filter
- [ ] File preview (images, videos, PDFs)

#### Encryption
- [ ] XChaCha20-Poly1305 via libsodium FFI
- [ ] HKDF key derivation
- [ ] Chunked encryption for large files
- [ ] Key management (root key, folder keys)

#### Upload/Download
- [ ] Manual file upload
- [ ] Progress indicators
- [ ] Background downloads
- [ ] Offline file access (pin files)
- [ ] Download queue management

### Phase 2: Camera & Sync (Must Have)

#### Camera Upload
- [ ] Auto-upload new photos
- [ ] Configurable (Wi-Fi only, cellular)
- [ ] Upload to specific folder
- [ ] Battery-aware scheduling
- [ ] Duplicate detection

#### Background Sync
- [ ] WorkManager (Android) / BGTaskScheduler (iOS)
- [ ] Periodic sync checks
- [ ] Push notification triggers
- [ ] Bandwidth throttling

#### Share Extension
- [ ] Receive files from other apps
- [ ] Upload shared content
- [ ] Quick folder selection

### Phase 3: Advanced Features (Nice to Have)

#### Document Scanner
- [ ] Camera-based scanning
- [ ] Edge detection
- [ ] Perspective correction
- [ ] PDF generation
- [ ] OCR text extraction

#### Widgets
- [ ] Quick upload widget (iOS/Android)
- [ ] Recent files widget
- [ ] Storage usage widget

#### Files App Integration
- [ ] iOS File Provider
- [ ] Android DocumentsProvider
- [ ] Appear in system file picker

#### Nearby Share
- [ ] Device discovery (mDNS)
- [ ] Direct file transfer (Wi-Fi Direct)
- [ ] End-to-end encrypted transfer

## Dependencies

### pubspec.yaml

```yaml
name: cloistr_drive
description: Zero-knowledge file manager with E2E encryption
version: 1.0.0

environment:
  sdk: '>=3.0.0 <4.0.0'

dependencies:
  flutter:
    sdk: flutter

  # State management
  flutter_riverpod: ^2.4.0
  riverpod_annotation: ^2.3.0

  # Crypto
  sodium_libs: ^2.2.0           # libsodium bindings
  cryptography: ^2.5.0          # Additional crypto primitives

  # Storage
  flutter_secure_storage: ^9.0.0
  sqflite: ^2.3.0               # Local database
  path_provider: ^2.1.0

  # Networking
  dio: ^5.3.0

  # Auth
  local_auth: ^2.1.0            # Biometric

  # Camera
  camera: ^0.10.5
  image_picker: ^1.0.0

  # Background tasks
  workmanager: ^0.5.2           # Android

  # File handling
  file_picker: ^6.0.0
  open_file: ^3.3.0
  share_plus: ^7.2.0

  # UI
  flutter_slidable: ^3.0.0      # Swipe actions
  cached_network_image: ^3.3.0
  shimmer: ^3.0.0               # Loading states

  # Utilities
  intl: ^0.18.0
  collection: ^1.17.0
  uuid: ^4.2.0

dev_dependencies:
  flutter_test:
    sdk: flutter
  flutter_lints: ^3.0.0
  riverpod_generator: ^2.3.0
  build_runner: ^2.4.0
  mockito: ^5.4.0

flutter:
  uses-material-design: true
```

## Crypto Implementation

### libsodium via FFI

```dart
import 'package:sodium_libs/sodium_libs.dart';

class CryptoService {
  late final Sodium sodium;

  Future<void> init() async {
    sodium = await SodiumInit.init();
  }

  /// Encrypt data with XChaCha20-Poly1305
  Uint8List encrypt(Uint8List plaintext, Uint8List key) {
    final nonce = sodium.randombytes.buf(
      sodium.crypto.secretBox.nonceBytes,
    );

    final ciphertext = sodium.crypto.secretBox.easy(
      message: plaintext,
      nonce: nonce,
      key: SecureKey.fromList(sodium, key),
    );

    // Prepend nonce to ciphertext
    return Uint8List.fromList([...nonce, ...ciphertext]);
  }

  /// Decrypt data
  Uint8List decrypt(Uint8List ciphertext, Uint8List key) {
    final nonce = ciphertext.sublist(0, sodium.crypto.secretBox.nonceBytes);
    final encrypted = ciphertext.sublist(sodium.crypto.secretBox.nonceBytes);

    return sodium.crypto.secretBox.openEasy(
      cipherText: encrypted,
      nonce: nonce,
      key: SecureKey.fromList(sodium, key),
    );
  }

  /// HKDF key derivation
  Uint8List deriveKey(Uint8List masterKey, String context, String info) {
    // Use generic hash for HKDF-like derivation
    return sodium.crypto.genericHash.call(
      message: Uint8List.fromList([...masterKey, ...utf8.encode(info)]),
      outLen: 32,
      key: SecureKey.fromList(sodium, utf8.encode(context)),
    );
  }
}
```

## Background Sync (Android)

```dart
import 'package:workmanager/workmanager.dart';

void callbackDispatcher() {
  Workmanager().executeTask((task, inputData) async {
    switch (task) {
      case 'syncFiles':
        await SyncService.instance.syncPendingFiles();
        break;
      case 'autoUploadPhotos':
        await CameraService.instance.uploadNewPhotos();
        break;
    }
    return true;
  });
}

void initBackgroundTasks() {
  Workmanager().initialize(callbackDispatcher);

  // Periodic sync every 15 minutes
  Workmanager().registerPeriodicTask(
    'sync-files',
    'syncFiles',
    frequency: Duration(minutes: 15),
    constraints: Constraints(
      networkType: NetworkType.connected,
      requiresBatteryNotLow: true,
    ),
  );

  // Camera upload check
  Workmanager().registerPeriodicTask(
    'auto-upload',
    'autoUploadPhotos',
    frequency: Duration(minutes: 30),
    constraints: Constraints(
      networkType: NetworkType.unmetered, // Wi-Fi only
      requiresCharging: false,
    ),
  );
}
```

## Share Extension

### Android (ShareExtensionActivity.kt)

```kotlin
class ShareExtensionActivity : FlutterActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (intent?.action == Intent.ACTION_SEND) {
            handleSendIntent(intent)
        }
    }

    private fun handleSendIntent(intent: Intent) {
        val uri = intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
        // Pass to Flutter via method channel
    }
}
```

### iOS (ShareExtension/ShareViewController.swift)

```swift
class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()

        if let item = extensionContext?.inputItems.first as? NSExtensionItem {
            // Handle shared content
            // Open main app with deep link
        }
    }
}
```

## UI Screens

### File Browser

```
┌─────────────────────────────────┐
│ ☰  Cloistr Drive         🔍 ⋮  │
├─────────────────────────────────┤
│ 📁 Documents              >     │
│ 📁 Photos                 >     │
│ 📁 Work                   >     │
├─────────────────────────────────┤
│ 📄 report.pdf        2.4 MB     │
│ 🖼️ photo.jpg          1.2 MB    │
│ 📝 notes.txt          12 KB     │
│                                 │
│         [Empty space]           │
│                                 │
├─────────────────────────────────┤
│  🏠    📁    ➕    ⭐    ⚙️     │
│ Home  Files Upload Star  Settings│
└─────────────────────────────────┘
```

### Camera Upload Settings

```
┌─────────────────────────────────┐
│ ←  Camera Upload                │
├─────────────────────────────────┤
│                                 │
│ Auto-upload photos     [====]   │
│                                 │
│ Upload on                       │
│ ○ Wi-Fi only                    │
│ ● Wi-Fi and cellular            │
│                                 │
│ Upload to folder                │
│ [📁 Camera Uploads         >]   │
│                                 │
│ Include videos         [====]   │
│                                 │
│ Delete after upload    [    ]   │
│                                 │
│ Last upload: 2 minutes ago      │
│ Pending: 3 photos               │
│                                 │
└─────────────────────────────────┘
```

## Build & Distribution

### Development

```bash
# Install Flutter
# https://docs.flutter.dev/get-started/install

# Clone and setup
cd cloistr-drive-mobile
flutter pub get

# Run on device
flutter run

# Run tests
flutter test
```

### Production Build

```bash
# Android
flutter build apk --release
flutter build appbundle --release  # For Play Store

# iOS
flutter build ios --release
# Then archive in Xcode
```

### Distribution

- **Android:** Google Play Store + GitHub Releases (APK)
- **iOS:** App Store
- **Alternative:** F-Droid (Android, source builds)

## Security Considerations

1. **Key storage:** iOS Keychain / Android Keystore (hardware-backed)
2. **Biometric:** Require authentication for key access
3. **Memory:** Clear sensitive data after use
4. **Transport:** Certificate pinning for API calls
5. **Jailbreak/Root:** Detect and warn users
6. **Screenshot:** Disable in sensitive screens
7. **Background:** Clear clipboard on app background

## Platform Requirements

### Android
- Minimum SDK: 24 (Android 7.0)
- Target SDK: 34 (Android 14)
- Permissions:
  - `INTERNET`
  - `READ_EXTERNAL_STORAGE` / `READ_MEDIA_IMAGES`
  - `CAMERA`
  - `FOREGROUND_SERVICE`
  - `RECEIVE_BOOT_COMPLETED`
  - `USE_BIOMETRIC`

### iOS
- Minimum: iOS 14.0
- Capabilities:
  - Background Modes (fetch, processing)
  - Keychain Sharing
  - Associated Domains (deep links)
  - App Groups (share extension)
- Privacy descriptions:
  - Camera
  - Photo Library
  - Face ID

## Timeline

| Phase | Scope |
|-------|-------|
| Phase 1 | Auth, file browser, encryption, basic upload/download |
| Phase 2 | Camera upload, background sync, share extension |
| Phase 3 | Scanner, widgets, Files app integration, nearby share |

## Resources

- [Flutter Documentation](https://docs.flutter.dev/)
- [sodium_libs package](https://pub.dev/packages/sodium_libs)
- [Riverpod](https://riverpod.dev/)
- [WorkManager](https://pub.dev/packages/workmanager)
