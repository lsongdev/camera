const OAUTH_ISSUER = 'https://my.lsong.org';
const FILES_API = 'https://files.lsong.org/api/v1';
const CLIENT_ID = 'client_FZhUz_8SSqUgUCjRd4DnE0yt';
const REDIRECT_URI = 'https://lsong.org/camera/';
const RESOURCE = 'https://files.lsong.org';
const TOKEN_KEY = 'camera.files.token';
const TRANSACTION_KEY = 'camera.oauth.transaction';

const preview = document.querySelector('#preview');
const message = document.querySelector('#camera-message');
const shutter = document.querySelector('#shutter');
const canvas = document.querySelector('#capture');
const sheet = document.querySelector('#authorization');
const authorizeButton = document.querySelector('#authorize-button');
const accountButton = document.querySelector('#account-button');
const status = document.querySelector('#storage-status');
const photos = document.querySelector('#photos');
const toast = document.querySelector('#toast');
let stream;
let files;
let photoUrls = [];

class FilesClient {
  constructor(token) { this.token = token; }
  async api(path, init = {}) {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.token}`);
    headers.set('Accept', 'application/json');
    const response = await fetch(`${FILES_API}${path}`, { ...init, headers });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error?.message || `Files API returned ${response.status}`);
    }
    return response.status === 204 ? undefined : (await response.json()).data;
  }
  list() { return this.api('/nodes?parent_id=root'); }
  async upload(file) {
    const session = await this.api('/uploads', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent_id: 'root', name: file.name, size: file.size, content_type: file.type }),
    });
    const sent = await fetch(session.request.url, {
      method: session.request.method, headers: session.request.headers, body: file,
    });
    if (!sent.ok) throw new Error(`Photo transfer failed (${sent.status})`);
    return this.api(`/uploads/${encodeURIComponent(session.id)}/complete`, { method: 'POST' });
  }
  async download(id) {
    const { request } = await this.api(`/files/${encodeURIComponent(id)}/download-url`);
    const response = await fetch(request.url, { method: request.method, headers: request.headers });
    if (!response.ok) throw new Error(`Photo download failed (${response.status})`);
    return response.blob();
  }
}

function base64Url(bytes) {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

async function beginAuthorization() {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(64)));
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const state = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  sessionStorage.setItem(TRANSACTION_KEY, JSON.stringify({ verifier, state, createdAt: Date.now() }));
  const url = new URL('/oauth/authorize', OAUTH_ISSUER);
  url.search = new URLSearchParams({
    response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
    resource: RESOURCE, scope: 'openid files:read files:write', state,
    code_challenge: challenge, code_challenge_method: 'S256',
  });
  location.assign(url);
}

async function completeAuthorization() {
  const query = new URLSearchParams(location.search);
  const code = query.get('code');
  const returnedState = query.get('state');
  if (!code && !query.get('error')) return;
  const transaction = JSON.parse(sessionStorage.getItem(TRANSACTION_KEY) || 'null');
  sessionStorage.removeItem(TRANSACTION_KEY);
  history.replaceState(null, '', location.pathname);
  if (query.get('error')) throw new Error(query.get('error_description') || 'Authorization was cancelled.');
  if (!transaction || transaction.state !== returnedState || Date.now() - transaction.createdAt > 10 * 60_000) {
    throw new Error('The authorization response could not be verified. Please try again.');
  }
  const response = await fetch(`${OAUTH_ISSUER}/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
      code, code_verifier: transaction.verifier, resource: RESOURCE,
    }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error_description || 'Token exchange failed.');
  sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ accessToken: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 }));
}

function accessToken() {
  const stored = JSON.parse(sessionStorage.getItem(TOKEN_KEY) || 'null');
  if (!stored || stored.expiresAt <= Date.now() + 15_000) return null;
  return stored.accessToken;
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser does not support camera access.');
  stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  preview.srcObject = stream;
  await preview.play();
  message.hidden = true;
  shutter.disabled = !files;
}

async function capturePhoto() {
  shutter.disabled = true;
  try {
    canvas.width = preview.videoWidth;
    canvas.height = preview.videoHeight;
    canvas.getContext('2d').drawImage(preview, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    if (!blob) throw new Error('The photo could not be created.');
    const stamp = new Date().toISOString().replaceAll(':', '-');
    await files.upload(new File([blob], `photo-${stamp}.jpg`, { type: 'image/jpeg' }));
    showToast('Photo saved to Files');
    await loadPhotos();
  } catch (error) {
    showToast(error.message || 'Photo upload failed');
  } finally {
    shutter.disabled = false;
  }
}

async function loadPhotos() {
  status.textContent = 'Loading…';
  const listing = await files.list();
  const nodes = listing.nodes.filter((node) => node.kind === 'file' && node.content_type?.startsWith('image/')).reverse();
  for (const url of photoUrls) URL.revokeObjectURL(url);
  photoUrls = [];
  photos.replaceChildren();
  if (!nodes.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Photos you take will appear here.';
    photos.append(empty);
  } else {
    await Promise.all(nodes.map(async (node) => {
      const url = URL.createObjectURL(await files.download(node.id));
      photoUrls.push(url);
      const image = document.createElement('img');
      image.src = url;
      image.alt = node.name;
      image.loading = 'lazy';
      photos.append(image);
    }));
  }
  status.textContent = `${nodes.length} photo${nodes.length === 1 ? '' : 's'} · Files connected`;
}

function showToast(text) {
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.hidden = true; }, 3500);
}

authorizeButton.addEventListener('click', () => beginAuthorization().catch((error) => showToast(error.message)));
shutter.addEventListener('click', capturePhoto);
accountButton.addEventListener('click', () => {
  sessionStorage.removeItem(TOKEN_KEY);
  files = null;
  shutter.disabled = true;
  accountButton.hidden = true;
  status.textContent = 'Not connected';
  sheet.showModal();
});
window.addEventListener('pagehide', () => stream?.getTracks().forEach((track) => track.stop()));

try {
  await completeAuthorization();
  const token = accessToken();
  if (token) {
    files = new FilesClient(token);
    accountButton.hidden = false;
    await loadPhotos();
  } else {
    sheet.showModal();
  }
} catch (error) {
  sessionStorage.removeItem(TOKEN_KEY);
  showToast(error.message || 'Files authorization failed');
  sheet.showModal();
}
startCamera().catch((error) => { message.textContent = error.message; });
