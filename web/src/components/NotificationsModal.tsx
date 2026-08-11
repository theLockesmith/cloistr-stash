// Notifications modal (ported from app.js showNotificationsModal /
// renderNotifications / acceptShare / declineShare).
//
// Rendered as a persistent DOM element with a `hidden` class when closed,
// matching the legacy markup structure the E2E specs assert against:
//   #notifications-modal.modal.hidden  (closed)
//   #notifications-modal.modal         (open)
//
// The modal is always in the DOM so toBeAttached() passes in tests.

import { useStash } from '../state/useStash'
import type { StashNotification } from '../state/types'

const ICONS: Record<string, string> = {
  share_received: '👤',
  share_folder: '📁',
}

const TITLES: Record<string, string> = {
  share_received: 'File Shared',
  share_folder: 'Folder Shared',
}

function getNotificationText(n: StashNotification): string {
  const { from, name } = n.data
  if (n.type === 'share_folder') return `${from} shared folder "${name}" with you`
  if (n.type === 'share_received') return `${from} shared "${name}" with you`
  return 'New notification'
}

function formatTimeAgo(timestamp: number): string {
  const diffSec = Math.floor((Date.now() - timestamp) / 1000)
  if (diffSec < 60) return 'just now'
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} minutes ago`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} hours ago`
  if (diffSec < 604800) return `${Math.floor(diffSec / 86400)} days ago`
  return new Date(timestamp).toLocaleDateString()
}

export function NotificationsModal({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const {
    notifications,
    markNotificationRead,
    markAllNotificationsRead,
    acceptNotification,
    declineNotification,
  } = useStash()

  const handleItemClick = (id: string) => {
    markNotificationRead(id)
  }

  const handleAccept = (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    acceptNotification(id)
  }

  const handleDecline = (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    declineNotification(id)
  }

  return (
    <div
      id="notifications-modal"
      className={`modal${open ? '' : ' hidden'}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal-content">
        <div className="modal-header">
          <h2>Notifications</h2>
          <button
            type="button"
            className="modal-close"
            id="notifications-modal-close"
            aria-label="Close"
            onClick={onClose}
          >
            &times;
          </button>
        </div>

        <div className="modal-body">
          <div className="notifications-list" id="notifications-list">
            {notifications.length === 0 ? (
              <div className="no-notifications">No notifications</div>
            ) : (
              notifications.map((n) => (
                <div
                  key={n.id}
                  className={`notification-item${n.read ? '' : ' unread'}`}
                  data-id={n.id}
                  onClick={() => handleItemClick(n.id)}
                >
                  <div className="notification-icon">
                    {ICONS[n.type] ?? '🔔'}
                  </div>
                  <div className="notification-content">
                    <div className="notification-title">
                      {TITLES[n.type] ?? 'Notification'}
                    </div>
                    <div className="notification-description">
                      {getNotificationText(n)}
                    </div>
                    <div className="notification-time">
                      {formatTimeAgo(n.timestamp)}
                    </div>
                    {(n.type === 'share_received' || n.type === 'share_folder') &&
                      !n.accepted &&
                      !n.declined && (
                        <div className="notification-actions">
                          <button
                            type="button"
                            className="btn btn-primary accept-share-btn"
                            data-id={n.id}
                            onClick={(e) => handleAccept(e, n.id)}
                          >
                            Accept
                          </button>
                          <button
                            type="button"
                            className="btn decline-share-btn"
                            data-id={n.id}
                            onClick={(e) => handleDecline(e, n.id)}
                          >
                            Decline
                          </button>
                        </div>
                      )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="modal-footer">
          <button
            type="button"
            className="btn"
            id="mark-all-read"
            onClick={markAllNotificationsRead}
          >
            Mark All Read
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
