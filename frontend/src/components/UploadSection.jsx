export default function UploadSection({ busy, onUpload }) {
  return (
    <section className="app-card">
      <h2>
        <span className="card-icon" aria-hidden="true">
          📤
        </span>
        Upload media
      </h2>
      <p className="muted">Images and videos. Duplicates are detected automatically by checksum.</p>
      <div className={`upload-dropzone${busy ? ' is-busy' : ''}`}>
        <input
          id="upload-input"
          type="file"
          accept="image/*,video/*"
          disabled={busy}
          aria-label="Choose image or video to upload"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onUpload(file);
            e.target.value = '';
          }}
        />
        <div className="upload-dropzone-icon" aria-hidden="true">
          🌿
        </div>
        <strong>Drop a file here or click to browse</strong>
        <span>JPEG, PNG, WebP, MP4 and more</span>
      </div>
    </section>
  );
}
