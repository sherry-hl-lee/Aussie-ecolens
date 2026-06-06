import { useState } from 'react';

export default function TagManageSection({
  busy,
  selectedCount,
  onBulkTags,
  onDeleteSelected,
  onSelectAll,
  onClearSelection,
  visible,
}) {
  const [tagsInput, setTagsInput] = useState('koala');
  const [operation, setOperation] = useState('1');

  if (!visible) {
    return (
      <section className="app-card tag-manage-muted">
        <h2>
          <span className="card-icon" aria-hidden="true">
            🏷️
          </span>
          Tags &amp; files
        </h2>
        <p className="muted" style={{ margin: 0 }}>
          Select one of your own uploads to edit tags or delete. Other users&apos; media is view-only
          in Explore.
        </p>
      </section>
    );
  }

  function handleBulk() {
    const tags = tagsInput
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    onBulkTags({
      tags,
      operation: Number(operation),
    });
  }

  return (
    <section className="app-card">
      <h2>
        <span className="card-icon" aria-hidden="true">
          🏷️
        </span>
        Tags &amp; files
      </h2>

      <div className="selection-badge">
        <span aria-hidden="true">✓</span>
        {selectedCount} of your upload(s) selected
      </div>

      <div className="row-actions">
        <button type="button" className="btn-secondary" disabled={busy} onClick={onSelectAll}>
          Select all mine
        </button>
        <button type="button" className="btn-ghost" disabled={busy} onClick={onClearSelection}>
          Clear
        </button>
      </div>

      <label htmlFor="bulk-tags">Tags (comma-separated)</label>
      <input
        id="bulk-tags"
        type="text"
        value={tagsInput}
        disabled={busy}
        placeholder="koala, magpie"
        onChange={(e) => setTagsInput(e.target.value)}
      />

      <label htmlFor="bulk-op">Operation</label>
      <select id="bulk-op" value={operation} disabled={busy} onChange={(e) => setOperation(e.target.value)}>
        <option value="1">Add tags</option>
        <option value="0">Remove tags</option>
      </select>

      <button type="button" className="btn-primary btn-block" disabled={busy} onClick={handleBulk}>
        Apply to selected
      </button>

      <button type="button" className="btn-danger btn-block" disabled={busy} onClick={onDeleteSelected}>
        Delete selected
      </button>
    </section>
  );
}
