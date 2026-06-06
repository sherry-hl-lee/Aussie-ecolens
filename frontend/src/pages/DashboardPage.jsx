import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  bulkTags,
  deleteFiles,
  getUploadMode,
  listFiles,
  normalizeMediaItems,
  queryByFile,
  querySpecies,
  queryTagsCount,
  queryThumbnail,
  uploadFile,
} from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { isItemOwnedByUser } from '../auth/authUtils.js';
import { Alert } from '../components/Alert.jsx';
import ConfirmModal from '../components/ConfirmModal.jsx';
import ImageModal from '../components/ImageModal.jsx';
import MediaGallery from '../components/MediaGallery.jsx';
import QueryPanel from '../components/QueryPanel.jsx';
import QueryResultsSection from '../components/QueryResultsSection.jsx';
import NotificationSection from '../components/NotificationSection.jsx';
import TagManageSection from '../components/TagManageSection.jsx';
import UploadSection from '../components/UploadSection.jsx';
import { formatError, useApiAction } from '../hooks/useApiAction.js';

export default function DashboardPage() {
  const { user, signOut, getToken } = useAuth();
  const { busy, error, notice, warning, setError, setNotice, setWarning, clearMessages, run } =
    useApiAction(getToken);

  const [exploreItems, setExploreItems] = useState([]);
  const [mineItems, setMineItems] = useState([]);
  const [exploreTotal, setExploreTotal] = useState(null);
  const [mineTotal, setMineTotal] = useState(null);
  const [browseMode, setBrowseMode] = useState('explore');
  const [selectedUrls, setSelectedUrls] = useState(() => new Set());
  const [modal, setModal] = useState(null);
  const [deleteConfirmCount, setDeleteConfirmCount] = useState(null);
  const [listLoading, setListLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [queryResults, setQueryResults] = useState(null);

  const galleryItems = browseMode === 'mine' ? mineItems : exploreItems;
  const galleryTotal = browseMode === 'mine' ? mineTotal : exploreTotal;

  function filterMineOnly(items) {
    if (!user?.uploadedBy) return items;
    const owned = items.filter((item) => item?.uploadedBy && isItemOwnedByUser(item, user));
    if (owned.length) return owned;
    // Legacy rows from GET /files?user=me without uploadedBy metadata
    return items;
  }

  /** Strict filter for search "Run my upload" — never include other users' media. */
  function filterQueryToMyUploads(items, mineList = mineItems) {
    if (!user?.uploadedBy) return [];
    const mineUrls = new Set((mineList || []).map((i) => i.fileUrl).filter(Boolean));
    const mineChecksums = new Set((mineList || []).map((i) => i.checksum).filter(Boolean));
    return items.filter((item) => {
      if (isItemOwnedByUser(item, user)) return true;
      if (item.fileUrl && mineUrls.has(item.fileUrl)) return true;
      if (item.checksum && mineChecksums.has(item.checksum)) return true;
      return false;
    });
  }

  async function fetchMineItems(token) {
    try {
      const data = await listFiles(token, { limit: 100, offset: 0, user: 'me' });
      return { data, items: filterMineOnly(normalizeMediaItems(data)) };
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        const data = await listFiles(token, { limit: 100, offset: 0 });
        return { data, items: filterMineOnly(normalizeMediaItems(data)) };
      }
      throw err;
    }
  }

  const refreshList = useCallback(async () => {
    setListLoading(true);
    try {
      const token = await getToken();
      if (!token) {
        throw new Error('No authentication token. Please sign in again.');
      }

      if (browseMode === 'mine') {
        const { data, items } = await fetchMineItems(token);
        setMineItems(items);
        setMineTotal(items.length);
        return;
      }

      const data = await listFiles(token, { limit: 100, offset: 0 });
      const normalized = normalizeMediaItems(data);
      setExploreItems(normalized);
      setExploreTotal(typeof data.total === 'number' ? data.total : normalized.length);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setListLoading(false);
    }
  }, [browseMode, getToken, setError, user]);

  useEffect(() => {
    refreshList();
  }, [refreshList]);

  function itemByUrl(fileUrl) {
    const fromGallery = galleryItems.find((it) => it.fileUrl === fileUrl);
    if (fromGallery) return fromGallery;
    return queryResults?.items?.find((it) => it.fileUrl === fileUrl);
  }

  function canSelectItem(item, { inQueryResults = false } = {}) {
    if (browseMode === 'mine' && !inQueryResults) return true;
    return isItemOwnedByUser(item, user);
  }

  function toggleSelect(fileUrl) {
    const item = itemByUrl(fileUrl);
    if (!item) return;
    const inQueryResults = Boolean(
      queryResults?.items?.some((it) => it.fileUrl === fileUrl),
    );
    if (!canSelectItem(item, { inQueryResults })) return;
    setSelectedUrls((prev) => {
      const next = new Set(prev);
      if (next.has(fileUrl)) next.delete(fileUrl);
      else next.add(fileUrl);
      return next;
    });
  }

  function selectAllOwned() {
    const queryUrls = new Set(
      (queryResults?.items || []).map((it) => it.fileUrl).filter(Boolean),
    );
    const pool = [...galleryItems, ...(queryResults?.items || [])];
    const seen = new Set();
    const owned = pool
      .filter((it) => {
        if (!it?.fileUrl || seen.has(it.fileUrl)) return false;
        seen.add(it.fileUrl);
        return canSelectItem(it, { inQueryResults: queryUrls.has(it.fileUrl) });
      })
      .map((it) => it.fileUrl);
    setSelectedUrls(new Set(owned));
  }

  function clearQueryResults() {
    setQueryResults(null);
    clearSelection();
  }

  function clearSelection() {
    setSelectedUrls(new Set());
  }

  function ownedSelectedUrls() {
    const queryUrls = new Set(
      (queryResults?.items || []).map((it) => it.fileUrl).filter(Boolean),
    );
    return [...selectedUrls].filter((url) => {
      const item = itemByUrl(url);
      if (!item) return false;
      return canSelectItem(item, { inQueryResults: queryUrls.has(url) });
    });
  }

  async function handleUpload(file) {
    setUploading(true);
    setError(null);
    try {
      const token = await getToken();
      if (!token) {
        throw new Error('No authentication token. Please sign in again.');
      }
      const data = await uploadFile(file, token);
      if (data.deduplicated) {
        setWarning('This file already exists in the system. Duplicate upload blocked.');
      } else if (data.item) {
        const tags = (data.item.tags || []).join(', ') || '(none)';
        setNotice(`Upload successful! Auto tags: ${tags}`);
      } else {
        setNotice('Upload successful!');
      }
      await refreshList();
      try {
        const { items } = await fetchMineItems(token);
        setMineItems(items);
        setMineTotal(items.length);
      } catch {
        /* My Uploads sync is best-effort; Explore refresh already succeeded */
      }
    } catch (err) {
      setError(formatError(err));
    } finally {
      setUploading(false);
    }
  }

  async function applyQueryResult(data, label, { mineOnly = false } = {}) {
    if (!data) return;
    let normalized = normalizeMediaItems(data);
    if (mineOnly) {
      let mineList = mineItems;
      try {
        const token = await getToken();
        if (token) {
          const fetched = await fetchMineItems(token);
          mineList = fetched.items;
          setMineItems(mineList);
          setMineTotal(mineList.length);
        }
      } catch {
        /* use cached mineItems */
      }
      normalized = filterQueryToMyUploads(normalized, mineList);
    }
    const count = mineOnly
      ? normalized.length
      : (data.count ?? data.total ?? normalized.length);
    const scopeLabel = mineOnly ? `${label} (my upload)` : `${label} (explore)`;
    setQueryResults({
      items: normalized,
      total: count,
      label: scopeLabel,
      response: mineOnly ? { ...data, count, items: normalized } : data,
    });
    setNotice(
      mineOnly
        ? `Found ${count} of your upload(s) in Search results.`
        : `Found ${count} file(s) in Search results.`,
    );
    clearSelection();
  }

  async function handleQueryTagCount(payload, { mineOnly = false } = {}) {
    if (!payload || typeof payload !== 'object' || !Object.keys(payload).length) {
      setError('Add at least one tag with a minimum count.');
      return;
    }
    const tagSummary = Object.entries(payload)
      .map(([tag, count]) => `${tag}≥${count}`)
      .join(', ');
    const data = await run((token) => queryTagsCount(payload, token));
    await applyQueryResult(data, `Tag counts (${tagSummary})`, { mineOnly });
  }

  async function handleQuerySpecies(species, { mineOnly = false } = {}) {
    if (!species) {
      setError('Species name is required.');
      return;
    }
    const data = await run((token) => querySpecies(species, token));
    await applyQueryResult(data, `Species: ${species}`, { mineOnly });
  }

  async function handleQueryThumbnail(url) {
    if (!url) {
      setError('Thumbnail URL is required.');
      return;
    }
    const data = await run((token) => queryThumbnail(url, token));
    if (data?.fileUrl) {
      setModal({
        title: 'Full image',
        imageUrl: data.fileUrl,
        fileUrl: data.fileUrl,
      });
      setNotice('Resolved thumbnail to full image URL.');
    }
  }

  async function handleQueryByFile(file, { mineOnly = false } = {}) {
    const data = await run((token) => queryByFile(file, token));
    const queryTags = Array.isArray(data?.queryTags) ? data.queryTags.join(', ') : '';
    const base = queryTags
      ? `Find by file (tags: ${queryTags})`
      : `Find by file: ${file.name || 'upload'}`;
    await applyQueryResult(data, base, { mineOnly });
  }

  async function handleOpenItem(item) {
    if (item.mediaType === 'video') {
      setModal({
        title: item.filename || 'Video',
        imageUrl: item.thumbnailUrl || null,
        fileUrl: item.fileUrl,
        mediaType: 'video',
      });
      return;
    }

    let fullUrl = item.fileUrl || item.thumbnailUrl;
    if (item.thumbnailUrl && item.fileUrl) {
      try {
        const token = await getToken();
        if (token) {
          const data = await queryThumbnail(item.thumbnailUrl, token);
          if (data?.fileUrl) fullUrl = data.fileUrl;
        }
      } catch {
        // fall back to fileUrl
      }
    }

    if (!fullUrl) {
      setError('No image URL available for this item.');
      return;
    }

    setModal({
      title: item.filename || 'Image',
      imageUrl: fullUrl,
      fileUrl: item.fileUrl || fullUrl,
      mediaType: 'image',
    });
  }

  async function handleBulkTags({ tags, operation }) {
    const urls = ownedSelectedUrls();
    if (!urls.length) {
      setError('Select at least one of your own files in the gallery.');
      return;
    }
    if (!tags.length) {
      setError('Enter at least one tag.');
      return;
    }
    const data = await run((token) => bulkTags({ urls, tags, operation }, token), {
      successMessage: `Tags updated on ${urls.length} file(s).`,
    });
    if (data) {
      await refreshList();
    }
  }

  function handleDeleteSelected() {
    const urls = ownedSelectedUrls();
    if (!urls.length) {
      setError('Select at least one of your own files to delete.');
      return;
    }
    setDeleteConfirmCount(urls.length);
  }

  async function executeDeleteSelected() {
    const urls = ownedSelectedUrls();
    if (!urls.length) {
      setDeleteConfirmCount(null);
      return;
    }
    setDeleteConfirmCount(null);

    const data = await run((token) => deleteFiles({ urls }, token), {
      successMessage: `Deleted ${urls.length} file(s).`,
    });
    if (data) {
      clearSelection();
      await refreshList();
    }
  }

  function switchBrowseMode(mode) {
    if (mode === browseMode) return;
    setBrowseMode(mode);
    clearSelection();
  }

  const selectedOwnedCount = ownedSelectedUrls().length;
  const welcomeName = user?.displayName || user?.email || 'Explorer';
  const displayedTotal = galleryTotal ?? galleryItems.length;
  const queryResultCount = queryResults?.total ?? queryResults?.items?.length ?? 0;

  return (
    <div className="app-shell">
      <header className="app-topbar">
        <div className="app-topbar-brand">
          <div className="app-topbar-logo" aria-hidden="true">
            🦘
          </div>
          <div>
            <h1>Aussie EcoLens</h1>
            <p className="topbar-welcome">Welcome back, {welcomeName}!</p>
            <p className="topbar-meta">
              Signed in as {user?.email || 'unknown'} · upload: {getUploadMode()}
            </p>
          </div>
        </div>
        <div className="app-topbar-actions">
          <button type="button" className="btn-secondary" disabled={busy} onClick={refreshList}>
            ↻ Refresh
          </button>
          <button type="button" className="btn-danger" onClick={() => signOut()}>
            Sign out
          </button>
        </div>
      </header>

      <main className="app-main app-main-wide">
        <Alert type="error" message={error} onDismiss={() => setError(null)} />
        <Alert type="warning" message={warning} onDismiss={() => setWarning(null)} />
        <Alert type="success" message={notice} onDismiss={() => setNotice(null)} />

        <div className="stats-strip">
          <div className="stat-chip">
            <strong>{listLoading ? '…' : displayedTotal}</strong>
            <span>{browseMode === 'mine' ? 'My uploads' : 'Media files'}</span>
          </div>
          <div className="stat-chip">
            <strong>{selectedOwnedCount}</strong>
            <span>Selected</span>
          </div>
          <div className="stat-chip">
            <strong>{queryResults ? queryResultCount : '—'}</strong>
            <span>Search results</span>
          </div>
          <div className="stat-chip">
            <strong>{busy ? '…' : 'Ready'}</strong>
            <span>Status</span>
          </div>
        </div>

        <div className="dashboard-stack">
          <div className="dashboard-grid">
            <div className="dashboard-col">
              <UploadSection busy={uploading} onUpload={handleUpload} />
            </div>
            <div className="dashboard-col">
              <QueryPanel
                busy={busy}
                onQueryTagCount={handleQueryTagCount}
                onQuerySpecies={handleQuerySpecies}
                onQueryThumbnail={handleQueryThumbnail}
                onQueryByFile={handleQueryByFile}
                onClearSearch={clearQueryResults}
              />
            </div>
          </div>

          <QueryResultsSection
            busy={busy}
            queryResults={queryResults}
            selectedUrls={selectedUrls}
            onClear={clearQueryResults}
            onToggleSelect={toggleSelect}
            onOpenItem={handleOpenItem}
            canSelectResultItem={(item) => canSelectItem(item, { inQueryResults: true })}
          />

          <div className="dashboard-grid">
            <div className="dashboard-col">
              <NotificationSection
                busy={busy}
                getToken={getToken}
                onNotice={(message) => setNotice(message)}
              />
            </div>
            <div className="dashboard-col">
              <TagManageSection
                busy={busy}
                selectedCount={selectedOwnedCount}
                visible={selectedOwnedCount > 0}
                onBulkTags={handleBulkTags}
                onDeleteSelected={handleDeleteSelected}
                onSelectAll={selectAllOwned}
                onClearSelection={clearSelection}
              />
            </div>
          </div>
        </div>

        <section className="app-card results-card">
          <div className="results-header">
            <h2>
              <span className="card-icon" aria-hidden="true">
                🖼️
              </span>
              Gallery ({listLoading ? '…' : displayedTotal})
            </h2>
            {listLoading ? <span className="loading-pill">Loading…</span> : null}
          </div>

          <div className="browse-tabs" role="tablist" aria-label="Gallery scope">
            <button
              type="button"
              role="tab"
              aria-selected={browseMode === 'explore'}
              className={`browse-tab${browseMode === 'explore' ? ' active' : ''}`}
              disabled={busy || listLoading}
              onClick={() => switchBrowseMode('explore')}
            >
              Explore
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={browseMode === 'mine'}
              className={`browse-tab${browseMode === 'mine' ? ' active' : ''}`}
              disabled={busy || listLoading}
              onClick={() => switchBrowseMode('mine')}
            >
              My Uploads
            </button>
          </div>

          <p className="muted">
            {browseMode === 'explore'
              ? 'All platform observations — unchanged by search. Hover a thumbnail and click to view full size.'
              : 'Only media you uploaded. Search matches appear in Search results.'}
          </p>
          <MediaGallery
            items={galleryItems}
            selectedUrls={selectedUrls}
            onToggleSelect={toggleSelect}
            onOpenItem={handleOpenItem}
            loading={listLoading}
            canSelectItem={(item) => canSelectItem(item, { inQueryResults: false })}
          />
        </section>
      </main>

      {modal ? (
        <ImageModal
          title={modal.title}
          imageUrl={modal.imageUrl}
          fileUrl={modal.fileUrl}
          mediaType={modal.mediaType}
          onClose={() => setModal(null)}
        />
      ) : null}

      {deleteConfirmCount ? (
        <ConfirmModal
          title="Friendly Reminder"
          message={`Are you sure you want to delete ${deleteConfirmCount} file(s) and their thumbnails and database records? This action cannot be undone.`}
          confirmLabel="Delete"
          cancelLabel="Cancel"
          busy={busy}
          onConfirm={executeDeleteSelected}
          onCancel={() => setDeleteConfirmCount(null)}
        />
      ) : null}
    </div>
  );
}
