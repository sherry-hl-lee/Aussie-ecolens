export default function ImageModal({ title, imageUrl, fileUrl, onClose }) {
  if (!imageUrl && !fileUrl) return null;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h3>{title || 'Full size'}</h3>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="modal-body">
          {imageUrl ? (
            <img src={imageUrl} alt={title || 'Full size preview'} className="modal-image" />
          ) : null}
          {fileUrl ? (
            <p className="modal-link">
              <a href={fileUrl} target="_blank" rel="noreferrer">
                Open original file
              </a>
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
