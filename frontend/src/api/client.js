/**
 * REST client for Aussie EcoLens API.
 * Migrated from prototype app.js — use with Cognito id token from AuthContext.
 */

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

export function getApiBaseUrl() {
  return API_BASE;
}

export function isApiConfigured() {
  return Boolean(API_BASE);
}

function buildUrl(path) {
  if (!API_BASE) {
    throw new ApiError('VITE_API_BASE_URL is not set. Copy .env.example to .env.', 0, null);
  }
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE}${normalized}`;
}

/**
 * @param {string} path
 * @param {object} options
 * @param {string} [options.method]
 * @param {BodyInit|null} [options.body]
 * @param {string|null} [options.token] Bearer token (Cognito id token or dev token)
 * @param {Record<string, string>} [options.headers] Extra headers (e.g. Content-Type for JSON)
 */
export async function apiRequest(path, options = {}) {
  const { method = 'GET', body = null, token = null, headers: extraHeaders = {} } = options;

  const headers = { Accept: 'application/json', ...extraHeaders };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(buildUrl(path), { method, body, headers });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new ApiError(
      `${response.status} ${response.statusText}`,
      response.status,
      data,
    );
  }

  return data;
}

function jsonRequest(path, { method = 'GET', payload, token } = {}) {
  return apiRequest(path, {
    method,
    token,
    headers: { 'Content-Type': 'application/json' },
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
}

/** @returns {Promise<{ authRequired: boolean, cognitoRegion: string, userPoolId: string, appClientIdConfigured: boolean }>} */
export function getAuthConfig() {
  return apiRequest('/auth/config');
}

/** @returns {Promise<{ authenticated: boolean, claims: object }>} */
export function getAuthMe(token) {
  return apiRequest('/auth/me', { token });
}

/**
 * @param {string} token
 * @param {{ limit?: number, offset?: number, checksum?: string }} [params]
 */
export function listFiles(token, { limit = 100, offset = 0, checksum } = {}) {
  const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (checksum) qs.set('checksum', checksum);
  return apiRequest(`/files?${qs}`, { token });
}

function isPresignedUploadApi() {
  const mode = (import.meta.env.VITE_UPLOAD_MODE || '').toLowerCase();
  if (mode === 'local') return false;
  if (mode === 'presigned' || mode === 'aws') return true;
  if (!API_BASE) return false;
  if (/localhost|127\.0\.0\.1|:8001\b/.test(API_BASE)) return false;
  return API_BASE.includes('execute-api.amazonaws.com') || API_BASE.includes('amazonaws.com');
}

/** @returns {'presigned' | 'multipart'} */
export function getUploadMode() {
  return isPresignedUploadApi() ? 'presigned' : 'multipart';
}

async function sha256Hex(file) {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollProcessedItem(token, checksum, { maxAttempts = 45, intervalMs = 2000 } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const data = await listFiles(token, { checksum, limit: 1, offset: 0 });
    const item = data.items?.[0];
    if (item) return item;
    await sleep(intervalMs);
  }
  throw new ApiError(
    'Upload reached storage but processing is still running. Refresh the gallery in a few seconds.',
    408,
    { checksum },
  );
}

async function uploadViaPresignedUrl(file, token) {
  const checksum = await sha256Hex(file);
  const existing = await listFiles(token, { checksum, limit: 1, offset: 0 });
  if (existing.items?.[0]) {
    return { deduplicated: true, item: existing.items[0] };
  }

  const safeName = `${checksum.slice(0, 12)}_${(file.name || 'upload.bin').replace(/\s+/g, '_')}`;
  const contentType = file.type || 'application/octet-stream';

  const presign = await jsonRequest('/upload', {
    method: 'POST',
    payload: { filename: safeName, contentType },
    token,
  });

  if (!presign.uploadUrl) {
    throw new ApiError('Upload URL missing from API response.', 500, presign);
  }

  const putHeaders = { ...(presign.headers || {}), 'Content-Type': contentType };
  let putResp;
  try {
    putResp = await fetch(presign.uploadUrl, { method: 'PUT', body: file, headers: putHeaders });
  } catch (err) {
    throw new ApiError(
      'Direct S3 upload failed (network/CORS). Ask Member A to enable S3 bucket CORS for this origin.',
      0,
      { cause: err?.message },
    );
  }

  if (!putResp.ok) {
    const text = await putResp.text();
    throw new ApiError(`S3 upload failed (${putResp.status}).`, putResp.status, { raw: text });
  }

  const item = await pollProcessedItem(token, checksum);
  return { deduplicated: false, item };
}

async function uploadViaMultipart(file, token) {
  const form = new FormData();
  form.append('file', file);
  return apiRequest('/upload', { method: 'POST', body: form, token });
}

/**
 * @param {File} file
 * @param {string} token
 * @returns {Promise<{ deduplicated: boolean, item: object }>}
 */
export async function uploadFile(file, token) {
  if (isPresignedUploadApi()) {
    return uploadViaPresignedUrl(file, token);
  }
  return uploadViaMultipart(file, token);
}

/**
 * @param {Record<string, number>} payload e.g. { koala: 2, magpie: 1 }
 * @param {string} token
 */
export function queryTagsCount(payload, token) {
  return jsonRequest('/query/tags-count', { method: 'POST', payload, token });
}

/**
 * @param {string} species
 * @param {string} token
 */
export function querySpecies(species, token) {
  return jsonRequest('/query/species', {
    method: 'POST',
    payload: { species },
    token,
  });
}

/**
 * @param {string} thumbnailUrl
 * @param {string} token
 */
export function queryThumbnail(thumbnailUrl, token) {
  return jsonRequest('/query/thumbnail', {
    method: 'POST',
    payload: { thumbnailUrl },
    token,
  });
}

/**
 * @param {File} file Query file (not stored permanently on server)
 * @param {string} token
 */
export function queryByFile(file, token) {
  const form = new FormData();
  form.append('file', file);
  return apiRequest('/query/by-file', { method: 'POST', body: form, token });
}

/**
 * @param {{ urls: string[], tags: string[], operation: 0 | 1 }} payload
 * @param {string} token
 */
export function bulkTags(payload, token) {
  return jsonRequest('/tags/bulk', { method: 'POST', payload, token });
}

/**
 * @param {{ urls: string[] }} payload
 * @param {string} token
 */
export function deleteFiles(payload, token) {
  return jsonRequest('/files/delete', { method: 'POST', payload, token });
}

/** Extract display URLs from API responses (thumbnails for images). */
export function extractThumbnailUrls(data) {
  const urls = [];
  const walk = (value) => {
    if (typeof value === 'string' && /^https?:\/\//.test(value) && /\.(jpg|jpeg|png|webp)$/i.test(value)) {
      urls.push(value);
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(walk);
    }
  };
  walk(data);
  return [...new Set(urls)];
}

/** Normalize list responses to media items. */
export function normalizeMediaItems(data) {
  if (Array.isArray(data?.items)) {
    return data.items;
  }
  if (data?.item) {
    return [data.item];
  }
  return [];
}
