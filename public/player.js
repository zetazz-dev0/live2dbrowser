const playerTitle = document.querySelector("#playerTitle");
const playerSubtitle = document.querySelector("#playerSubtitle");
const playerStatus = document.querySelector("#playerStatus");
const playerCanvas = document.querySelector("#playerCanvas");
const playerStage = document.querySelector("#playerStage");
const renderFrame = document.querySelector("#renderFrame");
const live2dCanvas = document.querySelector("#live2dCanvas");
const pixiHost = document.querySelector("#pixiHost");
const playerOverlay = document.querySelector("#playerOverlay");
const playerOverlayText = document.querySelector("#playerOverlayText");
const viewTools = document.querySelector("#viewTools");
const variantField = document.querySelector("#variantField");
const variantSelect = document.querySelector("#variantSelect");
const motionField = document.querySelector("#motionField");
const motionSelect = document.querySelector("#motionSelect");
const playMotionButton = document.querySelector("#playMotionButton");
const randomMotionButton = document.querySelector("#randomMotionButton");

const params = new URLSearchParams(window.location.search);
const modelName = params.get("name") || "未命名模型";
const displayPath = params.get("displayPath") || "";
const rootToken = params.get("rootToken") || "";
const initialModelPath = params.get("path") || "";
const version = Number(params.get("version") || "0");

let pixiApp = null;
let currentModel = null;
let suppressClickUntil = 0;

const playerState = {
  currentModelPath: initialModelPath,
  loadId: 0,
  motionEntries: [],
  renderMode: "none",
  resizeHandler: null,
  runtime2Ready: false,
  runtime3Ready: false,
  v2BaseMatrix: null,
  v2Controller: null,
  v2FitZoom: 1,
  variants: normalizeVariants(initialModelPath, parseVariantsParam())
};

const viewState = {
  panX: 0,
  panY: 0,
  zoom: 1
};

const panState = {
  active: false,
  moved: false,
  startPanX: 0,
  startPanY: 0,
  startX: 0,
  startY: 0
};

let applyCurrentView = () => {};
const DRAG_THRESHOLD = 4;

playerTitle.textContent = modelName;

function parseVariantsParam() {
  const raw = params.get("variants");
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeVariants(modelPath, variants) {
  const seen = new Set();
  const normalized = [];

  for (const item of variants) {
    if (!item || typeof item.relativePath !== "string" || !item.relativePath) {
      continue;
    }

    if (seen.has(item.relativePath)) {
      continue;
    }

    seen.add(item.relativePath);
    normalized.push({
      label: typeof item.label === "string" && item.label ? item.label : item.relativePath,
      relativePath: item.relativePath
    });
  }

  if (modelPath && !seen.has(modelPath)) {
    normalized.unshift({
      label: "default",
      relativePath: modelPath
    });
  }

  return normalized;
}

function setStatus(message, tone = "default") {
  playerStatus.textContent = message;
  playerStatus.style.background =
    tone === "error"
      ? "rgba(164, 34, 15, 0.12)"
      : tone === "success"
        ? "rgba(45, 79, 108, 0.12)"
        : "rgba(205, 83, 52, 0.12)";
  playerStatus.style.color = tone === "error" ? "#8b2010" : tone === "success" ? "#2d4f6c" : "#7f2d1d";
}

function showOverlay(message, tone = "default") {
  playerOverlay.classList.remove("is-hidden", "is-error");
  if (tone === "error") {
    playerOverlay.classList.add("is-error");
  }
  playerOverlayText.textContent = message;
}

function hideOverlay() {
  playerOverlay.classList.add("is-hidden");
  playerOverlay.classList.remove("is-error");
}

function normalizeSlashes(value) {
  return value.replaceAll("\\", "/");
}

function dirnamePosix(value) {
  const normalized = normalizeSlashes(value);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "" : normalized.slice(0, index);
}

function joinPosix(base, relative) {
  const cleanedRelative = normalizeSlashes(relative).replace(/^\/+/, "");
  if (!base) {
    return cleanedRelative;
  }
  return `${normalizeSlashes(base).replace(/\/+$/, "")}/${cleanedRelative}`;
}

function buildFsUrl(relativePath) {
  const normalized = normalizeSlashes(relativePath)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `/fs/${encodeURIComponent(rootToken)}/${normalized}`;
}

function getCurrentVariant() {
  return playerState.variants.find((item) => item.relativePath === playerState.currentModelPath) || null;
}

function updateSubtitle() {
  const currentVariant = getCurrentVariant();
  const variantSuffix =
    currentVariant && playerState.variants.length > 1 ? ` · 变体 ${currentVariant.label}` : "";
  playerSubtitle.textContent = `${displayPath || playerState.currentModelPath}${variantSuffix}`;
}

function createMotionButton(label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "motion-button";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function buildViewControls() {
  viewTools.innerHTML = "";
  viewTools.appendChild(createMotionButton("缩小", () => zoomBy(1 / 1.12)));
  viewTools.appendChild(createMotionButton("放大", () => zoomBy(1.12)));
  viewTools.appendChild(createMotionButton("重置视图", resetView));
}

function setControlVisibility(element, visible) {
  element.classList.toggle("is-hidden", !visible);
}

function populateVariantOptions() {
  variantSelect.innerHTML = "";
  for (const variant of playerState.variants) {
    const option = document.createElement("option");
    option.value = variant.relativePath;
    option.textContent = variant.label;
    variantSelect.appendChild(option);
  }

  variantSelect.value = playerState.currentModelPath;
  setControlVisibility(variantField, playerState.variants.length > 1);
}

function scoreMotionLabel(label) {
  const normalized = String(label || "").toLowerCase();
  if (normalized.includes("idle")) {
    return 2;
  }
  if (normalized.includes("effect")) {
    return 1;
  }
  return 0;
}

function setMotionOptions(motionEntries) {
  motionSelect.innerHTML = "";
  playerState.motionEntries = Array.isArray(motionEntries) ? motionEntries : [];

  for (const motionEntry of playerState.motionEntries) {
    const option = document.createElement("option");
    option.value = motionEntry.key;
    option.textContent = motionEntry.label;
    motionSelect.appendChild(option);
  }

  const hasMotion = playerState.motionEntries.length > 0;
  setControlVisibility(motionField, hasMotion);
  setControlVisibility(playMotionButton, hasMotion);
  setControlVisibility(randomMotionButton, hasMotion);

  if (hasMotion) {
    const preferredMotion =
      [...playerState.motionEntries].sort((left, right) => scoreMotionLabel(left.label) - scoreMotionLabel(right.label))[0] ||
      playerState.motionEntries[0];
    motionSelect.value = preferredMotion.key;
  }
}

function setBusy(busy) {
  variantSelect.disabled = busy;
  motionSelect.disabled = busy;
  playMotionButton.disabled = busy;
  randomMotionButton.disabled = busy;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.ready === "true") {
        resolve();
        return;
      }

      existing.addEventListener("load", resolve, { once: true });
      existing.addEventListener("error", () => reject(new Error(`脚本加载失败: ${src}`)), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = src;
    script.onload = () => {
      script.dataset.ready = "true";
      resolve();
    };
    script.onerror = () => reject(new Error(`脚本加载失败: ${src}`));
    document.head.appendChild(script);
  });
}

async function fetchJson(relativePath) {
  const response = await fetch(buildFsUrl(relativePath));
  if (!response.ok) {
    throw new Error(`读取失败: ${relativePath}`);
  }
  return response.json();
}

async function fetchJsonIfExists(relativePath) {
  const response = await fetch(buildFsUrl(relativePath));
  if (!response.ok) {
    return null;
  }

  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function fetchDirectoryEntries(relativePath) {
  const response = await fetch(
    `/api/list?${new URLSearchParams({
      dir: relativePath,
      rootToken
    }).toString()}`
  );
  if (!response.ok) {
    return [];
  }

  try {
    const payload = await response.json();
    return Array.isArray(payload.entries) ? payload.entries : [];
  } catch {
    return [];
  }
}

function hasCubism3Textures(settings) {
  return Array.isArray(settings?.FileReferences?.Textures) && settings.FileReferences.Textures.length > 0;
}

function hasCubism3Motions(settings) {
  const motions = settings?.FileReferences?.Motions;
  if (!motions || typeof motions !== "object") {
    return false;
  }

  return Object.values(motions).some((entries) => Array.isArray(entries) && entries.length > 0);
}

function hasCubism3Physics(settings) {
  return typeof settings?.FileReferences?.Physics === "string" && settings.FileReferences.Physics.length > 0;
}

function hasCubism3Groups(settings) {
  return Array.isArray(settings?.Groups) && settings.Groups.length > 0;
}

function getCubism3BaseStem(modelPath, settings) {
  const mocName = settings?.FileReferences?.Moc?.split("/")?.pop() || "";
  const fileName = modelPath.split("/").pop() || "";
  return (mocName || fileName).replace(/\.moc3$/i, "").replace(/\.model3\.json$/i, "");
}

async function fetchCubism3SiblingSettings(modelPath) {
  const modelDir = dirnamePosix(modelPath);
  const siblings = [];

  for (const variant of playerState.variants) {
    const relativePath = variant?.relativePath;
    if (
      !relativePath ||
      relativePath === modelPath ||
      dirnamePosix(relativePath) !== modelDir ||
      !relativePath.toLowerCase().endsWith(".model3.json")
    ) {
      continue;
    }

    const json = await fetchJsonIfExists(relativePath);
    if (!json) {
      continue;
    }

    siblings.push({
      json,
      relativePath
    });
  }

  return siblings;
}

async function discoverCubism3Textures(modelPath, settings) {
  const modelDir = dirnamePosix(modelPath);
  const baseStem = getCubism3BaseStem(modelPath, settings);
  const textureDirs = ["textures", "", `data/${baseStem}.1024`];

  for (const directory of textureDirs) {
    const relativeDirectory = directory ? joinPosix(modelDir, directory) : modelDir;
    const entries = await fetchDirectoryEntries(relativeDirectory);
    const textures = entries
      .filter((entry) => entry?.isFile && /^texture_(\d+)\s*\.(png|jpg|jpeg|webp)$/i.test(entry.name))
      .sort((left, right) => {
        const leftIndex = Number(left.name.match(/\d+/)?.[0] || "0");
        const rightIndex = Number(right.name.match(/\d+/)?.[0] || "0");
        if (leftIndex !== rightIndex) {
          return leftIndex - rightIndex;
        }
        return String(left.name || "").localeCompare(String(right.name || ""), "zh-Hans-CN");
      })
      .map((entry) => (directory ? `${directory}/${entry.name}` : entry.name));

    if (textures.length > 0) {
      return textures;
    }
  }

  return [];
}

async function buildCubism3Settings(modelPath, model3Json) {
  const settings = structuredClone(model3Json);
  settings.url = buildFsUrl(modelPath);
  settings.FileReferences = settings.FileReferences || {};

  const siblingSettings = await fetchCubism3SiblingSettings(modelPath);

  if (!hasCubism3Textures(settings)) {
    const textureSource = siblingSettings.find((entry) => hasCubism3Textures(entry.json));
    if (textureSource) {
      settings.FileReferences.Textures = structuredClone(textureSource.json.FileReferences.Textures);
    } else {
      settings.FileReferences.Textures = await discoverCubism3Textures(modelPath, settings);
    }
  }

  if (!hasCubism3Motions(settings)) {
    const motionSource = siblingSettings.find((entry) => hasCubism3Motions(entry.json));
    if (motionSource) {
      settings.FileReferences.Motions = structuredClone(motionSource.json.FileReferences.Motions);
    }
  }

  if (!hasCubism3Physics(settings)) {
    const physicsSource = siblingSettings.find((entry) => hasCubism3Physics(entry.json));
    if (physicsSource) {
      settings.FileReferences.Physics = physicsSource.json.FileReferences.Physics;
    }
  }

  if (!hasCubism3Groups(settings)) {
    const groupSource = siblingSettings.find((entry) => hasCubism3Groups(entry.json));
    if (groupSource) {
      settings.Groups = structuredClone(groupSource.json.Groups);
    }
  }

  return settings;
}

function waitForLayout() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(resolve);
    });
  });
}

function wait(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function getStageSize() {
  return {
    width: Math.max(playerStage.clientWidth || 0, 320),
    height: Math.max(playerStage.clientHeight || 0, 420)
  };
}

function zoomBy(multiplier) {
  const nextZoom = viewState.zoom * multiplier;
  if (!Number.isFinite(nextZoom) || nextZoom <= 0) {
    return;
  }
  viewState.zoom = nextZoom;
  applyCurrentView();
}

function resetView() {
  viewState.panX = 0;
  viewState.panY = 0;
  viewState.zoom = 1;
  applyCurrentView();
}

function shouldDragModel(event) {
  return event.button === 0 || event.button === 2 || event.shiftKey;
}

function bindViewportInteractions() {
  playerCanvas.addEventListener("contextmenu", (event) => {
    event.preventDefault();
  });

  playerCanvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      zoomBy(event.deltaY < 0 ? 1.12 : 1 / 1.12);
    },
    { passive: false }
  );

  playerCanvas.addEventListener("mousedown", (event) => {
    if (!shouldDragModel(event)) {
      return;
    }

    event.preventDefault();
    panState.active = true;
    panState.moved = false;
    panState.startX = event.clientX;
    panState.startY = event.clientY;
    panState.startPanX = viewState.panX;
    panState.startPanY = viewState.panY;
  });

  playerCanvas.addEventListener("click", (event) => {
    if (Date.now() < suppressClickUntil || event.shiftKey) {
      return;
    }

    if (playerState.renderMode === "v3") {
      playRandomMotion();
    }
  });

  window.addEventListener("mousemove", (event) => {
    if (!panState.active) {
      return;
    }

    const deltaX = event.clientX - panState.startX;
    const deltaY = event.clientY - panState.startY;
    if (Math.abs(deltaX) > DRAG_THRESHOLD || Math.abs(deltaY) > DRAG_THRESHOLD) {
      panState.moved = true;
    }

    if (playerState.renderMode === "v2") {
      const stageWidth = Math.max(playerStage.clientWidth, 1);
      viewState.panX = panState.startPanX + (2 * deltaX) / stageWidth;
      viewState.panY = panState.startPanY - (2 * deltaY) / stageWidth;
    } else {
      viewState.panX = panState.startPanX + deltaX;
      viewState.panY = panState.startPanY + deltaY;
    }
    applyCurrentView();
  });

  window.addEventListener("mouseup", () => {
    if (!panState.active) {
      return;
    }

    if (panState.moved) {
      suppressClickUntil = Date.now() + 180;
    }

    panState.active = false;
  });
}

function clearResizeHandler() {
  if (playerState.resizeHandler) {
    window.removeEventListener("resize", playerState.resizeHandler);
    playerState.resizeHandler = null;
  }
}

function cleanupRenderer() {
  clearResizeHandler();
  currentModel = null;
  playerState.motionEntries = [];
  playerState.v2BaseMatrix = null;
  playerState.v2Controller = null;
  playerState.v2FitZoom = 1;

  if (pixiApp) {
    try {
      pixiApp.destroy(true, { children: true });
    } catch {
      pixiApp.destroy(true);
    }
    pixiApp = null;
  }

  pixiHost.innerHTML = "";
  pixiHost.style.display = "none";
  live2dCanvas.style.display = "none";
  renderFrame.style.transform = "none";
  playerState.renderMode = "none";
  setMotionOptions([]);
}

function showV2Surface() {
  live2dCanvas.style.display = "block";
  pixiHost.style.display = "none";
  playerState.renderMode = "v2";
}

function showV3Surface() {
  live2dCanvas.style.display = "none";
  pixiHost.style.display = "block";
  playerState.renderMode = "v3";
}

function resizeV2Canvas() {
  const { width, height } = getStageSize();
  live2dCanvas.width = width;
  live2dCanvas.height = height;
}

function hasWebglSupport() {
  const canvas = document.createElement("canvas");
  return Boolean(canvas.getContext("webgl") || canvas.getContext("experimental-webgl"));
}

async function ensureCubism2Runtime() {
  if (playerState.runtime2Ready) {
    return;
  }

  await loadScript("/vendor/live2d2/live2d.js");
  playerState.runtime2Ready = true;
}

function patchModernCubism3Runtime() {
  const Cubism4InternalModel = PIXI?.live2d?.Cubism4InternalModel;
  if (!Cubism4InternalModel || Cubism4InternalModel.prototype.__viewerUpdateWebglPatched) {
    return;
  }

  Cubism4InternalModel.prototype.updateWebGLContext = function patchedUpdateWebGLContext(gl, contextId) {
    if (!this.renderer || typeof this.renderer.startUp !== "function") {
      return;
    }

    this.renderer.firstDraw = true;
    this.renderer._bufferData = { vertex: null, uv: null, index: null };
    this.renderer.startUp(gl);

    if (this.renderer._clippingManager) {
      this.renderer._clippingManager._currentFrameNo = contextId;
      this.renderer._clippingManager._maskTexture = undefined;
    }
  };

  Cubism4InternalModel.prototype.__viewerUpdateWebglPatched = true;
}

async function ensureCubism3Runtime() {
  if (playerState.runtime3Ready) {
    return;
  }

  await loadScript("/vendor/live2d-modern/pixi.min.js");
  await loadScript("/vendor/live2d-modern/live2d.min.js");
  await loadScript("/vendor/live2d-modern/live2dcubismcore.min.js");
  await loadScript("/vendor/live2d-modern/index.min.js");
  patchModernCubism3Runtime();
  playerState.runtime3Ready = true;
}

function isLoadActive(loadId) {
  return loadId === playerState.loadId;
}

function fitCubism3Model() {
  if (!pixiApp || !currentModel) {
    return;
  }

  const { width, height } = getStageSize();
  pixiApp.renderer.resize(width, height);
  const bounds = currentModel.baseBounds || {
    width: Math.max(currentModel.width, 1),
    height: Math.max(currentModel.height, 1)
  };
  const safeWidth = Math.max(bounds.width, 1);
  const safeHeight = Math.max(bounds.height, 1);
  currentModel.fitScale = Math.min((width * 0.72) / safeWidth, (height * 0.86) / safeHeight);

  applyCurrentView();
}

function computeCubism2FitZoom(controller) {
  const model = controller?.getModel?.();
  const liveModel = model?.getLive2DModel?.();
  const modelMatrix = model?.getModelMatrix?.();
  if (!liveModel || !modelMatrix) {
    return 1;
  }

  const modelWidth = Math.max(liveModel.getCanvasWidth?.() || 0, 1);
  const modelHeight = Math.max(liveModel.getCanvasHeight?.() || 0, 1);
  const logicalWidth = Math.abs(modelMatrix.getScaleX()) * modelWidth;
  const logicalHeight = Math.abs(modelMatrix.getScaleY()) * modelHeight;
  if (logicalWidth <= 0 || logicalHeight <= 0) {
    return 1;
  }

  const { width, height } = getStageSize();
  const stageAspect = height / Math.max(width, 1);
  const targetLogicalWidth = 2 * 0.72;
  const targetLogicalHeight = 2 * stageAspect * 0.86;

  return Math.min(targetLogicalWidth / logicalWidth, targetLogicalHeight / logicalHeight);
}

function measureCubism3Bounds(model) {
  const meshes = Array.isArray(model?._meshes) ? model._meshes : [];
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  meshes.forEach((mesh) => {
    const vertices = mesh?.vertices;
    if (!vertices || vertices.length < 2) {
      return;
    }

    for (let index = 0; index < vertices.length; index += 2) {
      const x = vertices[index];
      const y = vertices[index + 1];
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  });

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return null;
  }

  return {
    centerX: (minX + maxX) * 0.5,
    centerY: (minY + maxY) * 0.5,
    height: maxY - minY,
    maxX,
    maxY,
    minX,
    minY,
    width: maxX - minX
  };
}

function measureCubism3DisplayBounds(model) {
  const bounds = model?.getLocalBounds?.();
  if (bounds && Number.isFinite(bounds.width) && Number.isFinite(bounds.height) && bounds.width > 0 && bounds.height > 0) {
    return {
      centerX: bounds.x + bounds.width * 0.5,
      centerY: bounds.y + bounds.height * 0.5,
      height: bounds.height,
      width: bounds.width
    };
  }

  const internalSize = model?.internalModel?.getSize?.();
  if (Array.isArray(internalSize) && internalSize.length >= 2) {
    const [width, height] = internalSize;
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
      return {
        centerX: width * 0.5,
        centerY: height * 0.5,
        height,
        width
      };
    }
  }

  return null;
}

function getMotionStem(filePath, fallbackIndex) {
  const fileName = String(filePath || "")
    .split("/")
    .pop()
    ?.replace(/\.motion3\.json$/i, "");
  return fileName || `motion-${fallbackIndex + 1}`;
}

function makeMotionKey(groupName, index, filePath) {
  return `${groupName || "_default"}::${index}::${filePath || ""}`;
}

function extractCubism3MotionEntries(model3Json) {
  const groups = model3Json?.FileReferences?.Motions;
  if (!groups || typeof groups !== "object") {
    return [];
  }

  const seenLabels = new Map();
  const entries = [];

  for (const [groupName, motions] of Object.entries(groups)) {
    if (!Array.isArray(motions)) {
      continue;
    }

    motions.forEach((motion, index) => {
      if (!motion || typeof motion.File !== "string" || !motion.File) {
        return;
      }

      const stem = getMotionStem(motion.File, index);
      const baseLabel = groupName ? `${groupName} · ${stem}` : stem;
      const seenCount = (seenLabels.get(baseLabel) || 0) + 1;
      seenLabels.set(baseLabel, seenCount);
      entries.push({
        file: motion.File,
        group: groupName,
        index,
        key: makeMotionKey(groupName, index, motion.File),
        label: seenCount > 1 ? `${baseLabel} #${seenCount}` : baseLabel
      });
    });
  }

  return entries;
}

function findMotionEntry(motionKey) {
  return playerState.motionEntries.find((entry) => entry.key === motionKey) || null;
}

function startMotion(motionKey) {
  if (!currentModel) {
    return;
  }

  const motionEntry = findMotionEntry(motionKey);
  if (!motionEntry) {
    return;
  }

  if (typeof currentModel.motion !== "function") {
    return;
  }

  currentModel.motion(motionEntry.group, motionEntry.index);
}

function playRandomMotion() {
  if (!currentModel || playerState.motionEntries.length === 0) {
    return;
  }

  const candidates = playerState.motionEntries.filter((entry) => scoreMotionLabel(entry.label) === 0);
  const motionPool = candidates.length > 0 ? candidates : playerState.motionEntries;
  const randomEntry = motionPool[Math.floor(Math.random() * motionPool.length)];
  if (randomEntry) {
    startMotion(randomEntry.key);
  }
}

async function initCubism2(modelPath, loadId) {
  if (!hasWebglSupport()) {
    throw new Error("当前浏览器无法创建 WebGL，Cubism 2 模型无法显示。");
  }

  setStatus("加载 Cubism 2 运行时…");
  showOverlay("正在初始化 Cubism 2…");
  await ensureCubism2Runtime();
  if (!isLoadActive(loadId)) {
    return;
  }

  await waitForLayout();
  if (!isLoadActive(loadId)) {
    return;
  }

  showV2Surface();
  resizeV2Canvas();

  if (typeof window.loadlive2d !== "function") {
    throw new Error("Cubism 2 运行时未暴露 loadlive2d。");
  }

  setStatus("加载 Cubism 2 模型…");
  showOverlay("正在加载 Cubism 2 模型…");
  window.loadlive2d("live2dCanvas", buildFsUrl(modelPath));

  await wait(160);
  if (!isLoadActive(loadId)) {
    return;
  }

  const controller = window.__live2d_view__;
  const model = controller?.getModel?.();
  const modelMatrix = model?.getModelMatrix?.();
  if (!controller || !model || !modelMatrix) {
    throw new Error("Cubism 2 视图控制器初始化失败。");
  }

  playerState.v2Controller = controller;
  playerState.v2BaseMatrix = modelMatrix.getCopyMatrix();
  playerState.v2FitZoom = computeCubism2FitZoom(controller);
  applyCurrentView = () => {
    const activeModel = playerState.v2Controller?.getModel?.();
    const activeMatrix = activeModel?.getModelMatrix?.();
    if (!activeMatrix || !playerState.v2BaseMatrix) {
      return;
    }

    activeMatrix.setMatrix(playerState.v2BaseMatrix);
    const effectiveZoom = playerState.v2FitZoom * viewState.zoom;
    activeMatrix.multScale(effectiveZoom, effectiveZoom);
    activeMatrix.multTranslate(viewState.panX, viewState.panY);
  };
  resetView();

  playerState.resizeHandler = () => {
    resizeV2Canvas();
    playerState.v2FitZoom = computeCubism2FitZoom(playerState.v2Controller);
    applyCurrentView();
  };
  window.addEventListener("resize", playerState.resizeHandler);

  hideOverlay();
  setStatus("Cubism 2 就绪", "success");
}

async function initCubism3(modelPath, loadId) {
  setStatus("加载 Cubism 3 运行时…");
  showOverlay("正在初始化 Cubism 3…");
  await ensureCubism3Runtime();
  if (!isLoadActive(loadId)) {
    return;
  }

  await waitForLayout();
  if (!isLoadActive(loadId)) {
    return;
  }

  setStatus("读取 Cubism 3 模型配置…");
  const model3Json = await fetchJson(modelPath);
  if (!isLoadActive(loadId)) {
    return;
  }

  const resolvedSettings = await buildCubism3Settings(modelPath, model3Json);
  if (!isLoadActive(loadId)) {
    return;
  }

  const motionEntries = extractCubism3MotionEntries(resolvedSettings);
  setStatus("加载 Cubism 3 模型…");
  currentModel = await PIXI.live2d.Live2DModel.from(resolvedSettings, {
    autoFocus: false
  });
  if (!isLoadActive(loadId)) {
    currentModel.destroy?.({ children: true });
    currentModel = null;
    return;
  }

  currentModel.baseBounds = measureCubism3DisplayBounds(currentModel) ||
    measureCubism3Bounds(currentModel) || {
      centerX: Math.max(currentModel.width, 1) * 0.5,
      centerY: Math.max(currentModel.height, 1) * 0.5,
      height: Math.max(currentModel.height, 1),
      width: Math.max(currentModel.width, 1)
    };

  pixiApp = new PIXI.Application({
    width: Math.max(playerStage.clientWidth, 320),
    height: Math.max(playerStage.clientHeight, 420),
    transparent: true,
    autoStart: true,
    antialias: true
  });

  showV3Surface();
  pixiHost.innerHTML = "";
  pixiHost.appendChild(pixiApp.view);
  pixiApp.stage.addChild(currentModel);
  currentModel.pivot = new PIXI.Point(currentModel.baseBounds.centerX || 0, currentModel.baseBounds.centerY || 0);

  applyCurrentView = () => {
    if (!pixiApp || !currentModel) {
      return;
    }

    const { width, height } = getStageSize();
    currentModel.position = new PIXI.Point(width * 0.5 + viewState.panX, height * 0.53 + viewState.panY);
    const scale = (currentModel.fitScale || 1) * viewState.zoom;
    currentModel.scale = new PIXI.Point(scale, scale);
  };

  resetView();
  fitCubism3Model();
  playerState.resizeHandler = () => {
    fitCubism3Model();
  };
  window.addEventListener("resize", playerState.resizeHandler);

  setMotionOptions(motionEntries);
  const initialMotion =
    playerState.motionEntries.find((entry) => scoreMotionLabel(entry.label) >= 2) || playerState.motionEntries[0];
  if (initialMotion) {
    startMotion(initialMotion.key);
  }

  hideOverlay();
  setStatus("Cubism 3 就绪", "success");
}

async function loadCurrentVariant(relativePath) {
  playerState.loadId += 1;
  const loadId = playerState.loadId;
  playerState.currentModelPath = relativePath;
  updateSubtitle();
  populateVariantOptions();
  setBusy(true);
  cleanupRenderer();
  showOverlay("正在加载模型…");

  try {
    if (version === 2) {
      await initCubism2(relativePath, loadId);
    } else if (version === 3) {
      await initCubism3(relativePath, loadId);
    } else {
      throw new Error("不支持的模型版本。");
    }
  } catch (error) {
    if (!isLoadActive(loadId)) {
      return;
    }

    const message = error instanceof Error ? error.message : "加载失败";
    setStatus(message, "error");
    showOverlay(message, "error");
  } finally {
    if (isLoadActive(loadId)) {
      setBusy(false);
    }
  }
}

variantSelect.addEventListener("change", () => {
  const nextPath = variantSelect.value;
  if (!nextPath || nextPath === playerState.currentModelPath) {
    return;
  }

  const nextParams = new URLSearchParams(window.location.search);
  nextParams.set("path", nextPath);
  window.location.search = nextParams.toString();
});

playMotionButton.addEventListener("click", () => {
  if (!motionSelect.value) {
    return;
  }
  startMotion(motionSelect.value);
});

randomMotionButton.addEventListener("click", () => {
  playRandomMotion();
});

buildViewControls();
bindViewportInteractions();
populateVariantOptions();
updateSubtitle();

async function boot() {
  if (!rootToken || !initialModelPath || ![2, 3].includes(version)) {
    setStatus("参数不完整", "error");
    showOverlay("播放器参数不完整，无法加载模型。", "error");
    return;
  }

  await loadCurrentVariant(initialModelPath);
}

boot();
