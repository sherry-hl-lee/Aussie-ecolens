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
 * @param {{ limit?: number, offset?: number }} [params]
 */
export function listFiles(token, { limit = 100, offset = 0 } = {}) {
  return apiRequest(`/files?limit=${limit}&offset=${offset}`, { token });
}

/**
 * @param {File} file
 * @param {string} token
 * @returns {Promise<{ deduplicated: boolean, item: object }>}
 */
export function uploadFile(file, token) {
  const form = new FormData();
  form.append('file', file);
  return apiRequest('/upload', { method: 'POST', body: form, token });
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

/**
 * @param {string} token
 */
export function listNotificationSubscriptions(token) {
  return jsonRequest('/notifications/subscriptions', { method: 'GET', token });
}

/**
 * @param {{ tags: string[], email?: string }} payload
 * @param {string} token
 */
export function subscribeNotifications(payload, token) {
  return jsonRequest('/notifications/subscribe', { method: 'POST', payload, token });
}

/**
 * @param {{ tags: string[] }} payload
 * @param {string} token
 */
export function unsubscribeNotifications(payload, token) {
  return jsonRequest('/notifications/unsubscribe', { method: 'POST', payload, token });
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
