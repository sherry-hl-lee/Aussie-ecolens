export default function MediaGallery({
  items,
  selectedUrls,
  onToggleSelect,
  onOpenItem,
  loading,
  canSelectItem,
}) {
  if (loading) {
    return (
      <div className="gallery-empty">
        <div className="spinner" style={{ margin: '0 auto 0.75rem' }} aria-hidden="true" />
        Loading results…
      </div>
    );
  }

  if (!items.length) {
    return (
      <div className="gallery-empty">
        <span style={{ fontSize: '2rem' }} aria-hidden="true">
          🔍
        </span>
        <p style={{ margin: '0.5rem 0 0' }}>No media yet. Upload a file or run a query.</p>
      </div>
    );
  }

  return (
    <div className="gallery">
      {items.map((item) => {
        const thumb = item.thumbnailUrl || item.fileUrl;
        const isVideo = item.mediaType === 'video';
        const selected = selectedUrls.has(item.fileUrl);
        const tags = item.tags || [];
        const selectable = canSelectItem ? canSelectItem(item) : true;

        return (
          <article
            key={item.fileUrl || item.checksum}
            className={`gallery-card${selected ? ' selected' : ''}${selectable ? '' : ' gallery-card--readonly'}`}
          >
            {selectable ? (
              <label className="gallery-select">
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={() => onToggleSelect(item.fileUrl)}
                />
                <span>{selected ? 'Selected' : 'Select'}</span>
              </label>
            ) : (
              <div className="gallery-select gallery-select--readonly">
                <span>View only</span>
              </div>
            )}
            <button type="button" className="gallery-thumb-btn" onClick={() => onOpenItem(item)}>
              {thumb && !isVideo ? (
                <img src={thumb} alt={item.filename || 'Wildlife thumbnail'} loading="lazy" />
              ) : (
                <div className="gallery-video-placeholder">{isVideo ? '▶ Video' : 'No preview'}</div>
              )}
              <div className="gallery-thumb-hover-tags" aria-hidden="true">
                {tags.length ? (
                  tags.map((tag) => (
                    <span key={tag} className="gallery-hover-tag">
                      {tag}
                    </span>
                  ))
                ) : (
                  <span className="gallery-hover-tag">untagged</span>
                )}
              </div>
            </button>
            <div className="gallery-meta">
              <div className="tag-pills">
                {tags.length
                  ? tags.slice(0, 4).map((tag) => (
                      <span key={tag} className="tag-pill">
                        {tag}
                      </span>
                    ))
                  : (
                    <span className="tag-pill">untagged</span>
                  )}
              </div>
              <small>{item.mediaType}</small>
            </div>
          </article>
        );
      })}
    </div>
  );
}
