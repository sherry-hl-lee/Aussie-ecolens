import { useEffect, useState } from 'react';
import MediaGallery from './MediaGallery.jsx';

export default function QueryResultsSection({
  busy,
  queryResults,
  selectedUrls,
  onClear,
  onToggleSelect,
  onOpenItem,
  canSelectResultItem,
}) {
  const [expanded, setExpanded] = useState(true);
  const resultCount = queryResults?.total ?? queryResults?.items?.length ?? 0;

  useEffect(() => {
    if (queryResults) setExpanded(true);
  }, [queryResults]);

  return (
    <section className="app-card query-results-card query-results-wide">
      <div className="query-results-card-header">
        <h2>
          <span className="card-icon" aria-hidden="true">
            📋
          </span>
          Search results
        </h2>
        <button
          type="button"
          className="btn-ghost query-clear-btn"
          disabled={busy || !queryResults}
          onClick={onClear}
        >
          Clear results
        </button>
      </div>

      {!queryResults ? (
        <p className="muted query-results-empty">
          Use Search &amp; query, then Run explore or Run my upload. Run my upload only shows media you
          uploaded.
        </p>
      ) : (
        <details
          className="query-results-collapse query-results-collapse--standalone"
          open={expanded}
          onToggle={(e) => setExpanded(e.currentTarget.open)}
        >
          <summary className="query-results-summary">
            <span>
              {busy ? 'Searching…' : `${resultCount} match(es)`}
              {queryResults.label ? ` — ${queryResults.label}` : ''}
            </span>
            <span className="query-results-chevron" aria-hidden="true">
              {expanded ? '▾' : '▸'}
            </span>
          </summary>
          <div className="query-results-body">
            {busy ? <p className="muted">Searching…</p> : null}
            <MediaGallery
              items={queryResults.items}
              selectedUrls={selectedUrls}
              onToggleSelect={onToggleSelect}
              onOpenItem={onOpenItem}
              loading={busy}
              canSelectItem={canSelectResultItem}
            />
            <details className="raw-json query-results-raw">
              <summary>Raw API response</summary>
              <pre>{JSON.stringify(queryResults.response ?? queryResults.items, null, 2)}</pre>
            </details>
          </div>
        </details>
      )}
    </section>
  );
}
