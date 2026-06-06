import { useState } from 'react';

export default function UploadSection({ busy, onUpload }) {
  const [dragging, setDragging] = useState(false);

  function pickFile(file) {
    if (file && !busy) onUpload(file);
  }

  function onDragEnter(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!busy) setDragging(true);
  }

  function onDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!busy) setDragging(true);
  }

  function onDragLeave(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget === e.target) setDragging(false);
  }

  function onDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    if (busy) return;
    pickFile(e.dataTransfer.files?.[0]);
  }

  return (
    <section className="app-card">
      <h2>
        <span className="card-icon" aria-hidden="true">
          📤
        </span>
        Upload media
      </h2>
      <p className="muted">
        Images and videos. Duplicates are detected by checksum. Cloud uploads go directly to S3, then
        processing may take a few seconds.
      </p>
      <div
        className={`upload-dropzone${busy ? ' is-busy' : ''}${dragging ? ' is-dragging' : ''}`}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <input
          id="upload-input"
          type="file"
          accept="image/*,video/*"
          disabled={busy}
          aria-label="Choose image or video to upload"
          onChange={(e) => {
            pickFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
        <div className="upload-dropzone-icon" aria-hidden="true">
          🌿
        </div>
        <strong>{dragging ? 'Release to upload' : 'Drop a file here or click to browse'}</strong>
        <span>JPEG, PNG, WebP, MP4 and more</span>
      </div>
    </section>
  );
}
