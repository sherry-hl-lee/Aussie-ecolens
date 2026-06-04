import './amplifyConfig.js';
import {
  fetchAuthSession,
  getCurrentUser,
  signInWithRedirect,
  signOut,
} from 'aws-amplify/auth';
import { Hub } from 'aws-amplify/utils';

const el = (id) => document.getElementById(id);

const defaultApiBase = import.meta.env.VITE_API_BASE_URL || '';

const state = {
  apiBase: localStorage.getItem('apiBase') || defaultApiBase,
  token: localStorage.getItem('token') || '',
  userEmail: '',
};

function init() {
  el('apiBase').value = state.apiBase;
  el('token').value = state.token;

  el('apiBase').addEventListener('input', () => {
    state.apiBase = el('apiBase').value.trim();
    localStorage.setItem('apiBase', state.apiBase);
    loadAuthConfig();
  });

  el('token').addEventListener('input', () => {
    state.token = el('token').value.trim();
    localStorage.setItem('token', state.token);
    updateProtectedUi();
  });

  el('loginBtn').addEventListener('click', login);
  el('verifyTokenBtn').addEventListener('click', verifyToken);
  el('logoutBtn').addEventListener('click', logout);
  el('uploadBtn').addEventListener('click', uploadFile);
  el('queryTagCountBtn').addEventListener('click', queryTagCount);
  el('querySpeciesBtn').addEventListener('click', querySpecies);
  el('queryThumbnailBtn').addEventListener('click', queryThumbnail);
  el('queryFileBtn').addEventListener('click', queryByFile);
  el('bulkTagsBtn').addEventListener('click', bulkTags);
  el('deleteBtn').addEventListener('click', deleteFiles);
  el('listFilesBtn').addEventListener('click', listFiles);

  Hub.listen('auth', ({ payload }) => {
    if (payload.event === 'signedIn' || payload.event === 'tokenRefresh') {
      refreshAuthState();
    }
    if (payload.event === 'signedOut') {
      clearLocalAuth();
    }
  });

  refreshAuthState();
  loadAuthConfig();
}

async function login() {
  try {
    await signInWithRedirect();
  } catch (error) {
    renderResult({ error: error.message || String(error) });
  }
}

async function logout() {
  try {
    await signOut();
  } catch (error) {
    renderResult({ error: error.message || String(error) });
  } finally {
    clearLocalAuth();
  }
}

function clearLocalAuth() {
  state.token = '';
  state.userEmail = '';
  el('token').value = '';
  localStorage.removeItem('token');
  updateAuthStatus();
  updateProtectedUi();
  el('tokenHint').textContent =
    'Signed out. Sign in again to use upload and query features.';
}

async function refreshAuthState() {
  try {
    const session = await fetchAuthSession();
    const idToken = session.tokens?.idToken?.toString();
    if (!idToken) {
      updateAuthStatus();
      updateProtectedUi();
      return;
    }

    state.token = idToken;
    el('token').value = idToken;
    localStorage.setItem('token', idToken);

    try {
      const user = await getCurrentUser();
      const claims = session.tokens?.idToken?.payload || {};
      state.userEmail =
        claims.email ||
        user.signInDetails?.loginId ||
        user.username ||
        user.userId ||
        'Signed in';
    } catch {
      state.userEmail = 'Signed in';
    }

    updateAuthStatus();
    updateProtectedUi();
    el('tokenHint').textContent =
      'ID token from Amplify session (sent as Bearer on API calls).';
  } catch {
    updateAuthStatus();
    updateProtectedUi();
  }
}

function updateAuthStatus() {
  const statusEl = el('authStatus');
  if (state.userEmail && state.token) {
    statusEl.textContent = `Signed in as ${state.userEmail}`;
    statusEl.classList.add('signed-in');
    el('statusChip').textContent = 'Authenticated';
  } else {
    statusEl.textContent = 'Not signed in — sign in to use the app';
    statusEl.classList.remove('signed-in');
    el('statusChip').textContent = 'Prototype UI';
  }
}

function updateProtectedUi() {
  const locked = !state.token;
  el('protectedWorkspace').classList.toggle('locked', locked);
  el('protectedResults').classList.toggle('locked', locked);
}

async function ensureAuthenticated() {
  await refreshAuthState();
  if (!state.token) {
    throw new Error('Sign in required. Use Sign in (Hosted UI) first.');
  }
}

function getHeaders() {
  const headers = { Accept: 'application/json' };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  return headers;
}

function buildUrl(path) {
  if (!state.apiBase) {
    throw new Error('Set API Base URL first.');
  }
  return `${state.apiBase.replace(/\/$/, '')}${path}`;
}

async function requestJson(path, options = {}) {
  const response = await fetch(buildUrl(path), {
    ...options,
    headers: {
      ...getHeaders(),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    throw new Error(
      `${response.status} ${response.statusText}: ${JSON.stringify(data)}`,
    );
  }
  return data;
}

function renderResult(data) {
  el('resultBox').textContent = JSON.stringify(data, null, 2);
  renderGallery(data);
}

function renderGallery(data) {
  const gallery = el('gallery');
  gallery.innerHTML = '';
  const urls = extractUrls(data);
  urls.forEach((url) => {
    const img = document.createElement('img');
    img.src = url;
    img.alt = 'thumbnail';
    img.loading = 'lazy';
    gallery.appendChild(img);
  });
}

function extractUrls(data) {
  const maybeUrls = [];
  const walk = (value) => {
    if (
      typeof value === 'string' &&
      /^https?:\/\//.test(value) &&
      /\.(jpg|jpeg|png|webp)$/i.test(value)
    ) {
      maybeUrls.push(value);
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(walk);
    }
  };
  walk(data);
  return [...new Set(maybeUrls)];
}

async function uploadFile() {
  try {
    await ensureAuthenticated();
    const file = el('uploadFile').files[0];
    if (!file) throw new Error('Choose a file first.');
    const form = new FormData();
    form.append('file', file);
    const data = await requestJson('/upload', {
      method: 'POST',
      body: form,
      headers: getHeaders(),
    });
    renderResult(data);
  } catch (error) {
    renderResult({ error: error.message });
  }
}

async function queryTagCount() {
  try {
    await ensureAuthenticated();
    const payload = JSON.parse(el('queryTagCount').value || '{}');
    const data = await requestJson('/query/tags-count', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    renderResult(data);
  } catch (error) {
    renderResult({ error: error.message });
  }
}

async function querySpecies() {
  try {
    await ensureAuthenticated();
    const species = el('querySpecies').value.trim();
    if (!species) throw new Error('Species is required.');
    const data = await requestJson('/query/species', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ species }),
    });
    renderResult(data);
  } catch (error) {
    renderResult({ error: error.message });
  }
}

async function queryThumbnail() {
  try {
    await ensureAuthenticated();
    const thumbnailUrl = el('queryThumbnail').value.trim();
    if (!thumbnailUrl) throw new Error('Thumbnail URL is required.');
    const data = await requestJson('/query/thumbnail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thumbnailUrl }),
    });
    renderResult(data);
  } catch (error) {
    renderResult({ error: error.message });
  }
}

async function queryByFile() {
  try {
    await ensureAuthenticated();
    const file = el('queryFile').files[0];
    if (!file) throw new Error('Choose a query file first.');
    const form = new FormData();
    form.append('file', file);
    const data = await requestJson('/query/by-file', {
      method: 'POST',
      body: form,
      headers: getHeaders(),
    });
    renderResult(data);
  } catch (error) {
    renderResult({ error: error.message });
  }
}

async function bulkTags() {
  try {
    await ensureAuthenticated();
    const payload = JSON.parse(el('bulkTagsPayload').value || '{}');
    const data = await requestJson('/tags/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    renderResult(data);
  } catch (error) {
    renderResult({ error: error.message });
  }
}

async function deleteFiles() {
  try {
    await ensureAuthenticated();
    const payload = JSON.parse(el('deletePayload').value || '{}');
    const data = await requestJson('/files/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    renderResult(data);
  } catch (error) {
    renderResult({ error: error.message });
  }
}

async function listFiles() {
  try {
    await ensureAuthenticated();
    const data = await requestJson('/files?limit=100&offset=0', {
      method: 'GET',
    });
    renderResult(data);
  } catch (error) {
    renderResult({ error: error.message });
  }
}

async function verifyToken() {
  try {
    await ensureAuthenticated();
    const data = await requestJson('/auth/me', { method: 'GET' });
    renderResult(data);
  } catch (error) {
    renderResult({ error: error.message });
  }
}

async function loadAuthConfig() {
  if (!state.apiBase) {
    el('authModeHint').textContent = 'Auth mode: set API Base URL to load.';
    return;
  }
  try {
    const data = await requestJson('/auth/config', { method: 'GET' });
    const mode = data.authRequired
      ? 'Cognito JWT required'
      : 'development token mode';
    el('authModeHint').textContent = `Auth mode: ${mode}`;
  } catch {
    el('authModeHint').textContent = 'Auth mode: unable to load.';
  }
}

init();
