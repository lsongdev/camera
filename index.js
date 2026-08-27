import { FilesClient } from 'https://files.lsong.org/files.js?v=503d6ca';
import { bindDialog, showDialog } from 'https://lsong.org/scripts/dom/dialog.js';
import { OAuthClient } from 'https://lsong.org/scripts/integrations/oauth.js?v=8156557';

const OAUTH_ISSUER = 'https://my.lsong.org';
const CLIENT_ID = 'client_FZhUz_8SSqUgUCjRd4DnE0yt';
const REDIRECT_URI = 'https://lsong.org/camera/';
const RESOURCE = 'https://files.lsong.org';
const platformFetch = window.fetch.bind(window);

const preview = document.querySelector('#preview');
const message = document.querySelector('#camera-message');
const shutter = document.querySelector('#shutter');
const switchCameraButton = document.querySelector('#switch-camera');
const canvas = document.querySelector('#capture');
const sheet = document.querySelector('#authorization');
const authorizeButton = document.querySelector('#authorize-button');
const accountButton = document.querySelector('#account-button');
const status = document.querySelector('#storage-status');
const photos = document.querySelector('#photos');
const toast = document.querySelector('#toast');
let stream;
let files;
let facingMode = 'environment';
let savedPhotoCount = 0;
let pendingUploadCount = 0;
const photoUrls = new Set();
const oauth = new OAuthClient({
  issuer: OAUTH_ISSUER,
  clientId: CLIENT_ID,
  redirectUri: REDIRECT_URI,
  resource: RESOURCE,
  scopes: ['openid', 'files:read', 'files:write'],
  fetch: platformFetch,
});
bindDialog(sheet);
const showAuthorization = () => showDialog(sheet, { initialFocus: authorizeButton });

async function startCamera(mode = facingMode, { exact = false } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser does not support camera access.');
  stopCamera();
  message.textContent = 'Starting camera…';
  message.hidden = false;
  switchCameraButton.disabled = true;
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { [exact ? 'exact' : 'ideal']: mode } },
    audio: false,
  });
  preview.srcObject = stream;
  await preview.play();
  facingMode = stream.getVideoTracks()[0]?.getSettings().facingMode === 'user' ? 'user' : mode;
  preview.classList.toggle('mirrored', facingMode === 'user');
  message.hidden = true;
  shutter.disabled = !files;
  switchCameraButton.disabled = false;
}

async function capturePhoto() {
  try {
    if (!files) return showAuthorization();
    canvas.width = preview.videoWidth;
    canvas.height = preview.videoHeight;
    const context = canvas.getContext('2d');
    context.save();
    if (facingMode === 'user') {
      context.translate(canvas.width, 0);
      context.scale(-1, 1);
    }
    context.drawImage(preview, 0, 0);
    context.restore();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    if (!blob) throw new Error('The photo could not be created.');
    const stamp = new Date().toISOString().replaceAll(':', '-');
    const file = new File([blob], `photo-${stamp}.jpg`, { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    photoUrls.add(url);
    const card = createPhotoCard(url, file.name);
    photos.querySelector('.empty')?.remove();
    photos.prepend(card);
    queueUpload(file, card);
  } catch (error) {
    showToast(error.message || 'Photo capture failed');
  }
}

function queueUpload(file, card) {
  if (!files) return showAuthorization();
  const client = files;
  const state = card.querySelector('.upload-state');
  card.dataset.upload = 'uploading';
  state.hidden = false;
  state.replaceChildren(spinner(), Object.assign(document.createElement('span'), { textContent: 'Uploading…' }));
  pendingUploadCount += 1;
  updateStorageStatus();
  void client.upload({ file }).then(() => {
    card.dataset.upload = 'saved';
    state.hidden = true;
    savedPhotoCount += 1;
  }).catch((error) => {
    card.dataset.upload = 'failed';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'retry-upload';
    retry.textContent = 'Retry';
    retry.addEventListener('click', () => queueUpload(file, card), { once: true });
    state.replaceChildren(Object.assign(document.createElement('span'), { textContent: 'Upload failed' }), retry);
    showToast(error.message || 'Photo upload failed');
  }).finally(() => {
    pendingUploadCount -= 1;
    updateStorageStatus();
  });
}

function createPhotoCard(url, name) {
  const card = document.createElement('figure');
  card.className = 'photo-card';
  const image = document.createElement('img');
  image.src = url;
  image.alt = name;
  image.loading = 'lazy';
  const uploadState = document.createElement('div');
  uploadState.className = 'upload-state';
  uploadState.setAttribute('role', 'status');
  uploadState.hidden = true;
  card.append(image, uploadState);
  return card;
}

function spinner() {
  const element = document.createElement('span');
  element.className = 'upload-spinner';
  element.setAttribute('aria-hidden', 'true');
  return element;
}

async function loadPhotos() {
  status.textContent = 'Loading…';
  const listing = await files.list();
  const nodes = listing.nodes.filter((node) => node.kind === 'file' && node.content_type?.startsWith('image/')).reverse();
  for (const url of photoUrls) URL.revokeObjectURL(url);
  photoUrls.clear();
  photos.replaceChildren();
  if (!nodes.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Photos you take will appear here.';
    photos.append(empty);
  } else {
    const cards = await Promise.all(nodes.map(async (node) => {
      const url = URL.createObjectURL(await files.download(node.id));
      photoUrls.add(url);
      return createPhotoCard(url, node.name);
    }));
    photos.append(...cards);
  }
  savedPhotoCount = nodes.length;
  updateStorageStatus();
}

function updateStorageStatus() {
  if (!files) {
    status.textContent = 'Not connected';
    return;
  }
  const saved = `${savedPhotoCount} photo${savedPhotoCount === 1 ? '' : 's'}`;
  const uploading = pendingUploadCount ? ` · ${pendingUploadCount} uploading` : '';
  status.textContent = `${saved}${uploading} · Files connected`;
}

async function switchCamera() {
  const previousMode = facingMode;
  const nextMode = previousMode === 'environment' ? 'user' : 'environment';
  try {
    await startCamera(nextMode, { exact: true });
  } catch (error) {
    showToast(error.name === 'OverconstrainedError' ? 'No other camera is available' : (error.message || 'Could not switch camera'));
    await startCamera(previousMode).catch((restartError) => {
      message.textContent = restartError.message || 'Camera unavailable';
    });
  }
}

function stopCamera() {
  stream?.getTracks().forEach((track) => track.stop());
  stream = undefined;
  preview.srcObject = null;
}

function showToast(text) {
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.hidden = true; }, 3500);
}

authorizeButton.addEventListener('click', () => oauth.authorize().catch((error) => showToast(error.message)));
shutter.addEventListener('click', capturePhoto);
switchCameraButton.addEventListener('click', switchCamera);
accountButton.addEventListener('click', () => {
  oauth.clear();
  files = null;
  shutter.disabled = true;
  accountButton.hidden = true;
  updateStorageStatus();
  showAuthorization();
});
window.addEventListener('pagehide', stopCamera);

try {
  await oauth.completeAuthorization();
  const token = oauth.getAccessToken();
  if (token) {
    files = new FilesClient({ token, fetch: platformFetch });
    accountButton.hidden = false;
    await loadPhotos();
  } else {
    showAuthorization();
  }
} catch (error) {
  oauth.clear();
  showToast(error.message || 'Files authorization failed');
  showAuthorization();
}
startCamera().catch((error) => { message.textContent = error.message; });
