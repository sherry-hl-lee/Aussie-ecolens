import { fetchAuthSession, signOut } from 'aws-amplify/auth';
import './amplifyConfig.js';
import { Hub } from 'aws-amplify/utils';

const el = (id) => document.getElementById(id);

const defaultApiBase = import.meta.env.VITE_API_BASE_URL || '';

function readApiBase() {
  const stored = localStorage.getItem('apiBase');
  if (stored && stored.trim()) return stored.trim();
  return defaultApiBase;
}

const state = {
  apiBase: readApiBase(),
  token: localStorage.getItem('token') || '',
  userEmail: '',
};

function cognitoDomain() {
  return (import.meta.env.VITE_COGNITO_DOMAIN || '')
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
}

function redirectUri() {
  return (
    import.meta.env.VITE_COGNITO_REDIRECT_URI?.trim() ||
    `${window.location.origin}${window.location.pathname}`
  );
}

function isValidJwt(token) {
  return typeof token === 'string' && token.split('.').length === 3;
}

function applyToken(idToken, sourceLabel) {
  state.token = idToken;
  state.userEmail = emailFromJwt(idToken) || 'Signed in';
  el('token').value = idToken;
  localStorage.setItem('token', idToken);
  updateAuthStatus();
  updateProtectedUi();
  el('tokenHint').textContent = sourceLabel;
}

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
    if (
      payload.event === 'signedIn' ||
      payload.event === 'tokenRefresh' ||
      payload.event === 'signInWithRedirect'
    ) {
      refreshAuthState();
    }
    if (payload.event === 'signedOut') {
      clearLocalAuth();
    }
  });

  bootstrapAuth();
}

async function login() {
  const domain = cognitoDomain();
  const clientId = import.meta.env.VITE_COGNITO_USER_POOL_CLIENT_ID;
  const uri = redirectUri();
  if (!domain || !clientId) {
    renderResult({ error: 'Missing Cognito settings in frontend/.env' });
    return;
  }
  // Hosted UI implicit flow: Cognito returns #id_token=... in the URL hash.
  // (Implicit grant must be enabled on your app client — yours is.)
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'token',
    scope: 'openid email profile',
    redirect_uri: uri,
  });
  window.location.href = `https://${domain}/login?${params.toString()}`;
}

async function logout() {
  clearLocalAuth();
  try {
    await signOut();
  } catch {
    /* Amplify session may be empty when using implicit Hosted UI */
  }
  const domain = cognitoDomain();
  const clientId = import.meta.env.VITE_COGNITO_USER_POOL_CLIENT_ID;
  const uri = redirectUri();
  if (domain && clientId) {
    const params = new URLSearchParams({
      client_id: clientId,
      logout_uri: uri,
    });
    window.location.href = `https://${domain}/logout?${params.toString()}`;
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

function hasOAuthCallbackParams() {
  const params = new URLSearchParams(window.location.search);
  return params.has('code') || params.has('error');
}

function clearOAuthParamsFromUrl() {
  if (!hasOAuthCallbackParams()) return;
  window.history.replaceState({}, document.title, window.location.pathname);
}

function emailFromJwt(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.email || payload['cognito:username'] || '';
  } catch {
    return '';
  }
}

function absorbTokensFromHash() {
  const hash = window.location.hash || '';
  if (!hash.startsWith('#')) return false;
  const params = new URLSearchParams(hash.slice(1));
  if (params.get('error')) {
    el('tokenHint').textContent = `Cognito error: ${params.get('error_description') || params.get('error')}`;
    window.history.replaceState({}, document.title, window.location.pathname);
    return false;
  }
  const idToken = params.get('id_token');
  const accessToken = params.get('access_token');
  if (!idToken && !accessToken) return false;

  applyToken(
    idToken || accessToken,
    'Signed in via Cognito Hosted UI. ID token ready for API calls.',
  );
  window.history.replaceState({}, document.title, window.location.pathname);
  return true;
}

async function waitForAmplifySession(maxAttempts = 20) {
  for (let i = 0; i < maxAttempts; i += 1) {
    try {
      const session = await fetchAuthSession({ forceRefresh: true });
      const idToken = session.tokens?.idToken?.toString();
      if (idToken) {
        applyToken(idToken, 'Signed in via Amplify (authorization code flow).');
        return true;
      }
    } catch {
      /* retry */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

async function bootstrapAuth() {
  el('tokenHint').textContent = 'Checking sign-in status…';

  if (!import.meta.env.VITE_COGNITO_USER_POOL_ID) {
    el('tokenHint').textContent =
      'Missing Cognito config in frontend/.env — restart npm run dev after editing.';
    updateAuthStatus();
    updateProtectedUi();
    return;
  }

  // 1) Implicit flow callback (#id_token=...) — do NOT call refreshAuthState after (it would clear the token).
  if (absorbTokensFromHash()) {
    loadAuthConfig();
    return;
  }

  // 2) Restore a previously saved token from localStorage.
  if (isValidJwt(state.token)) {
    applyToken(
      state.token,
      'Restored ID token from browser storage.',
    );
    loadAuthConfig();
    return;
  }

  // 3) Authorization-code callback (?code=...) — wait for Amplify OAuth listener.
  if (hasOAuthCallbackParams()) {
    const params = new URLSearchParams(window.location.search);
    if (params.get('error')) {
      el('tokenHint').textContent = `Cognito error: ${params.get('error_description') || params.get('error')}`;
      clearOAuthParamsFromUrl();
      updateAuthStatus();
      updateProtectedUi();
      loadAuthConfig();
      return;
    }
    const ok = await waitForAmplifySession();
    clearOAuthParamsFromUrl();
    if (!ok) {
      el('tokenHint').textContent =
        'Sign-in callback received but token exchange failed. Try Sign in again.';
      updateAuthStatus();
      updateProtectedUi();
    }
    loadAuthConfig();
    return;
  }

  await refreshAuthState();
  loadAuthConfig();
}

async function refreshAuthState() {
  try {
    const session = await fetchAuthSession();
    const idToken = session.tokens?.idToken?.toString();
    if (idToken) {
      applyToken(idToken, 'ID token from Amplify session.');
      return;
    }

    // Keep a valid token we already have (e.g. from implicit Hosted UI).
    if (isValidJwt(state.token)) {
      state.userEmail = emailFromJwt(state.token) || state.userEmail || 'Signed in';
      updateAuthStatus();
      updateProtectedUi();
      el('tokenHint').textContent = 'Using saved Cognito ID token.';
      return;
    }

    state.token = '';
    state.userEmail = '';
    updateAuthStatus();
    updateProtectedUi();
    el('tokenHint').textContent = 'Not signed in. Click Sign in (Hosted UI).';
  } catch (error) {
    if (isValidJwt(state.token)) {
      state.userEmail = emailFromJwt(state.token) || 'Signed in';
      updateAuthStatus();
      updateProtectedUi();
      el('tokenHint').textContent = 'Using saved Cognito ID token.';
      return;
    }
    state.token = '';
    state.userEmail = '';
    updateAuthStatus();
    updateProtectedUi();
    el('tokenHint').textContent = `Auth error: ${error.message || error}`;
  }
}

function updateAuthStatus() {
  const statusEl = el('authStatus');
  if (state.token) {
    statusEl.textContent = state.userEmail
      ? `Signed in as ${state.userEmail}`
      : 'Signed in';
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
  if (isValidJwt(state.token)) return;
  await refreshAuthState();
  if (!isValidJwt(state.token)) {
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
    el('authModeHint').textContent =
      'Auth mode: set API Base URL (e.g. http://localhost:8001) and start the backend.';
    return;
  }
  try {
    const data = await requestJson('/auth/config', { method: 'GET' });
    const mode = data.authRequired
      ? 'Cognito JWT required'
      : 'development token mode';
    el('authModeHint').textContent = `Auth mode: ${mode}`;
  } catch (error) {
    el('authModeHint').textContent = `Backend unreachable at ${state.apiBase} — start backend (port 8001). Cognito login can still work.`;
    console.warn('loadAuthConfig:', error.message || error);
  }
}

init();
