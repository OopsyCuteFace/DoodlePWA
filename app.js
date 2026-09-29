'use strict';

const video = document.getElementById('camera');
const stage = document.getElementById('stage');
const overlay = document.getElementById('overlay');
const fileInput = document.getElementById('file');
const opacityInput = document.getElementById('opacity');
const lockButton = document.getElementById('lock');
const resetButton = document.getElementById('reset');
const emptyPanel = document.getElementById('empty');
const cameraError = document.getElementById('camera-error');
const cameraErrorText = document.getElementById('camera-error-text');
const cameraRetry = document.getElementById('camera-retry');

const VIEW_KEY = 'doodle:view';
const MIN_SCALE = 0.02;
const MAX_SCALE = 40;

// Where the picture sits: offset of its center from the screen center, plus size, turn and transparency.
const view = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 0.5, locked: false };
let objectUrl = null;

/* ---------- Camera ---------- */

let stream = null;

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    showCameraError("This browser can't use the camera here. The page must be opened over https.");
    return;
  }
  stopCamera();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });
    video.srcObject = stream;
    await video.play();
    cameraError.hidden = true;
  } catch (err) {
    const messages = {
      NotAllowedError: 'Camera access is blocked. Allow it for this site in Settings › Apps › Safari › Camera, then try again.',
      NotFoundError: 'No camera was found on this device.',
      NotReadableError: 'Another app is using the camera. Close it and try again.',
    };
    showCameraError(messages[err.name] || "The camera couldn't start. Try again.");
  }
}

function stopCamera() {
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
}

function cameraIsLive() {
  return stream?.getVideoTracks().some((track) => track.readyState === 'live');
}

function showCameraError(message) {
  cameraErrorText.textContent = message;
  cameraError.hidden = false;
}

cameraRetry.addEventListener('click', startCamera);

/* ---------- Keep the screen awake ---------- */

let wakeLock = null;

async function keepAwake() {
  if (!('wakeLock' in navigator) || document.visibilityState !== 'visible' || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch {
    // Not allowed right now (e.g. low power mode); try again on the next tap.
  }
}

document.addEventListener('pointerdown', keepAwake);

// iOS stops the camera and wake lock when the app goes to the background.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!cameraIsLive()) startCamera();
  keepAwake();
});

/* ---------- Drawing the picture ---------- */

function render() {
  const w = overlay.naturalWidth;
  const h = overlay.naturalHeight;
  overlay.style.transform =
    `translate(${view.x}px, ${view.y}px) rotate(${view.rotation}rad) scale(${view.scale}) translate(${-w / 2}px, ${-h / 2}px)`;
  overlay.style.opacity = view.opacity;
}

function fitToScreen() {
  const w = overlay.naturalWidth;
  const h = overlay.naturalHeight;
  if (!w || !h) return;
  view.x = 0;
  view.y = 0;
  view.rotation = 0;
  view.scale = Math.min((stage.clientWidth * 0.85) / w, (stage.clientHeight * 0.7) / h);
  render();
  saveView();
}

/* ---------- Finger gestures: drag, pinch to resize, twist to rotate ---------- */

const pointers = new Map();
let gestureStart = null;

// Called whenever a finger is added or lifted, so movement is always measured from a fresh starting point.
function beginGesture() {
  gestureStart = pointers.size
    ? { view: { ...view }, points: [...pointers.values()].slice(0, 2).map((p) => ({ ...p })) }
    : null;
}

stage.addEventListener('pointerdown', (e) => {
  if (view.locked || overlay.hidden) return;
  stage.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  beginGesture();
});

stage.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId) || !gestureStart) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  const start = gestureStart.view;
  const [a0, b0] = gestureStart.points;
  const [a, b] = [...pointers.values()];

  if (!b0) {
    view.x = start.x + (a.x - a0.x);
    view.y = start.y + (a.y - a0.y);
  } else {
    const mid0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 };
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const scale = clamp(
      start.scale * (Math.hypot(b.x - a.x, b.y - a.y) / Math.hypot(b0.x - a0.x, b0.y - a0.y)),
      MIN_SCALE,
      MAX_SCALE,
    );
    const ratio = scale / start.scale;
    const turn = Math.atan2(b.y - a.y, b.x - a.x) - Math.atan2(b0.y - a0.y, b0.x - a0.x);

    // Keep the spot between the fingers pinned under the fingers while scaling and turning.
    const cx = stage.clientWidth / 2;
    const cy = stage.clientHeight / 2;
    const vx = cx + start.x - mid0.x;
    const vy = cy + start.y - mid0.y;
    const cos = Math.cos(turn);
    const sin = Math.sin(turn);
    view.x = mid.x + (vx * cos - vy * sin) * ratio - cx;
    view.y = mid.y + (vx * sin + vy * cos) * ratio - cy;
    view.scale = scale;
    view.rotation = start.rotation + turn;
  }
  render();
});

function endPointer(e) {
  if (!pointers.delete(e.pointerId)) return;
  beginGesture();
  if (!pointers.size) saveView();
}

stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);

// Stop Safari's own pinch-zoom from taking over the page.
document.addEventListener('gesturestart', (e) => e.preventDefault());

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/* ---------- Controls ---------- */

document.querySelectorAll('[data-action="pick"]').forEach((button) => {
  button.addEventListener('click', () => fileInput.click());
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  fileInput.value = '';
  if (!file) return;
  showImage(file, { fit: true });
  saveImage(file);
});

opacityInput.addEventListener('input', () => {
  view.opacity = Number(opacityInput.value);
  render();
});
opacityInput.addEventListener('change', saveView);

resetButton.addEventListener('click', fitToScreen);

lockButton.addEventListener('click', () => {
  setLocked(!view.locked);
  saveView();
});

function setLocked(locked) {
  view.locked = locked;
  pointers.clear();
  gestureStart = null;
  document.body.classList.toggle('is-locked', locked);
  lockButton.setAttribute('aria-pressed', String(locked));
  lockButton.setAttribute('aria-label', locked ? 'Unlock picture' : 'Lock picture');
}

function showImage(blob, { fit }) {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(blob);
  overlay.onload = () => {
    overlay.hidden = false;
    emptyPanel.hidden = true;
    document.body.classList.remove('no-image');
    if (fit) fitToScreen();
    else render();
  };
  overlay.src = objectUrl;
}

/* ---------- Remembering the last picture and its position ---------- */

function saveView() {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(view));
  } catch {
    // Private browsing or storage full; the app still works, it just won't remember.
  }
}

function loadView() {
  try {
    Object.assign(view, JSON.parse(localStorage.getItem(VIEW_KEY)) || {});
  } catch {
    // Nothing saved yet.
  }
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('doodle', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('files');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveImage(blob) {
  try {
    const db = await openDb();
    db.transaction('files', 'readwrite').objectStore('files').put(blob, 'last');
  } catch {
    // Couldn't store it; it just won't be there next time.
  }
}

async function loadImage() {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const request = db.transaction('files').objectStore('files').get('last');
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  }
}

/* ---------- Start up ---------- */

async function init() {
  loadView();
  opacityInput.value = view.opacity;
  setLocked(view.locked);

  document.body.classList.add('no-image');
  const saved = await loadImage();
  if (saved) showImage(saved, { fit: false });
  else emptyPanel.hidden = false;

  startCamera();
  keepAwake();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
