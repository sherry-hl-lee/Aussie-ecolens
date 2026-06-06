export default function ImageModal({ title, imageUrl, fileUrl, mediaType, onClose }) {
  if (!imageUrl && !fileUrl) return null;
  const isVideo = mediaType === 'video';

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
          {isVideo && fileUrl ? (
            <video src={fileUrl} controls className="modal-video" playsInline>
              <track kind="captions" />
            </video>
          ) : null}
          {!isVideo && imageUrl ? (
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
