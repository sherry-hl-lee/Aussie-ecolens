import { useCallback, useEffect, useState } from 'react';
import {
  bulkTags,
  deleteFiles,
  getApiBaseUrl,
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
import ImageModal from '../components/ImageModal.jsx';
import MediaGallery from '../components/MediaGallery.jsx';
import QueryPanel from '../components/QueryPanel.jsx';
import NotificationSection from '../components/NotificationSection.jsx';
import TagManageSection from '../components/TagManageSection.jsx';
import UploadSection from '../components/UploadSection.jsx';
import { useApiAction } from '../hooks/useApiAction.js';

export default function DashboardPage() {
  const { user, signOut, getToken } = useAuth();
  const { busy, error, notice, warning, setError, setNotice, setWarning, clearMessages, run } =
    useApiAction(getToken);

  const [items, setItems] = useState([]);
  const [mineItems, setMineItems] = useState([]);
  const [mediaTotal, setMediaTotal] = useState(null);
  const [browseMode, setBrowseMode] = useState('explore');
  const [selectedUrls, setSelectedUrls] = useState(() => new Set());
  const [lastResponse, setLastResponse] = useState(null);
  const [modal, setModal] = useState(null);
  const [listLoading, setListLoading] = useState(true);

  const refreshList = useCallback(async () => {
    setListLoading(true);
    const listParams =
      browseMode === 'mine' ? { limit: 100, offset: 0, user: 'me' } : { limit: 100, offset: 0 };
    const data = await run((token) => listFiles(token, listParams));
    setListLoading(false);
    if (data) {
      const normalized = normalizeMediaItems(data);
      setItems(normalized);
      setMediaTotal(typeof data.total === 'number' ? data.total : normalized.length);
      setLastResponse(data);
      if (browseMode === 'mine') {
        setMineItems(normalized);
      }
    }
  }, [run, browseMode]);

  useEffect(() => {
    refreshList();
  }, [refreshList]);

  function itemByUrl(fileUrl) {
    return items.find((it) => it.fileUrl === fileUrl);
  }

  function canSelectItem(item) {
    if (browseMode === 'mine') return true;
    return isItemOwnedByUser(item, user);
  }

  function toggleSelect(fileUrl) {
    const item = itemByUrl(fileUrl);
    if (item && !canSelectItem(item)) return;
    setSelectedUrls((prev) => {
      const next = new Set(prev);
      if (next.has(fileUrl)) next.delete(fileUrl);
      else next.add(fileUrl);
      return next;
    });
  }

  function selectAllOwned() {
    const owned = items.filter((it) => canSelectItem(it)).map((it) => it.fileUrl).filter(Boolean);
    setSelectedUrls(new Set(owned));
  }

  function clearSelection() {
    setSelectedUrls(new Set());
  }

  function ownedSelectedUrls() {
    return [...selectedUrls].filter((url) => {
      const item = itemByUrl(url);
      return item && canSelectItem(item);
    });
  }

  async function handleUpload(file) {
    const data = await run((token) => uploadFile(file, token));
    if (data) {
      setLastResponse(data);
      if (data.deduplicated) {
        setWarning('This file already exists in the system. Duplicate upload blocked.');
        if (data.item) {
          setItems((prev) => {
            const without = prev.filter((p) => p.fileUrl !== data.item.fileUrl);
            return [data.item, ...without];
          });
        }
      } else if (data.item) {
        const tags = (data.item.tags || []).join(', ') || '(none)';
        setNotice(`Upload successful! Auto tags: ${tags}`);
        setItems((prev) => {
          const without = prev.filter((p) => p.fileUrl !== data.item.fileUrl);
          return [data.item, ...without];
        });
        setMediaTotal((total) => (typeof total === 'number' ? total + 1 : 1));
        if (browseMode === 'mine') {
          await refreshList();
        }
      } else {
        setNotice('Upload successful!');
        await refreshList();
      }
    }
  }

  function filterToMyUploads(candidates) {
    const mineUrls = new Set(mineItems.map((it) => it.fileUrl).filter(Boolean));
    return candidates.filter(
      (item) =>
        isItemOwnedByUser(item, user) || (item.fileUrl && mineUrls.has(item.fileUrl)),
    );
  }

  async function applyQueryResult(data) {
    if (!data) return;
    const normalized = normalizeMediaItems(data);
    setLastResponse(data);

    if (browseMode === 'mine') {
      const baseline = mineItems.length ? mineItems : items;
      const filtered = filterToMyUploads(normalized);
      if (!filtered.length) {
        setItems(baseline);
        setMediaTotal(baseline.length);
        setNotice('No matches in your uploads. Showing all your files.');
      } else {
        setItems(filtered);
        setMediaTotal(filtered.length);
        setNotice(`Found ${filtered.length} matching file(s) in your uploads.`);
      }
      clearSelection();
      return;
    }

    setItems(normalized);
    setMediaTotal(data.count ?? data.total ?? normalized.length);
    setNotice(`Found ${data.count ?? normalized.length} file(s).`);
    clearSelection();
  }

  async function handleQueryTagCount(payload) {
    if (!payload || typeof payload !== 'object' || !Object.keys(payload).length) {
      setError('Add at least one tag with a minimum count.');
      return;
    }
    const data = await run((token) => queryTagsCount(payload, token));
    await applyQueryResult(data);
  }

  async function handleQuerySpecies(species) {
    if (!species) {
      setError('Species name is required.');
      return;
    }
    const data = await run((token) => querySpecies(species, token));
    await applyQueryResult(data);
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
      setLastResponse(data);
    }
  }

  async function handleQueryByFile(file) {
    const data = await run((token) => queryByFile(file, token));
    await applyQueryResult(data);
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
      setLastResponse(data);
      await refreshList();
    }
  }

  async function handleDeleteSelected() {
    const urls = ownedSelectedUrls();
    if (!urls.length) {
      setError('Select at least one of your own files to delete.');
      return;
    }
    if (
      !window.confirm(
        `Delete ${urls.length} file(s) and their thumbnails from storage and database? This cannot be undone.`,
      )
    ) {
      return;
    }

    const data = await run((token) => deleteFiles({ urls }, token), {
      successMessage: `Deleted ${urls.length} file(s).`,
    });
    if (data) {
      setLastResponse(data);
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
  const displayedTotal = mediaTotal ?? items.length;

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
            <span>Selected (mine)</span>
          </div>
          <div className="stat-chip">
            <strong>{busy ? '…' : 'Ready'}</strong>
            <span>Status</span>
          </div>
        </div>

        <div className="dashboard-grid">
          <div className="dashboard-col">
            <UploadSection busy={busy} onUpload={handleUpload} />
          </div>
          <div className="dashboard-col">
            <QueryPanel
              busy={busy}
              onQueryTagCount={handleQueryTagCount}
              onQuerySpecies={handleQuerySpecies}
              onQueryThumbnail={handleQueryThumbnail}
              onQueryByFile={handleQueryByFile}
            />
            <TagManageSection
              busy={busy}
              selectedCount={selectedOwnedCount}
              visible={selectedOwnedCount > 0}
              onBulkTags={handleBulkTags}
              onDeleteSelected={handleDeleteSelected}
              onSelectAll={selectAllOwned}
              onClearSelection={clearSelection}
            />
            <NotificationSection
              busy={busy}
              getToken={getToken}
              onNotice={(message) => setNotice(message)}
            />
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
            {busy || listLoading ? <span className="loading-pill">Working…</span> : null}
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
              ? 'All platform observations. Hover a thumbnail and click to view full size.'
              : 'Only media you uploaded. You can edit tags or delete items here.'}
          </p>
          <MediaGallery
            items={items}
            selectedUrls={selectedUrls}
            onToggleSelect={toggleSelect}
            onOpenItem={handleOpenItem}
            loading={listLoading}
            canSelectItem={canSelectItem}
          />
          <details className="raw-json">
            <summary>Raw API response</summary>
            <pre>{JSON.stringify(lastResponse, null, 2)}</pre>
          </details>
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
    </div>
  );
}
