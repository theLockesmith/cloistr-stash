// Encrypted search box. Queries the local encrypted index (search.ts) as you
// type; results render in FileBrowser when searchResults != null.

import { useState } from 'react'
import { useStash } from '../state/useStash'

export function SearchBar() {
  const { runSearch, clearSearch, searchResults } = useStash()
  const [q, setQ] = useState('')

  return (
    <div className="search-bar">
      <input
        type="search"
        className="search-input"
        placeholder="Search files…"
        value={q}
        aria-label="Search files"
        onChange={(e) => {
          setQ(e.target.value)
          void runSearch(e.target.value)
        }}
      />
      {searchResults !== null && (
        <button
          type="button"
          className="search-clear"
          aria-label="Clear search"
          onClick={() => {
            setQ('')
            clearSearch()
          }}
        >
          ✕
        </button>
      )}
    </div>
  )
}
