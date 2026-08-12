// Activity log modal – ported from the legacy activity log section of app.js.
//
// Legacy behaviour reproduced:
//   • Read-only view of localStorage log (key: 'cloistr-activity-log').
//   • Filter by type via #activity-filter select.
//   • "Clear History" wipes the log after window.confirm().
//   • List renders most-recent first with icon + text + relative timestamp.
//
// DOM structure intentionally matches the Playwright spec
// (tests/e2e/modals-features.spec.js):
//   #activity-modal   → always attached, class includes "hidden" when closed
//   .modal-header h2  → text "Activity Log"
//   #activity-modal-close → close button
//   #activity-filter  → type filter select
//   #clear-activity   → clear history button
//   #activity-list    → rendered entries

import { useState, useCallback } from 'react'
import {
  type ActivityType,
  getActivityEntries,
  clearActivity,
  getActivityIcon,
  formatActivityText,
  formatActivityTime,
} from '../lib/activity'

type FilterValue = ActivityType | 'all'

interface Props {
  isOpen: boolean
  onClose: () => void
}

export function ActivityModal({ isOpen, onClose }: Props) {
  const [filter, setFilter] = useState<FilterValue>('all')
  // Re-derive entries every render when open so the list reflects fresh state.
  const entries = isOpen ? getActivityEntries(filter) : []

  const handleFilterChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setFilter(e.target.value as FilterValue)
  }, [])

  const handleClear = useCallback(() => {
    if (window.confirm('Clear all activity history? This cannot be undone.')) {
      clearActivity()
      // Force a re-render by toggling filter back to its current value.
      setFilter((f) => f)
    }
  }, [])

  // Always rendered so #activity-modal is always attached to the DOM.
  // Playwright spec: toBeAttached() + toHaveClass(/hidden/).
  return (
    <div id="activity-modal" className={`modal${isOpen ? '' : ' hidden'}`}>
      <div className="modal-content">
        <div className="modal-header">
          <h2>Activity Log</h2>
          <button
            type="button"
            className="modal-close"
            id="activity-modal-close"
            onClick={onClose}
            aria-label="Close activity log"
          >
            &times;
          </button>
        </div>

        <div className="modal-body">
          <div className="activity-filters">
            <select
              id="activity-filter"
              className="input"
              value={filter}
              onChange={handleFilterChange}
              aria-label="Filter activity by type"
            >
              <option value="all">All Activity</option>
              <option value="upload">Uploads</option>
              <option value="download">Downloads</option>
              <option value="delete">Deletions</option>
              <option value="move">Moves</option>
              <option value="share">Shares</option>
              <option value="comment">Comments</option>
            </select>
            <button
              type="button"
              className="btn"
              id="clear-activity"
              onClick={handleClear}
            >
              Clear History
            </button>
          </div>

          <div className="activity-list" id="activity-list">
            {entries.length === 0 ? (
              <div className="no-activity">No activity recorded</div>
            ) : (
              entries.map((entry) => (
                <div key={entry.id} className="activity-item" data-id={entry.id}>
                  <div className="activity-icon" aria-hidden="true">
                    {getActivityIcon(entry.type)}
                  </div>
                  <div className="activity-details">
                    <div className="activity-text">{formatActivityText(entry)}</div>
                    <div className="activity-time">{formatActivityTime(entry.timestamp)}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
