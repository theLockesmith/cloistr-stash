// What the embed shows. Pure: every state comes in as props, so each one can
// be rendered and checked without a browser (EmbedView.test.ts).

import type { StashFile, StashFolder } from '@cloistr/stash-core/types'
import type { EmbedMode, ParentCheck } from './protocol'
import { formatFileSize } from '../components/format'

export type EmbedState =
  | { kind: 'refused'; reason: Extract<ParentCheck, { ok: false }>['reason'] }
  | { kind: 'connecting' }
  | { kind: 'signed-out' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | {
      kind: 'list'
      path: { id: string; name: string }[]
      folders: StashFolder[]
      files: StashFile[]
      unreadable: number
    }

export interface EmbedViewProps {
  state: EmbedState
  mode: EmbedMode
  appUrl: string
  selected: ReadonlySet<string>
  onOpenFolder: (id: string) => void
  onToggleFile: (sha256: string) => void
  onChoose: () => void
  onCancel: () => void
  onRetry: () => void
}

const REFUSALS: Record<Extract<EmbedState, { kind: 'refused' }>['reason'], string> = {
  'not-framed': 'This page is the Stash file picker for other Cloistr apps. Open Stash to see your files.',
  'no-parent': 'This file picker was opened without saying which app it is for, so it shows nothing.',
  'parent-not-allowed': 'This file picker only works inside Cloistr apps it trusts, so it shows nothing here.',
  'parent-mismatch': 'This file picker only works inside Cloistr apps it trusts, so it shows nothing here.',
}

export function EmbedView(props: EmbedViewProps) {
  const { state, mode, appUrl } = props
  const openStash = (
    <a className="stash-embed__open" href={appUrl} target="_blank" rel="noopener noreferrer">
      Open Stash
    </a>
  )

  if (state.kind === 'refused') {
    return (
      <div className="stash-embed stash-embed--notice" role="status">
        <p>{REFUSALS[state.reason]}</p>
        {openStash}
      </div>
    )
  }
  if (state.kind === 'connecting' || state.kind === 'loading') {
    return (
      <div className="stash-embed stash-embed--notice" role="status" aria-live="polite">
        <p>{state.kind === 'connecting' ? 'Connecting to your account…' : 'Loading your files…'}</p>
      </div>
    )
  }
  if (state.kind === 'signed-out') {
    return (
      <div className="stash-embed stash-embed--notice" role="status">
        <p>Sign in to Stash to see your files here.</p>
        <a className="stash-embed__open" href={appUrl} target="_blank" rel="noopener noreferrer">
          Sign in to Stash
        </a>
        <button type="button" className="stash-embed__button" onClick={props.onRetry}>
          I have signed in
        </button>
      </div>
    )
  }
  if (state.kind === 'error') {
    return (
      <div className="stash-embed stash-embed--notice" role="alert">
        <p>Your files could not be loaded: {state.message}</p>
        <button type="button" className="stash-embed__button" onClick={props.onRetry}>
          Try again
        </button>
        {openStash}
      </div>
    )
  }

  const empty = state.folders.length === 0 && state.files.length === 0
  return (
    <div className="stash-embed">
      <div className="stash-embed__bar">
        <nav className="stash-embed__path" aria-label="Folder path">
          <button type="button" onClick={() => props.onOpenFolder('')}>
            My Files
          </button>
          {state.path.map((p) => (
            <span key={p.id}>
              {' / '}
              <button type="button" onClick={() => props.onOpenFolder(p.id)}>
                {p.name}
              </button>
            </span>
          ))}
        </nav>
        {openStash}
      </div>

      {state.unreadable > 0 && (
        <p className="stash-embed__warn" role="status">
          {state.unreadable === 1 ? '1 item' : `${state.unreadable} items`} could not be opened here. Open Stash to see
          {state.unreadable === 1 ? ' it' : ' them'}.
        </p>
      )}

      {empty ? (
        <p className="stash-embed__empty">This folder is empty.</p>
      ) : (
        <ul className="stash-embed__list">
          {state.folders.map((f) => (
            <li key={`d:${f.id}`}>
              <button type="button" className="stash-embed__row" onClick={() => props.onOpenFolder(f.id)}>
                <span aria-hidden="true">📁</span> {f.name}
              </button>
            </li>
          ))}
          {state.files.map((f) =>
            mode === 'pick' ? (
              <li key={`f:${f.sha256}`}>
                <label className="stash-embed__row">
                  <input
                    type="checkbox"
                    checked={props.selected.has(f.sha256)}
                    onChange={() => props.onToggleFile(f.sha256)}
                  />{' '}
                  {f.name}
                  {typeof f.size === 'number' && <span className="stash-embed__size">{formatFileSize(f.size)}</span>}
                </label>
              </li>
            ) : (
              <li key={`f:${f.sha256}`} className="stash-embed__row">
                <span aria-hidden="true">📄</span> {f.name}
                {typeof f.size === 'number' && <span className="stash-embed__size">{formatFileSize(f.size)}</span>}
              </li>
            ),
          )}
        </ul>
      )}

      {mode === 'pick' && (
        <div className="stash-embed__actions">
          <button type="button" className="stash-embed__button" onClick={props.onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="stash-embed__button stash-embed__button--primary"
            disabled={props.selected.size === 0}
            onClick={props.onChoose}
          >
            {props.selected.size === 0 ? 'Choose' : `Choose ${props.selected.size}`}
          </button>
        </div>
      )}
    </div>
  )
}
