export default function ConfirmModal({
  title = 'Friendly Reminder',
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  busy = false,
  onConfirm,
  onCancel,
}) {
  if (!message) return null;

  return (
    <div
      className="modal-backdrop"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
      aria-describedby="confirm-modal-message"
      onClick={onCancel}
    >
      <div className="modal-panel confirm-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h3 id="confirm-modal-title">{title}</h3>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="Close">
            ×
          </button>
        </header>
        <div className="modal-body">
          <p id="confirm-modal-message" className="confirm-modal-message">
            {message}
          </p>
          <div className="row-actions confirm-modal-actions">
            <button type="button" className="btn-secondary" disabled={busy} onClick={onCancel}>
              {cancelLabel}
            </button>
            <button type="button" className="btn-danger" disabled={busy} onClick={onConfirm}>
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
