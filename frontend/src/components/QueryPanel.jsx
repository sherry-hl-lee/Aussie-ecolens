import { useState } from 'react';

export default function QueryPanel({ busy, onQueryTagCount, onQuerySpecies, onQueryThumbnail, onQueryByFile }) {
  const [tagCountJson, setTagCountJson] = useState('{"koala": 2}');
  const [species, setSpecies] = useState('');
  const [thumbnailUrl, setThumbnailUrl] = useState('');

  return (
    <section className="app-card">
      <h2>
        <span className="card-icon" aria-hidden="true">
          🔎
        </span>
        Search &amp; query
      </h2>
      <p className="muted">Find wildlife media by species tags, counts, or similar files.</p>

      <div className="query-group">
        <h3>Tag + minimum count (AND)</h3>
        <p className="hint">Example: {`{"koala": 2, "magpie": 1}`}</p>
        <textarea
          rows={3}
          value={tagCountJson}
          disabled={busy}
          onChange={(e) => setTagCountJson(e.target.value)}
        />
        <button
          type="button"
          className="btn-primary btn-block"
          disabled={busy}
          onClick={() => {
            try {
              onQueryTagCount(JSON.parse(tagCountJson || '{}'));
            } catch {
              onQueryTagCount(null);
            }
          }}
        >
          Run query
        </button>
      </div>

      <div className="query-group">
        <h3>By species</h3>
        <input
          type="text"
          placeholder="e.g. dingo, koala, wombat"
          value={species}
          disabled={busy}
          onChange={(e) => setSpecies(e.target.value)}
        />
        <button
          type="button"
          className="btn-primary btn-block"
          disabled={busy}
          onClick={() => onQuerySpecies(species.trim())}
        >
          Search species
        </button>
      </div>

      <div className="query-group">
        <h3>Thumbnail → full image</h3>
        <input
          type="text"
          placeholder="Paste thumbnail URL…"
          value={thumbnailUrl}
          disabled={busy}
          onChange={(e) => setThumbnailUrl(e.target.value)}
        />
        <button
          type="button"
          className="btn-secondary btn-block"
          disabled={busy}
          onClick={() => onQueryThumbnail(thumbnailUrl.trim())}
        >
          Resolve full URL
        </button>
      </div>

      <div className="query-group">
        <h3>Find similar by file</h3>
        <p className="hint">Upload a sample — tags are detected without storing the file.</p>
        <label className={`file-picker-btn${busy ? '' : ''}`} style={busy ? { opacity: 0.55, pointerEvents: 'none' } : undefined}>
          <input
            type="file"
            accept="image/*,video/*"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onQueryByFile(file);
              e.target.value = '';
            }}
          />
          Choose file to match tags
        </label>
      </div>
    </section>
  );
}
