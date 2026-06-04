import { useCallback, useEffect, useState } from 'react';
import {
  bulkTags,
  deleteFiles,
  getApiBaseUrl,
  listFiles,
  normalizeMediaItems,
  queryByFile,
  querySpecies,
  queryTagsCount,
  queryThumbnail,
  uploadFile,
} from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { Alert } from '../components/Alert.jsx';
import ImageModal from '../components/ImageModal.jsx';
import MediaGallery from '../components/MediaGallery.jsx';
import QueryPanel from '../components/QueryPanel.jsx';
import TagManageSection from '../components/TagManageSection.jsx';
import UploadSection from '../components/UploadSection.jsx';
import { useApiAction } from '../hooks/useApiAction.js';

export default function DashboardPage() {
  const { user, signOut, getToken } = useAuth();
  const { busy, error, notice, setError, setNotice, clearMessages, run } = useApiAction(getToken);

  const [items, setItems] = useState([]);
  const [selectedUrls, setSelectedUrls] = useState(() => new Set());
  const [lastResponse, setLastResponse] = useState(null);
  const [modal, setModal] = useState(null);
  const [galleryLoading, setGalleryLoading] = useState(false);

  const refreshList = useCallback(async () => {
    setGalleryLoading(true);
    const data = await run((token) => listFiles(token, { limit: 100, offset: 0 }));
    setGalleryLoading(false);
    if (data) {
      setItems(normalizeMediaItems(data));
      setLastResponse(data);
    }
  }, [run]);

  useEffect(() => {
    refreshList();
  }, [refreshList]);

  function toggleSelect(fileUrl) {
    setSelectedUrls((prev) => {
      const next = new Set(prev);
      if (next.has(fileUrl)) next.delete(fileUrl);
      else next.add(fileUrl);
      return next;
    });
  }

  function selectAll() {
    setSelectedUrls(new Set(items.map((it) => it.fileUrl).filter(Boolean)));
  }

  function clearSelection() {
    setSelectedUrls(new Set());
  }

  async function handleUpload(file) {
    const data = await run((token) => uploadFile(file, token), {
      successMessage: 'Upload finished.',
    });
    if (data) {
      setLastResponse(data);
      if (data.deduplicated) {
        setNotice('Duplicate file — existing record returned (checksum match).');
      }
      if (data.item) {
        setItems((prev) => {
          const without = prev.filter((p) => p.fileUrl !== data.item.fileUrl);
          return [data.item, ...without];
        });
      } else {
        await refreshList();
      }
    }
  }

  async function applyQueryResult(data) {
    if (!data) return;
    setLastResponse(data);
    setItems(normalizeMediaItems(data));
    setNotice(`Found ${data.count ?? normalizeMediaItems(data).length} file(s).`);
    clearSelection();
  }

  async function handleQueryTagCount(payload) {
    if (!payload || typeof payload !== 'object') {
      setError('Invalid JSON for tag counts.');
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
      });
      return;
    }
    if (!item.thumbnailUrl) {
      setModal({ title: item.filename, imageUrl: item.fileUrl, fileUrl: item.fileUrl });
      return;
    }
    setGalleryLoading(true);
    const data = await run((token) => queryThumbnail(item.thumbnailUrl, token));
    setGalleryLoading(false);
    if (data?.fileUrl) {
      setModal({
        title: item.filename || 'Image',
        imageUrl: data.fileUrl,
        fileUrl: data.fileUrl,
      });
    }
  }

  async function handleBulkTags({ tags, operation }) {
    const urls = [...selectedUrls];
    if (!urls.length) {
      setError('Select at least one file in the gallery.');
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
    const urls = [...selectedUrls];
    if (!urls.length) {
      setError('Select at least one file to delete.');
      return;
    }
    if (!window.confirm(`Delete ${urls.length} file(s) from storage and database?`)) return;

    const data = await run((token) => deleteFiles({ urls }, token), {
      successMessage: `Deleted ${urls.length} file(s).`,
    });
    if (data) {
      setLastResponse(data);
      clearSelection();
      await refreshList();
    }
  }

  const selectedCount = selectedUrls.size;

  return (
    <div className="app-shell">
      <header className="app-topbar">
        <div className="app-topbar-brand">
          <div className="app-topbar-logo" aria-hidden="true">
            🦘
          </div>
          <div>
            <h1>Aussie EcoLens</h1>
            <p>
              {user?.email || 'Signed in'} · {getApiBaseUrl() || 'API not configured'}
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
        <Alert type="success" message={notice} onDismiss={() => setNotice(null)} />

        <div className="stats-strip">
          <div className="stat-chip">
            <strong>{items.length}</strong>
            <span>Media files</span>
          </div>
          <div className="stat-chip">
            <strong>{selectedCount}</strong>
            <span>Selected</span>
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
              selectedCount={selectedCount}
              onBulkTags={handleBulkTags}
              onDeleteSelected={handleDeleteSelected}
              onSelectAll={selectAll}
              onClearSelection={clearSelection}
            />
          </div>
        </div>

        <section className="app-card results-card">
          <div className="results-header">
            <h2>
              <span className="card-icon" aria-hidden="true">
                🖼️
              </span>
              Results ({items.length})
            </h2>
            {busy ? <span className="loading-pill">Working…</span> : null}
          </div>
          <p className="muted">Hover a thumbnail and click to view full size. Select items to edit tags or delete.</p>
          <MediaGallery
            items={items}
            selectedUrls={selectedUrls}
            onToggleSelect={toggleSelect}
            onOpenItem={handleOpenItem}
            loading={galleryLoading && !items.length}
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
          onClose={() => setModal(null)}
        />
      ) : null}
    </div>
  );
}
