import { useState } from 'react';

const TABS = [
  { id: 'tags', label: 'Tag counts (AND)' },
  { id: 'file', label: 'Find by file' },
  { id: 'lookup', label: 'Thumbnail / species' },
];

function emptyTagRow() {
  return { id: crypto.randomUUID(), tag: '', count: 1 };
}

export default function QueryPanel({
  busy,
  onQueryTagCount,
  onQuerySpecies,
  onQueryThumbnail,
  onQueryByFile,
}) {
  const [activeTab, setActiveTab] = useState('tags');
  const [tagRows, setTagRows] = useState([{ id: '1', tag: 'koala', count: 2 }]);
  const [species, setSpecies] = useState('');
  const [thumbnailUrl, setThumbnailUrl] = useState('');

  function updateTagRow(id, field, value) {
    setTagRows((rows) => rows.map((row) => (row.id === id ? { ...row, [field]: value } : row)));
  }

  function addTagRow() {
    setTagRows((rows) => [...rows, emptyTagRow()]);
  }

  function removeTagRow(id) {
    setTagRows((rows) => (rows.length <= 1 ? rows : rows.filter((row) => row.id !== id)));
  }

  function runTagCountQuery() {
    const payload = {};
    for (const row of tagRows) {
      const tag = row.tag.trim().toLowerCase();
      if (!tag) continue;
      payload[tag] = Math.max(1, Number(row.count) || 1);
    }
    onQueryTagCount(payload);
  }

  return (
    <section className="app-card">
      <h2>
        <span className="card-icon" aria-hidden="true">
          🔎
        </span>
        Search &amp; query
      </h2>
      <p className="muted">Fuzzy tag search — e.g. &quot;dingo&quot; matches &quot;canis dingo&quot;.</p>

      <div className="query-tabs" role="tablist" aria-label="Query modes">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            className={`query-tab${activeTab === tab.id ? ' active' : ''}`}
            disabled={busy}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'tags' ? (
        <div className="query-panel-body" role="tabpanel">
          <p className="hint">Fuzzy AND: each tag must match at least one stored tag with the minimum count.</p>
          {tagRows.map((row, index) => (
            <div key={row.id} className="tag-count-row">
              <input
                type="text"
                placeholder="Tag e.g. koala"
                value={row.tag}
                disabled={busy}
                aria-label={`Tag name ${index + 1}`}
                onChange={(e) => updateTagRow(row.id, 'tag', e.target.value)}
              />
              <input
                type="number"
                min={1}
                value={row.count}
                disabled={busy}
                aria-label={`Minimum count for ${row.tag || 'tag'}`}
                onChange={(e) => updateTagRow(row.id, 'count', e.target.value)}
              />
              <button
                type="button"
                className="btn-ghost tag-count-remove"
                disabled={busy || tagRows.length <= 1}
                aria-label="Remove tag row"
                onClick={() => removeTagRow(row.id)}
              >
                −
              </button>
            </div>
          ))}
          <div className="row-actions">
            <button type="button" className="btn-secondary" disabled={busy} onClick={addTagRow}>
              + Add tag
            </button>
            <button type="button" className="btn-primary" disabled={busy} onClick={runTagCountQuery}>
              Run query
            </button>
          </div>
        </div>
      ) : null}

      {activeTab === 'file' ? (
        <div className="query-panel-body" role="tabpanel">
          <p className="hint">This query image is not stored in the system.</p>
          <label className={`file-picker-btn${busy ? ' is-disabled' : ''}`}>
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
      ) : null}

      {activeTab === 'lookup' ? (
        <div className="query-panel-body" role="tabpanel">
          <h3>By species (fuzzy)</h3>
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

          <h3 style={{ marginTop: '1rem' }}>Thumbnail → full image</h3>
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
      ) : null}
    </section>
  );
}
