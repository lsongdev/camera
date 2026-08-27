import { FilesClient } from 'https://files.lsong.org/files.js?v=bcc0ef8';
import { bindDialog, showDialog } from 'https://lsong.org/scripts/dom/dialog.js';
import { OAuthClient } from 'https://lsong.org/scripts/integrations/oauth.js?v=911764c';

const OAUTH_ISSUER = 'https://my.lsong.org';
const CLIENT_ID = 'client_FZhUz_8SSqUgUCjRd4DnE0yt';
const REDIRECT_URI = 'https://lsong.org/camera/';
const RESOURCE = 'https://files.lsong.org';

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
const oauth = new OAuthClient({
  issuer: OAUTH_ISSUER,
  clientId: CLIENT_ID,
  redirectUri: REDIRECT_URI,
  resource: RESOURCE,
  scopes: ['openid', 'files:read', 'files:write'],
});
bindDialog(sheet);
const showAuthorization = () => showDialog(sheet, { initialFocus: authorizeButton });

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
    await files.upload({ file: new File([blob], `photo-${stamp}.jpg`, { type: 'image/jpeg' }) });
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

authorizeButton.addEventListener('click', () => oauth.authorize().catch((error) => showToast(error.message)));
shutter.addEventListener('click', capturePhoto);
accountButton.addEventListener('click', () => {
  oauth.clear();
  files = null;
  shutter.disabled = true;
  accountButton.hidden = true;
  status.textContent = 'Not connected';
  showAuthorization();
});
window.addEventListener('pagehide', () => stream?.getTracks().forEach((track) => track.stop()));

try {
  await oauth.completeAuthorization();
  const token = oauth.getAccessToken();
  if (token) {
    files = new FilesClient({ token });
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
