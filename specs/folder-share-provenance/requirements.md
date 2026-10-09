# Folder share provenance: requirements

Found 2026-10-09. Accepting a folder share overwrote whatever key the browser
held for that folder id, including the user's own. Uploads into that folder
then wrapped new file keys under the attacker's key in public 'wk' tags.

- R1 An incoming folder share never replaces a key the user owns, or a key
  that came from a different sharer, on ANY key store (IndexedDB included).
- R2 A share from the original sharer (including a rotation after revoke)
  is still accepted.
- R3 One implementation: browser and headless both go through
  Keys.importSharedFolderKey.
- R4 A browser already poisoned repairs itself on load: own folder keys are
  checked against the self-encrypted 'key' tag on the relay and replaced if
  they differ.
- R5 Every path that uses an own folder key (upload wrap, folder share,
  wrapped-key migration) takes it from the relay copy, not the local store.
- R6 Live control with two throwaway keys: poison on the pre-fix build,
  deploy, show self-repair and correct wrapping.
