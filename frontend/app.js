const el = (id) => document.getElementById(id);

const state = {
  apiBase: localStorage.getItem("apiBase") || "",
  token: localStorage.getItem("token") || "",
  cognitoDomain: localStorage.getItem("cognitoDomain") || "",
  cognitoClientId: localStorage.getItem("cognitoClientId") || "",
  redirectUri: localStorage.getItem("redirectUri") || `${window.location.origin}/`,
};

function init() {
  el("apiBase").value = state.apiBase;
  el("token").value = state.token;
  el("cognitoDomain").value = state.cognitoDomain;
  el("cognitoClientId").value = state.cognitoClientId;
  el("redirectUri").value = state.redirectUri;

  el("apiBase").addEventListener("input", () => {
    state.apiBase = el("apiBase").value.trim();
    localStorage.setItem("apiBase", state.apiBase);
    loadAuthConfig();
  });

  el("token").addEventListener("input", () => {
    state.token = el("token").value.trim();
    localStorage.setItem("token", state.token);
  });
  el("cognitoDomain").addEventListener("input", () => {
    state.cognitoDomain = el("cognitoDomain").value.trim();
    localStorage.setItem("cognitoDomain", state.cognitoDomain);
  });
  el("cognitoClientId").addEventListener("input", () => {
    state.cognitoClientId = el("cognitoClientId").value.trim();
    localStorage.setItem("cognitoClientId", state.cognitoClientId);
  });
  el("redirectUri").addEventListener("input", () => {
    state.redirectUri = el("redirectUri").value.trim();
    localStorage.setItem("redirectUri", state.redirectUri);
  });

  el("loginBtn").addEventListener("click", mockLogin);
  el("verifyTokenBtn").addEventListener("click", verifyToken);
  el("logoutBtn").addEventListener("click", logout);
  el("uploadBtn").addEventListener("click", uploadFile);
  el("queryTagCountBtn").addEventListener("click", queryTagCount);
  el("querySpeciesBtn").addEventListener("click", querySpecies);
  el("queryThumbnailBtn").addEventListener("click", queryThumbnail);
  el("queryFileBtn").addEventListener("click", queryByFile);
  el("bulkTagsBtn").addEventListener("click", bulkTags);
  el("deleteBtn").addEventListener("click", deleteFiles);
  el("listFilesBtn").addEventListener("click", listFiles);

  absorbTokenFromCallback();
  loadAuthConfig();
}

function mockLogin() {
  const domain = state.cognitoDomain.trim();
  const clientId = state.cognitoClientId.trim();
  const redirectUri = state.redirectUri.trim() || `${window.location.origin}/`;
  if (!domain || !clientId) {
    renderResult({ error: "Cognito domain and client ID are required." });
    return;
  }
  const loginUrl = `https://${domain}/login?response_type=token&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  window.location.href = loginUrl;
}

function logout() {
  const domain = state.cognitoDomain.trim();
  const clientId = state.cognitoClientId.trim();
  const logoutRedirect = state.redirectUri.trim() || `${window.location.origin}/`;
  state.token = "";
  el("token").value = "";
  localStorage.removeItem("token");
  const details = { message: "Logged out (local token cleared)." };
  if (domain && clientId) {
    const logoutUrl = `https://${domain}/logout?client_id=${encodeURIComponent(clientId)}&logout_uri=${encodeURIComponent(logoutRedirect)}`;
    details.logoutUrl = logoutUrl;
  }
  renderResult(details);
}

function getHeaders() {
  const headers = { Accept: "application/json" };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  return headers;
}

function buildUrl(path) {
  if (!state.apiBase) {
    throw new Error("Set API Base URL first.");
  }
  return `${state.apiBase.replace(/\/$/, "")}${path}`;
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
    throw new Error(`${response.status} ${response.statusText}: ${JSON.stringify(data)}`);
  }
  return data;
}

function renderResult(data) {
  el("resultBox").textContent = JSON.stringify(data, null, 2);
  renderGallery(data);
}

function renderGallery(data) {
  const gallery = el("gallery");
  gallery.innerHTML = "";
  const urls = extractUrls(data);
  urls.forEach((url) => {
    const img = document.createElement("img");
    img.src = url;
    img.alt = "thumbnail";
    img.loading = "lazy";
    gallery.appendChild(img);
  });
}

function extractUrls(data) {
  const maybeUrls = [];
  const walk = (value) => {
    if (typeof value === "string" && /^https?:\/\//.test(value) && /\.(jpg|jpeg|png|webp)$/i.test(value)) {
      maybeUrls.push(value);
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(walk);
    }
  };
  walk(data);
  return [...new Set(maybeUrls)];
}

async function uploadFile() {
  try {
    const file = el("uploadFile").files[0];
    if (!file) throw new Error("Choose a file first.");
    const form = new FormData();
    form.append("file", file);
    const data = await requestJson("/upload", {
      method: "POST",
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
    const payload = JSON.parse(el("queryTagCount").value || "{}");
    const data = await requestJson("/query/tags-count", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    renderResult(data);
  } catch (error) {
    renderResult({ error: error.message });
  }
}

async function querySpecies() {
  try {
    const species = el("querySpecies").value.trim();
    if (!species) throw new Error("Species is required.");
    const data = await requestJson("/query/species", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ species }),
    });
    renderResult(data);
  } catch (error) {
    renderResult({ error: error.message });
  }
}

async function queryThumbnail() {
  try {
    const thumbnailUrl = el("queryThumbnail").value.trim();
    if (!thumbnailUrl) throw new Error("Thumbnail URL is required.");
    const data = await requestJson("/query/thumbnail", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thumbnailUrl }),
    });
    renderResult(data);
  } catch (error) {
    renderResult({ error: error.message });
  }
}

async function queryByFile() {
  try {
    const file = el("queryFile").files[0];
    if (!file) throw new Error("Choose a query file first.");
    const form = new FormData();
    form.append("file", file);
    const data = await requestJson("/query/by-file", {
      method: "POST",
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
    const payload = JSON.parse(el("bulkTagsPayload").value || "{}");
    const data = await requestJson("/tags/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    renderResult(data);
  } catch (error) {
    renderResult({ error: error.message });
  }
}

async function deleteFiles() {
  try {
    const payload = JSON.parse(el("deletePayload").value || "{}");
    const data = await requestJson("/files/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    renderResult(data);
  } catch (error) {
    renderResult({ error: error.message });
  }
}

async function listFiles() {
  try {
    const data = await requestJson("/files?limit=100&offset=0", {
      method: "GET",
    });
    renderResult(data);
  } catch (error) {
    renderResult({ error: error.message });
  }
}

async function verifyToken() {
  try {
    const data = await requestJson("/auth/me", { method: "GET" });
    renderResult(data);
  } catch (error) {
    renderResult({ error: error.message });
  }
}

async function loadAuthConfig() {
  if (!state.apiBase) {
    el("authModeHint").textContent = "Auth mode: set API Base URL to load.";
    return;
  }
  try {
    const data = await requestJson("/auth/config", { method: "GET" });
    const mode = data.authRequired ? "Cognito JWT required" : "development token mode";
    el("authModeHint").textContent = `Auth mode: ${mode}`;
  } catch {
    el("authModeHint").textContent = "Auth mode: unable to load.";
  }
}

function absorbTokenFromCallback() {
  const hash = window.location.hash || "";
  if (!hash.startsWith("#")) return;
  const params = new URLSearchParams(hash.slice(1));
  const idToken = params.get("id_token");
  const accessToken = params.get("access_token");
  if (!idToken && !accessToken) return;
  state.token = idToken || accessToken;
  el("token").value = state.token;
  localStorage.setItem("token", state.token);
  window.history.replaceState({}, document.title, window.location.pathname + window.location.search);
  el("tokenHint").textContent = "Hosted UI callback token captured automatically.";
}

init();
