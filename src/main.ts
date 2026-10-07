import * as THREE from "three";
import { VRButton } from "three/examples/jsm/webxr/VRButton.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { parseExtendedXYZ, type Trajectory } from "./xyzParser";
import { parseCubeVolume, type CubeVolume } from "./cubeParser";
import { symbolForAtomicNumber } from "./elements";
import { MoleculeRenderer } from "./moleculeRenderer";
import { IsosurfacePanel } from "./isosurfacePanel";
import { VRObjectManipulator } from "./vrInteraction";
import { MeasurementTool } from "./measurement";
import { ChapterHighlight } from "./chapterHighlight";
import { ChaptersPanel } from "./chaptersPanel";
import { Playback } from "./playback";
import {
  BACKGROUND_PRESETS,
  DEFAULT_BACKGROUND_ID,
  getBackgroundPreset,
  normalizeBackgroundId,
} from "./backgrounds";
import {
  CollaborationClient,
  defaultWebSocketBase,
  httpBaseFromWebSocketBase,
  makeRoomId,
  normalizeWebSocketBase,
  sanitizeRoomId,
  type PresenterState,
  type TransformState,
  type ViewState,
} from "./collaboration";
import { fetchTrajectoryBlob } from "./trajectoryFetch";
import { uploadTrajectory } from "./shareDrop";
import {
  fetchMaterialsProjectXyz,
  materialsProjectId,
  optimadeIdFromUrl,
  optimadeUrlForId,
} from "./materialsProject";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const appEl = $("app");
const uiEl = $("ui");
const statusEl = $("status");
const toggleControlsBtn = $<HTMLButtonElement>("toggleControlsBtn");
const collaborationEl = $("collaboration");
const toggleRoomBtn = $<HTMLButtonElement>("toggleRoomBtn");
const fileInput = $<HTMLInputElement>("fileInput");
const urlInput = $<HTMLInputElement>("urlInput");
// Prefill the bundled demo from wherever this page is served, not a hosted site.
if (location.protocol.startsWith("http")) urlInput.value = new URL("samples/tobe.xyz", location.href).href;
const loadUrlBtn = $<HTMLButtonElement>("loadUrlBtn");
const backgroundSelect = $<HTMLSelectElement>("backgroundSelect");
const vrEntryEl = $("vrEntry");
const isosurfaceEl = $("isosurface");
const isoListEl = $("isoList");
const isoAddBtn = $<HTMLButtonElement>("isoAddBtn");
const isoResetBtn = $<HTMLButtonElement>("isoResetBtn");
const playbackEl = $("playback");
const frameSlider = $<HTMLInputElement>("frameSlider");
const frameLabel = $("frameLabel");
const playBtn = $<HTMLButtonElement>("playBtn");
const stepBack = $<HTMLButtonElement>("stepBack");
const stepFwd = $<HTMLButtonElement>("stepFwd");
const fpsInput = $<HTMLInputElement>("fpsInput");
const roomInput = $<HTMLInputElement>("roomInput");
const userNameInput = $<HTMLInputElement>("userNameInput");
const serverInput = $<HTMLInputElement>("serverInput");
const copyRoomCodeBtn = $<HTMLButtonElement>("copyRoomCodeBtn");
const joinRoomBtn = $<HTMLButtonElement>("joinRoomBtn");
const leaveRoomBtn = $<HTMLButtonElement>("leaveRoomBtn");
const takePresenterBtn = $<HTMLButtonElement>("takePresenterBtn");
const collabStatusEl = $("collabStatus");

// Controls only the presenter (or a solo user) may operate.
const presenterControls = [
  fileInput, urlInput, loadUrlBtn, frameSlider, playBtn, stepBack, stepFwd, fpsInput, backgroundSelect,
];

// Surface otherwise-silent runtime errors in the UI status line, since most
// users testing this won't have DevTools open.
window.addEventListener("error", (e) => {
  statusEl.textContent = `Runtime error: ${e.message}`;
});
window.addEventListener("unhandledrejection", (e) => {
  statusEl.textContent = `Unhandled rejection: ${e.reason}`;
});

const defaultSceneBackground = new THREE.Color(0x111317);
const scene = new THREE.Scene();
scene.background = defaultSceneBackground;

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 1000);
camera.position.set(0, 1.5, 4);
scene.add(camera);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
appEl.appendChild(renderer.domElement);

const vrButton = VRButton.createButton(renderer);
Object.assign(vrButton.style, {
  position: "static",
  top: "auto",
  right: "auto",
  bottom: "auto",
  left: "auto",
  margin: "0",
});
vrEntryEl.appendChild(vrButton);

const orbitControls = new OrbitControls(camera, renderer.domElement);
orbitControls.target.set(0, 1, 0);
orbitControls.enableDamping = true;

scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.55));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.35);
dirLight.position.set(0, 0, 0);
dirLight.target.position.set(0, 0, -1);
camera.add(dirLight);
camera.add(dirLight.target);

const grid = new THREE.GridHelper(10, 10, 0x444444, 0x222222);
grid.position.y = 0;
scene.add(grid);

let moleculeRenderer: MoleculeRenderer | null = null;
let cubeStatusSummary = "";
let playback: Playback | null = null;
let currentTrajectoryUrl: string | null = null;
let pendingTrajectoryUrl: string | null = null;
// The most recent locally-loaded (non-URL) trajectory, kept so a presenter can
// upload it to the room's /share storage on demand. Cleared on URL loads.
let lastLocalBlob: Blob | null = null;
let lastLocalName = "";
let sharingInFlight = false;
let activeTrajectoryFetch: AbortController | null = null;
let trajectoryLoadVersion = 0;
let applyingRemoteState = false;
let pendingPresenterSync = false;
let lastPresenterSyncAt = 0;
let lastObservedTransform = "";
let lastObservedView = "";
let remoteApplyVersion = 0;
// Follower jitter buffer: instead of free-running its own playback and being
// snapped to each incoming frame (which yanks the motion), the follower buffers
// the presenter's samples and plays them out on a delayed, timestamp-scheduled
// clock so frames advance evenly and forward, immune to packet-arrival jitter.
interface FollowSample {
  srcTime: number; // presenter clock (state.updatedAt)
  frameIndex: number;
  transform: TransformState;
  view: ViewState;
}
let followBuffer: FollowSample[] = [];
let followClockOffset: number | null = null; // localNow - presenter srcTime, eased for drift
let followShownFrame = -1;
const MIN_FPS = 1;
const MAX_FPS = 60;
// Presenter broadcasts at most every 50 ms (~20/s), under the room server's
// 24/s message budget, so followers get fresh state with low latency.
const PRESENTER_SYNC_INTERVAL_MS = 50;
// Play the buffer out this far behind the presenter's clock to absorb network
// jitter (~2-3 messages). Lower = snappier/riskier, higher = smoother on bad links.
const FOLLOW_BUFFER_DELAY_MS = 120;
// Drop buffered samples older than this (keeps the queue tiny).
const FOLLOW_BUFFER_RETENTION_MS = 1000;
// Camera/transform smoothing time constant (s); these are cheap group-level
// eases (10 floats), not per-atom work.
const FOLLOW_SMOOTHING_TAU = 0.06;
// Jumps larger than these snap instead of easing (new load, big reframe).
const FOLLOW_SNAP_DISTANCE = 3;
const FOLLOW_SNAP_CAMERA_DISTANCE = 6;
// Reused scratch objects so per-frame easing doesn't allocate.
const _vt = new THREE.Vector3();
const _qt = new THREE.Quaternion();
const _st = new THREE.Vector3();
const _cp = new THREE.Vector3();
const _ot = new THREE.Vector3();

// Persistent group that VR grab/scale acts on; molecule contents are swapped
// in/out of it per file load so the manipulator/controllers only need to be
// set up once instead of accumulating duplicate listeners on every reload.
const moleculeRoot = new THREE.Group();
scene.add(moleculeRoot);

const manipulator = new VRObjectManipulator(renderer, moleculeRoot, scene);

const measurementTool = new MeasurementTool((text) => {
  statusEl.textContent = text;
});
scene.add(measurementTool.group);

// Simulation Chapters: bond-change events on the timeline, reviewed by a human.
const chapterHighlight = new ChapterHighlight();
const chaptersPanel = new ChaptersPanel({
  panelEl: $("chapters"),
  toggleBtn: $<HTMLButtonElement>("toggleChaptersBtn"),
  listEl: $("chaptersList"),
  summaryEl: $("chaptersSummary"),
  trackEl: $("chapterTrack"),
  detectBtn: $<HTMLButtonElement>("chaptersDetectBtn"),
  exportBtn: $<HTMLButtonElement>("chaptersExportBtn"),
  prevBtn: $<HTMLButtonElement>("chapterPrevBtn"),
  nextBtn: $<HTMLButtonElement>("chapterNextBtn"),
  persistInput: $<HTMLInputElement>("chaptersPersist"),
  aiBtn: $<HTMLButtonElement>("chaptersAiBtn"),
  aiEndpointInput: $<HTMLInputElement>("chaptersAiEndpoint"),
  aiModelSelect: $<HTMLSelectElement>("chaptersAiModel"),
  aiRefreshBtn: $<HTMLButtonElement>("chaptersAiRefresh"),
  aiStatusEl: $("chaptersAiStatus"),
  highlight: chapterHighlight,
  seek: (frame) => {
    if (!playback) return;
    playback.playing = false;
    syncPlayButton();
    playback.setFrame(frame);
    markPresenterStateDirty(true);
  },
  annotator: () => userNameInput.value.trim() || "anonymous",
});

// Isosurface controls (shown only for cube files). Idle status restores the
// cube's "Loaded …" summary once extraction finishes.
const isoPanel = new IsosurfacePanel({
  panelEl: isosurfaceEl,
  listEl: isoListEl,
  addBtn: isoAddBtn,
  resetBtn: isoResetBtn,
  parent: moleculeRoot,
  onStatus: (text) => {
    statusEl.textContent = text || cubeStatusSummary;
  },
  onChange: () => markPresenterStateDirty(),
});

const raycaster = new THREE.Raycaster();
const tempMatrix = new THREE.Matrix4();
const pointerNdc = new THREE.Vector2();
const CLICK_SELECT_MAX_DRIFT_PX = 5;
let pointerSelectStart: { pointerId: number; x: number; y: number } | null = null;

function setupSelectionRaycast(controller: THREE.Group) {
  controller.addEventListener("select" as keyof THREE.Object3DEventMap, () => {
    if (!moleculeRenderer) return;
    tempMatrix.identity().extractRotation(controller.matrixWorld);
    raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);
    measurementTool.raycastSelect(raycaster, moleculeRenderer);
  });
}

for (const controller of manipulator.getControllers()) {
  setupSelectionRaycast(controller);
}

const USER_NAME_KEY = "gearsxr-user-name";
const SERVER_BASE_KEY = "gearsxr-server-base";
const BACKGROUND_KEY = "gearsxr-background";
const CONTROLS_COLLAPSED_KEY = "gearsxr-controls-collapsed";
const ROOM_COLLAPSED_KEY = "gearsxr-room-collapsed";

const urlParams = new URLSearchParams(location.search);
const backgroundFromUrl = urlParams.get("background");
let currentBackgroundId = normalizeBackgroundId(
  backgroundFromUrl ?? localStorage.getItem(BACKGROUND_KEY) ?? DEFAULT_BACKGROUND_ID,
);
let appliedBackgroundId = "";
let backgroundLoadVersion = 0;
const backgroundLoader = new THREE.TextureLoader();
const backgroundTextures = new Map<string, THREE.Texture>();

for (const preset of BACKGROUND_PRESETS) {
  const option = document.createElement("option");
  option.value = preset.id;
  option.textContent = preset.label;
  backgroundSelect.appendChild(option);
}
backgroundSelect.value = currentBackgroundId;

function setControlsCollapsed(collapsed: boolean) {
  uiEl.classList.toggle("collapsed", collapsed);
  toggleControlsBtn.textContent = collapsed ? "Show" : "Hide";
  toggleControlsBtn.setAttribute("aria-expanded", String(!collapsed));
  localStorage.setItem(CONTROLS_COLLAPSED_KEY, collapsed ? "1" : "0");
}

function setRoomCollapsed(collapsed: boolean) {
  collaborationEl.classList.toggle("collapsed", collapsed);
  toggleRoomBtn.textContent = collapsed ? "Show" : "Hide";
  toggleRoomBtn.setAttribute("aria-expanded", String(!collapsed));
  localStorage.setItem(ROOM_COLLAPSED_KEY, collapsed ? "1" : "0");
}

setControlsCollapsed(localStorage.getItem(CONTROLS_COLLAPSED_KEY) === "1");
setRoomCollapsed(localStorage.getItem(ROOM_COLLAPSED_KEY) !== "0");

const roomFromUrl = sanitizeRoomId(urlParams.get("room") ?? "");
roomInput.value = roomFromUrl.length >= 3 ? roomFromUrl : makeRoomId();
userNameInput.value = localStorage.getItem(USER_NAME_KEY) ?? `User ${Math.floor(1000 + Math.random() * 9000)}`;
serverInput.value = normalizeWebSocketBase(
  urlParams.get("server") ?? localStorage.getItem(SERVER_BASE_KEY) ?? defaultWebSocketBase()
);

const collaboration = new CollaborationClient({
  onSnapshot: (message) => {
    updateCollaborationUi();
    if (collaboration.isPresenter()) {
      markPresenterStateDirty(true);
      void ensureLocalTrajectoryShared();
    } else {
      void applyRemotePresenterState(message.state);
    }
  },
  onPresence: () => updateCollaborationUi(),
  onPresenterState: (message) => {
    if (message.senderId !== collaboration.selfId) {
      void applyRemotePresenterState(message.state);
    }
  },
  onPresenterChanged: () => {
    updateCollaborationUi();
    if (collaboration.isPresenter()) {
      markPresenterStateDirty(true);
      void ensureLocalTrajectoryShared();
    }
  },
  onConnectionStatus: () => updateCollaborationUi(),
  onError: (message) => {
    collabStatusEl.textContent = `Room error: ${message}`;
  },
});

function signature(...values: number[]) {
  return values.map((value) => value.toFixed(5)).join(",");
}

function objectTransformSignature(object: THREE.Object3D) {
  const { position: p, quaternion: q, scale: s } = object;
  return signature(p.x, p.y, p.z, q.x, q.y, q.z, q.w, s.x, s.y, s.z);
}

function currentViewSignature() {
  const { position: p } = camera;
  const { target: t } = orbitControls;
  return signature(p.x, p.y, p.z, t.x, t.y, t.z);
}

function getMoleculeTransform(): TransformState {
  return {
    position: moleculeRoot.position.toArray() as [number, number, number],
    quaternion: moleculeRoot.quaternion.toArray() as [number, number, number, number],
    scale: moleculeRoot.scale.toArray() as [number, number, number],
  };
}

function getViewState(): ViewState {
  return {
    cameraPosition: camera.position.toArray() as [number, number, number],
    orbitTarget: orbitControls.target.toArray() as [number, number, number],
  };
}

function clampFps(value: number) {
  return Math.min(MAX_FPS, Math.max(MIN_FPS, Math.round(value)));
}

function readFpsInput() {
  const value = Number.parseFloat(fpsInput.value);
  return Number.isFinite(value) ? clampFps(value) : 15;
}

function syncPlayButton() {
  playBtn.textContent = playback?.playing ? "Pause" : "Play";
}

function applyFpsInput(commit = false) {
  if (!playback) return;
  const parsed = Number.parseFloat(fpsInput.value);
  if (!Number.isFinite(parsed)) {
    if (commit) fpsInput.value = String(playback.fps);
    return;
  }
  playback.fps = clampFps(parsed);
  if (commit) fpsInput.value = String(playback.fps);
  markPresenterStateDirty(true);
}

async function setSceneBackground(
  backgroundId: string,
  options: { broadcastState?: boolean; persist?: boolean } = {},
) {
  const { broadcastState = true, persist = true } = options;
  const nextBackgroundId = normalizeBackgroundId(backgroundId);

  if (persist) {
    localStorage.setItem(BACKGROUND_KEY, nextBackgroundId);
  }
  if (currentBackgroundId === nextBackgroundId && appliedBackgroundId === nextBackgroundId) {
    if (broadcastState) markPresenterStateDirty(true);
    return;
  }

  currentBackgroundId = nextBackgroundId;
  backgroundSelect.value = nextBackgroundId;
  const loadVersion = ++backgroundLoadVersion;
  const preset = getBackgroundPreset(nextBackgroundId);

  if (!preset.url) {
    scene.background = defaultSceneBackground;
    appliedBackgroundId = nextBackgroundId;
    if (broadcastState) markPresenterStateDirty(true);
    return;
  }

  try {
    let texture = backgroundTextures.get(nextBackgroundId);
    if (!texture) {
      texture = await backgroundLoader.loadAsync(new URL(preset.url, location.href).toString());
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.mapping = THREE.EquirectangularReflectionMapping;
      backgroundTextures.set(nextBackgroundId, texture);
    }
    if (loadVersion !== backgroundLoadVersion || currentBackgroundId !== nextBackgroundId) return;
    scene.background = texture;
    appliedBackgroundId = nextBackgroundId;
    if (broadcastState) markPresenterStateDirty(true);
  } catch (err) {
    console.error(err);
    if (loadVersion === backgroundLoadVersion) {
      statusEl.textContent = `Background error: ${(err as Error).message}`;
    }
  }
}

function applyMoleculeTransform(transform: TransformState) {
  moleculeRoot.position.fromArray(transform.position);
  moleculeRoot.quaternion.fromArray(transform.quaternion);
  moleculeRoot.scale.fromArray(transform.scale);
  moleculeRoot.updateMatrixWorld(true);
  lastObservedTransform = objectTransformSignature(moleculeRoot);
}

function applyViewState(view: ViewState) {
  if (renderer.xr.isPresenting) return;

  camera.position.fromArray(view.cameraPosition);
  orbitControls.target.fromArray(view.orbitTarget);
  camera.updateMatrixWorld(true);
  orbitControls.update();
  lastObservedView = currentViewSignature();
}

// Buffers one presenter sample. The first sample snaps directly (instant
// initial sync + seeds the clock offset); later ones are scheduled by the
// render loop. Called only while following.
function pushFollowSample(state: PresenterState) {
  const sample: FollowSample = {
    srcTime: state.updatedAt,
    frameIndex: state.frameIndex,
    transform: state.transform,
    view: state.view ?? getViewState(),
  };
  const now = performance.now();
  if (followClockOffset === null) {
    followClockOffset = now - state.updatedAt;
    followBuffer = [sample];
    followShownFrame = sample.frameIndex;
    applyMoleculeTransform(sample.transform);
    applyViewState(sample.view);
    playback?.setFrame(sample.frameIndex);
    return;
  }
  // Track clock drift slowly so play-out timing follows the presenter's clock.
  followClockOffset += (now - state.updatedAt - followClockOffset) * 0.02;
  followBuffer.push(sample);
  const cutoff = state.updatedAt - FOLLOW_BUFFER_RETENTION_MS;
  while (followBuffer.length > 2 && followBuffer[0].srcTime < cutoff) followBuffer.shift();
}

function resetFollowBuffer() {
  if (followClockOffset === null && followBuffer.length === 0) return;
  followBuffer = [];
  followClockOffset = null;
  followShownFrame = -1;
}

// Plays the buffer out ~FOLLOW_BUFFER_DELAY_MS behind the presenter's clock:
// shows the newest sample already due (even, forward-only frame cadence) and
// eases the molecule transform + camera toward it (cheap, group-level).
function updateFollowFromBuffer(delta: number) {
  if (followClockOffset === null || followBuffer.length === 0) return;
  const playoutTime = performance.now() - followClockOffset - FOLLOW_BUFFER_DELAY_MS;

  let target: FollowSample | null = null;
  for (let i = followBuffer.length - 1; i >= 0; i--) {
    if (followBuffer[i].srcTime <= playoutTime) {
      target = followBuffer[i];
      break;
    }
  }
  if (!target) return; // nothing due yet — hold the current frame/pose

  if (target.frameIndex !== followShownFrame) {
    playback?.setFrame(target.frameIndex);
    followShownFrame = target.frameIndex;
  }

  const alpha = 1 - Math.exp(-delta / FOLLOW_SMOOTHING_TAU);
  _vt.fromArray(target.transform.position);
  _qt.fromArray(target.transform.quaternion);
  _st.fromArray(target.transform.scale);
  if (moleculeRoot.position.distanceTo(_vt) > FOLLOW_SNAP_DISTANCE) {
    moleculeRoot.position.copy(_vt);
    moleculeRoot.quaternion.copy(_qt);
    moleculeRoot.scale.copy(_st);
  } else {
    moleculeRoot.position.lerp(_vt, alpha);
    moleculeRoot.quaternion.slerp(_qt, alpha);
    moleculeRoot.scale.lerp(_st, alpha);
  }
  if (!renderer.xr.isPresenting) {
    _cp.fromArray(target.view.cameraPosition);
    _ot.fromArray(target.view.orbitTarget);
    if (camera.position.distanceTo(_cp) > FOLLOW_SNAP_CAMERA_DISTANCE) {
      camera.position.copy(_cp);
      orbitControls.target.copy(_ot);
    } else {
      camera.position.lerp(_cp, alpha);
      orbitControls.target.lerp(_ot, alpha);
    }
  }
}

function getPresenterState(): PresenterState {
  return {
    trajectoryUrl: currentTrajectoryUrl,
    frameIndex: playback?.frame ?? 0,
    playing: playback?.playing ?? false,
    fps: playback?.fps ?? readFpsInput(),
    backgroundId: currentBackgroundId,
    transform: getMoleculeTransform(),
    view: getViewState(),
    surfaces: isoPanel.getSurfaces(),
    presenterId: collaboration.presenterId,
    updatedAt: Date.now(),
  };
}

function markPresenterStateDirty(force = false) {
  if (applyingRemoteState || !collaboration.isPresenter()) return;
  pendingPresenterSync = true;
  if (force) flushPresenterState(true);
}

function flushPresenterState(force = false) {
  if (!pendingPresenterSync || !collaboration.isPresenter()) return;
  const now = performance.now();
  if (!force && now - lastPresenterSyncAt < PRESENTER_SYNC_INTERVAL_MS) return;
  collaboration.sendPresenterState(getPresenterState());
  pendingPresenterSync = false;
  lastPresenterSyncAt = now;
}

function updateRoomCodeUi() {
  const roomId = sanitizeRoomId(roomInput.value);
  copyRoomCodeBtn.disabled = roomId.length < 3;
}

function updateCollaborationUi() {
  updateRoomCodeUi();
  const connected = collaboration.isConnected();
  const connecting = collaboration.connectionStatus === "connecting";
  const presenter = collaboration.users.find((user) => user.id === collaboration.presenterId);
  const role = connected ? (collaboration.isPresenter() ? "Presenter" : "Follower") : collaboration.connectionStatus;
  const users = collaboration.users.length;

  joinRoomBtn.disabled = connected || connecting;
  leaveRoomBtn.disabled = !connected && !connecting;
  takePresenterBtn.disabled = !connected || collaboration.isPresenter();
  serverInput.disabled = connected || connecting;
  const canControlSharedState = !connected || collaboration.isPresenter();
  manipulator.setEnabled(canControlSharedState);
  orbitControls.enabled = canControlSharedState;
  isoPanel.setInteractive(canControlSharedState);
  for (const control of presenterControls) {
    control.disabled = !canControlSharedState;
  }

  const statusLines = connected
    ? [
        `${role} | ${users} user${users === 1 ? "" : "s"}`,
        presenter ? `Presenter: ${presenter.name}` : "Presenter: none",
        collaboration.isPresenter() ? "You control frame and view" : "Following presenter view",
        `Server: ${serverInput.value}`,
      ]
    : [role.charAt(0).toUpperCase() + role.slice(1)];
  collabStatusEl.textContent = statusLines.join("\n");
}

async function applyRemotePresenterState(state: PresenterState) {
  const applyVersion = ++remoteApplyVersion;
  applyingRemoteState = true;
  try {
    await setSceneBackground(state.backgroundId, { broadcastState: false, persist: false });
    if (applyVersion !== remoteApplyVersion) return;

    if (!state.trajectoryUrl && !moleculeRenderer) {
      statusEl.textContent = "Waiting for the presenter to load a trajectory…";
    }

    if (state.trajectoryUrl && state.trajectoryUrl !== currentTrajectoryUrl) {
      await loadTrajectoryFromUrl(state.trajectoryUrl, false);
      if (applyVersion !== remoteApplyVersion) return;
    }

    // Mirror the presenter's isosurface list (no-op unless a cube is loaded).
    // Guarded so an older room server that omits `surfaces` doesn't wipe the
    // follower's own seeded surfaces.
    if (Array.isArray(state.surfaces)) isoPanel.applySurfaces(state.surfaces);

    // Frame + transform + view are driven by the follower jitter buffer (played
    // out on a delayed clock in the render loop); buffer this sample rather than
    // applying it directly, so motion stays even and jitter-free.
    if (playback) {
      playback.fps = state.fps;
      fpsInput.value = String(state.fps);
      playback.playing = state.playing; // kept for the Play/Pause label only
      syncPlayButton();
    }
    pushFollowSample(state);
  } finally {
    applyingRemoteState = false;
    updateCollaborationUi();
  }
}

updateCollaborationUi();
void setSceneBackground(currentBackgroundId, { broadcastState: false, persist: false });

toggleControlsBtn.addEventListener("click", () => {
  setControlsCollapsed(!uiEl.classList.contains("collapsed"));
});

toggleRoomBtn.addEventListener("click", () => {
  setRoomCollapsed(!collaborationEl.classList.contains("collapsed"));
});

// Desktop click-to-select; a small drift guard lets normal orbit-dragging pass through.
renderer.domElement.addEventListener("pointerdown", (event: PointerEvent) => {
  if (event.button !== 0 || renderer.xr.isPresenting) {
    pointerSelectStart = null;
    return;
  }
  pointerSelectStart = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
});

renderer.domElement.addEventListener("pointerup", (event: PointerEvent) => {
  const start = pointerSelectStart;
  pointerSelectStart = null;
  if (!moleculeRenderer || !start || start.pointerId !== event.pointerId) return;
  const dx = event.clientX - start.x;
  const dy = event.clientY - start.y;
  if (dx * dx + dy * dy > CLICK_SELECT_MAX_DRIFT_PX * CLICK_SELECT_MAX_DRIFT_PX) return;

  const rect = renderer.domElement.getBoundingClientRect();
  pointerNdc.set(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(pointerNdc, camera);
  measurementTool.raycastSelect(raycaster, moleculeRenderer);
});

renderer.domElement.addEventListener("pointercancel", () => {
  pointerSelectStart = null;
});

window.addEventListener("keydown", (e) => {
  if (chaptersPanel.handleKey(e)) {
    e.preventDefault();
    return;
  }
  if (e.key === "c" || e.key === "C") measurementTool.clear();
});

type TrajectoryFormat = "xyz" | "cube";

function looksLikeCubeHead(head: string): boolean {
  const lines = head.split(/\r?\n/);
  if (/^\s*\d+\s*$/.test(lines[0] ?? "")) return false; // XYZ atom-count first line
  const gridLine = (lines[2] ?? "").trim().split(/\s+/);
  return (
    gridLine.length >= 4 &&
    /^-?\d+$/.test(gridLine[0]) &&
    gridLine.slice(1, 4).every((p) => Number.isFinite(parseFloat(p)))
  );
}

async function detectTrajectoryFormat(file: Blob, sourceUrl: string | null): Promise<TrajectoryFormat> {
  const name = (sourceUrl ?? (file as File).name ?? "").toLowerCase();
  if (name.endsWith(".cube") || name.endsWith(".cub")) return "cube";
  if (name.endsWith(".xyz") || name.endsWith(".extxyz")) return "xyz";
  // Extension-less (e.g. Drive download URLs): peek at the first bytes.
  return looksLikeCubeHead(await file.slice(0, 1024).text()) ? "cube" : "xyz";
}

function cubeToTrajectory(volume: CubeVolume): Trajectory {
  const numAtoms = volume.atoms.length;
  const symbols = volume.atoms.map((atom) => symbolForAtomicNumber(atom.atomicNumber));
  const positions = new Float32Array(numAtoms * 3);
  volume.atoms.forEach((atom, i) => {
    positions[i * 3] = atom.position[0];
    positions[i * 3 + 1] = atom.position[1];
    positions[i * 3 + 2] = atom.position[2];
  });
  return { numFrames: 1, numAtoms, symbols, frameSymbols: symbols.slice(), positions, comments: [""] };
}

function atomsCentroid(volume: CubeVolume): [number, number, number] {
  const centroid: [number, number, number] = [0, 0, 0];
  for (const atom of volume.atoms) {
    centroid[0] += atom.position[0];
    centroid[1] += atom.position[1];
    centroid[2] += atom.position[2];
  }
  const n = Math.max(1, volume.atoms.length);
  return [centroid[0] / n, centroid[1] / n, centroid[2] / n];
}

function mountMolecule(trajectory: Trajectory, sourceUrl: string | null) {
  if (moleculeRenderer) {
    moleculeRoot.remove(moleculeRenderer.group);
    moleculeRenderer.dispose();
  }
  moleculeRenderer = new MoleculeRenderer(trajectory);
  moleculeRoot.add(moleculeRenderer.group);
  moleculeRenderer.group.add(chapterHighlight.group);
  moleculeRoot.position.set(0, 0, 0);
  moleculeRoot.quaternion.identity();
  moleculeRoot.scale.set(1, 1, 1);
  lastObservedTransform = objectTransformSignature(moleculeRoot);
  measurementTool.clear();
  currentTrajectoryUrl = sourceUrl;
}

/**
 * When the presenter has a local file loaded (no URL to broadcast), upload it
 * once to the room's /share storage and adopt the returned URL so every member
 * loads it like any other trajectory. No-op unless presenter + local file +
 * not already shared. Runs on local loads and when joining / taking presenter.
 */
async function ensureLocalTrajectoryShared() {
  if (sharingInFlight) return;
  if (!collaboration.isPresenter() || currentTrajectoryUrl || !lastLocalBlob) return;

  const blob = lastLocalBlob;
  const name = lastLocalName || "trajectory.xyz";
  sharingInFlight = true;
  try {
    statusEl.textContent = "Sharing file with the room…";
    const token = await collaboration.requestUploadTicket(blob.size, name);
    if (lastLocalBlob !== blob) return; // a newer file was loaded while waiting
    const httpBase = httpBaseFromWebSocketBase(normalizeWebSocketBase(serverInput.value) || defaultWebSocketBase());
    const shareUrl = await uploadTrajectory(httpBase, blob, name, token);
    if (lastLocalBlob !== blob) return;
    currentTrajectoryUrl = shareUrl;
    statusEl.textContent = "Shared with the room — others can now load this file.";
    markPresenterStateDirty(true);
  } catch (err) {
    statusEl.textContent = `Could not share this file with the room: ${(err as Error).message}`;
  } finally {
    sharingInFlight = false;
  }
}


async function loadCubeVolume(
  file: Blob,
  sourceUrl: string | null,
  broadcastState: boolean,
  loadVersion: number,
) {
  statusEl.textContent = "Parsing cube...";
  const volume = await parseCubeVolume(file, (p) => {
    if (loadVersion !== trajectoryLoadVersion) return;
    const pct = ((p.pointsRead / p.totalPoints) * 100).toFixed(0);
    statusEl.textContent = `Parsing cube... ${pct}% (${p.totalPoints.toLocaleString()} points)`;
  });
  if (loadVersion !== trajectoryLoadVersion) return;

  mountMolecule(cubeToTrajectory(volume), sourceUrl);

  // A cube is a single structure — no trajectory frames.
  playback = null;
  chaptersPanel.hide();
  playbackEl.style.display = "none";
  document.body.classList.remove("has-playback");

  cubeStatusSummary = `Loaded ${volume.atoms.length} atoms, ${volume.grid.nx}x${volume.grid.ny}x${volume.grid.nz} grid`;
  isoPanel.show(volume, atomsCentroid(volume));

  statusEl.textContent = cubeStatusSummary;
  if (broadcastState) markPresenterStateDirty(true);
  if (broadcastState && !sourceUrl) void ensureLocalTrajectoryShared();
}

async function loadTrajectoryFile(
  file: Blob,
  sourceUrl: string | null = null,
  broadcastState = true,
  loadVersion = ++trajectoryLoadVersion,
) {
  if (!sourceUrl) {
    activeTrajectoryFetch?.abort();
    activeTrajectoryFetch = null;
    pendingTrajectoryUrl = null;
    // A locally-loaded file: remember it so a presenter can share it, and drop
    // any previous share URL so ensureLocalTrajectoryShared re-uploads.
    lastLocalBlob = file;
    lastLocalName = (file as File).name || "trajectory.xyz";
  } else {
    lastLocalBlob = null;
    lastLocalName = "";
  }

  let format: TrajectoryFormat;
  try {
    format = await detectTrajectoryFormat(file, sourceUrl);
  } catch (err) {
    if (loadVersion !== trajectoryLoadVersion) return;
    statusEl.textContent = `Error: ${(err as Error).message}`;
    return;
  }
  if (loadVersion !== trajectoryLoadVersion) return;

  if (format === "cube") {
    try {
      await loadCubeVolume(file, sourceUrl, broadcastState, loadVersion);
    } catch (err) {
      if (loadVersion !== trajectoryLoadVersion) return;
      console.error(err);
      statusEl.textContent = `Error: ${(err as Error).message}`;
    }
    return;
  }

  statusEl.textContent = "Parsing...";
  try {
    // Loading an XYZ trajectory clears any cube isosurface from a prior load.
    isoPanel.hide();
    const trajectory = await parseExtendedXYZ(file, (p) => {
      if (loadVersion !== trajectoryLoadVersion) return;
      const pct = ((p.bytesRead / p.totalBytes) * 100).toFixed(0);
      statusEl.textContent = `Parsing... ${pct}% (${p.framesParsed} frames)`;
    });
    if (loadVersion !== trajectoryLoadVersion) return;

    mountMolecule(trajectory, sourceUrl);

    playback = new Playback(trajectory.numFrames, (frame) => {
      moleculeRenderer?.setFrame(frame);
      chaptersPanel.onFrame(frame);
      frameSlider.value = String(frame);
      frameLabel.textContent = `${frame} / ${trajectory.numFrames - 1}`;
      markPresenterStateDirty();
    });
    playback.fps = readFpsInput();
    fpsInput.value = String(playback.fps);
    syncPlayButton();

    frameSlider.min = "0";
    frameSlider.max = String(trajectory.numFrames - 1);
    frameSlider.value = "0";
    frameLabel.textContent = `0 / ${trajectory.numFrames - 1}`;
    playbackEl.style.display = "block";
    document.body.classList.add("has-playback");

    statusEl.textContent = `Loaded ${trajectory.numAtoms} atoms x ${trajectory.numFrames} frames`;
    const fileName = sourceUrl ? decodeURIComponent(new URL(sourceUrl).pathname.split("/").pop() || "") : lastLocalName;
    void chaptersPanel.setTrajectory(trajectory, file, fileName || "trajectory.xyz");
    if (broadcastState) markPresenterStateDirty(true);
    if (broadcastState && !sourceUrl) void ensureLocalTrajectoryShared();
  } catch (err) {
    if (loadVersion !== trajectoryLoadVersion) return;
    console.error(err);
    statusEl.textContent = `Error: ${(err as Error).message}`;
  }
}

async function loadTrajectoryFromUrl(url: string, broadcastState = true) {
  if (pendingTrajectoryUrl === url) return;
  const loadVersion = ++trajectoryLoadVersion;
  activeTrajectoryFetch?.abort();
  const fetchController = new AbortController();
  activeTrajectoryFetch = fetchController;
  pendingTrajectoryUrl = url;
  statusEl.textContent = "Fetching...";
  try {
    const proxyBase = httpBaseFromWebSocketBase(
      normalizeWebSocketBase(serverInput.value) || defaultWebSocketBase(),
    );
    const onStatus = (message: string) => {
      if (loadVersion === trajectoryLoadVersion) statusEl.textContent = message;
    };

    // A Materials Project structure (canonical OPTIMADE URL) is fetched as JSON
    // and converted to XYZ; followers receive the same URL and take this path.
    const mpId = optimadeIdFromUrl(url);
    let blob: Blob;
    if (mpId) {
      onStatus(`Fetching Materials Project ${mpId}...`);
      const xyz = await fetchMaterialsProjectXyz(mpId, { proxyBase, signal: fetchController.signal, onStatus });
      blob = new Blob([xyz], { type: "text/plain" });
    } else {
      blob = await fetchTrajectoryBlob(url, { proxyBase, signal: fetchController.signal, onStatus });
    }
    if (loadVersion !== trajectoryLoadVersion) return;
    await loadTrajectoryFile(blob, url, broadcastState, loadVersion);
  } catch (err) {
    if (loadVersion !== trajectoryLoadVersion) return;
    if (err instanceof DOMException && err.name === "AbortError") return;
    console.error(err);
    statusEl.textContent = `Fetch error: ${(err as Error).message}`;
  } finally {
    if (activeTrajectoryFetch === fetchController) {
      activeTrajectoryFetch = null;
    }
    if (pendingTrajectoryUrl === url) {
      pendingTrajectoryUrl = null;
    }
  }
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) loadTrajectoryFile(file, null, true);
});

// Drag-and-drop fallback: doesn't depend on the native file-picker dialog,
// which can fail to appear on some browser/OS/permission combinations.
uiEl.addEventListener("dragover", (e) => {
  e.preventDefault();
  uiEl.style.outline = "2px dashed #44ccff";
});
uiEl.addEventListener("dragleave", () => {
  uiEl.style.outline = "none";
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  uiEl.style.outline = "none";
  const file = e.dataTransfer?.files?.[0];
  if (file) loadTrajectoryFile(file, null, true);
});

loadUrlBtn.addEventListener("click", async () => {
  const raw = urlInput.value.trim();
  if (!raw) return;
  // A Materials Project id or page URL normalizes to the OPTIMADE URL.
  const mpId = materialsProjectId(raw);
  await loadTrajectoryFromUrl(mpId ? optimadeUrlForId(mpId) : raw, true);
});

frameSlider.addEventListener("input", () => {
  playback?.setFrame(parseInt(frameSlider.value, 10));
});

playBtn.addEventListener("click", () => {
  if (!playback) return;
  playback.playing = !playback.playing;
  syncPlayButton();
  markPresenterStateDirty(true);
});

stepBack.addEventListener("click", () => {
  if (!playback) return;
  playback.setFrame(playback.frame - 1);
});

stepFwd.addEventListener("click", () => {
  if (!playback) return;
  playback.setFrame(playback.frame + 1);
});

fpsInput.addEventListener("input", () => applyFpsInput(false));
fpsInput.addEventListener("change", () => applyFpsInput(true));

backgroundSelect.addEventListener("change", () => {
  void setSceneBackground(backgroundSelect.value, { broadcastState: true, persist: true });
});

roomInput.addEventListener("input", updateRoomCodeUi);
serverInput.addEventListener("input", updateRoomCodeUi);

joinRoomBtn.addEventListener("click", () => {
  const roomId = sanitizeRoomId(roomInput.value) || makeRoomId();
  const serverBase = normalizeWebSocketBase(serverInput.value);
  roomInput.value = roomId;
  serverInput.value = serverBase;
  localStorage.setItem(USER_NAME_KEY, userNameInput.value.trim());
  localStorage.setItem(SERVER_BASE_KEY, serverBase);
  collaboration.connect(roomId, userNameInput.value, serverBase);
  updateRoomCodeUi();
});

leaveRoomBtn.addEventListener("click", () => {
  collaboration.disconnect();
  updateCollaborationUi();
});

takePresenterBtn.addEventListener("click", () => {
  collaboration.takePresenter();
});

copyRoomCodeBtn.addEventListener("click", async () => {
  const roomId = sanitizeRoomId(roomInput.value);
  if (roomId.length < 3) return;
  roomInput.value = roomId;
  updateRoomCodeUi();
  try {
    await navigator.clipboard.writeText(roomId);
    collabStatusEl.textContent = `${collabStatusEl.textContent}\nRoom code copied`;
  } catch {
    roomInput.select();
  }
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const clock = new THREE.Clock();

renderer.setAnimationLoop(() => {
  const delta = clock.getDelta();
  const following = collaboration.isConnected() && !collaboration.isPresenter();
  // Followers don't advance playback locally — the jitter buffer drives their
  // frame. Presenters/solo users play normally.
  if (!following) playback?.step(delta);
  manipulator?.update();
  if (following) {
    updateFollowFromBuffer(delta);
  } else {
    resetFollowBuffer();
  }
  const transformSig = objectTransformSignature(moleculeRoot);
  if (transformSig !== lastObservedTransform) {
    lastObservedTransform = transformSig;
    markPresenterStateDirty();
  }
  if (!renderer.xr.isPresenting) {
    const viewSig = currentViewSignature();
    if (viewSig !== lastObservedView) {
      lastObservedView = viewSig;
      markPresenterStateDirty();
    }
  }
  orbitControls.update();
  flushPresenterState();
  renderer.render(scene, camera);
});
