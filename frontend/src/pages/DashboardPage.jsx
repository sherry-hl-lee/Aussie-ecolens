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
  const [mediaTotal, setMediaTotal] = useState(null);
  const [selectedUrls, setSelectedUrls] = useState(() => new Set());
  const [lastResponse, setLastResponse] = useState(null);
  const [modal, setModal] = useState(null);
  const [listLoading, setListLoading] = useState(true);

  const refreshList = useCallback(async () => {
    setListLoading(true);
    const data = await run((token) => listFiles(token, { limit: 100, offset: 0 }));
    setListLoading(false);
    if (data) {
      const normalized = normalizeMediaItems(data);
      setItems(normalized);
      setMediaTotal(typeof data.total === 'number' ? data.total : normalized.length);
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
      } else {
        setNotice('Upload successful!');
        await refreshList();
      }
    }
  }

  async function applyQueryResult(data) {
    if (!data) return;
    const normalized = normalizeMediaItems(data);
    setLastResponse(data);
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
        // Use fileUrl when thumbnail lookup fails (URL mismatch, etc.)
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
            <p>
              {user?.email || 'Signed in'} · {getApiBaseUrl() || 'API not configured'} · upload:{' '}
              {getUploadMode()}
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
              Results ({listLoading ? '…' : displayedTotal})
            </h2>
            {busy || listLoading ? <span className="loading-pill">Working…</span> : null}
          </div>
          <p className="muted">Hover a thumbnail and click to view full size. Select items to edit tags or delete.</p>
          <MediaGallery
            items={items}
            selectedUrls={selectedUrls}
            onToggleSelect={toggleSelect}
            onOpenItem={handleOpenItem}
            loading={listLoading}
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
