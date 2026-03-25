const state = {
  autoExpandedFolders: new Set(),
  collapsedFolders: new Set(),
  config: null,
  currentPreviewModelId: null,
  expandedFolders: new Set(),
  filteredModels: [],
  isPreviewExpanded: false,
  models: []
};

const rootInput = document.querySelector("#rootInput");
const scanButton = document.querySelector("#scanButton");
const searchInput = document.querySelector("#searchInput");
const versionFilter = document.querySelector("#versionFilter");
const clearPreviewButton = document.querySelector("#clearPreviewButton");
const scanStatus = document.querySelector("#scanStatus");
const summaryStats = document.querySelector("#summaryStats");
const visibleCount = document.querySelector("#visibleCount");
const previewCount = document.querySelector("#previewCount");
const modelList = document.querySelector("#modelList");
const previewHost = document.querySelector("#previewHost");
const layout = document.querySelector(".layout");
const togglePreviewSizeButton = document.querySelector("#togglePreviewSizeButton");

function setStatus(message, tone = "default") {
  scanStatus.textContent = message;
  scanStatus.style.background =
    tone === "error"
      ? "rgba(164, 34, 15, 0.12)"
      : tone === "success"
        ? "rgba(45, 79, 108, 0.12)"
        : "rgba(205, 83, 52, 0.12)";
  scanStatus.style.color = tone === "error" ? "#8b2010" : tone === "success" ? "#2d4f6c" : "#7f2d1d";
}

function getVersionLabel(version) {
  return version === 2 ? "Cubism 2" : "Cubism 3";
}

function escapeQueryValue(value) {
  return encodeURIComponent(value);
}

function encodeJsonQueryValue(value) {
  return JSON.stringify(value || []);
}

function normalizePathValue(value) {
  return String(value || "").replaceAll("\\", "/");
}

function compareText(left, right) {
  return String(left || "").localeCompare(String(right || ""), "zh-Hans-CN");
}

function getModelPath(model) {
  return normalizePathValue(model.groupPath || model.displayPath || model.relativePath);
}

function getModelFolderSegments(model) {
  return getModelPath(model)
    .split("/")
    .filter(Boolean)
    .slice(0, -1);
}

function getFolderPath(segments, endIndex) {
  return segments.slice(0, endIndex + 1).join("/");
}

function getModelMeta(model) {
  const variantCount = Array.isArray(model.variants) ? model.variants.length : 1;
  return variantCount > 1 ? `${variantCount} 个内部变体` : "单一模型";
}

function getModelFileLabel(model) {
  const relativePath = normalizePathValue(model.relativePath || model.displayPath || "");
  const folderPrefix = getModelFolderSegments(model).join("/");

  if (!folderPrefix || !relativePath.startsWith(`${folderPrefix}/`)) {
    return relativePath;
  }

  return relativePath.slice(folderPrefix.length + 1);
}

function collectAutoExpandedFolders(models, keyword) {
  const expandedFolders = new Set();
  const shouldExpandMatches = Boolean(keyword);

  for (const model of models) {
    if (!shouldExpandMatches && model.id !== state.currentPreviewModelId) {
      continue;
    }

    const folderSegments = getModelFolderSegments(model);
    for (let index = 0; index < folderSegments.length; index += 1) {
      expandedFolders.add(getFolderPath(folderSegments, index));
    }
  }

  return expandedFolders;
}

async function fetchConfig() {
  const response = await fetch("/api/config");
  if (!response.ok) {
    throw new Error("读取配置失败");
  }
  return response.json();
}

async function scanModels() {
  const root = rootInput.value.trim();
  if (!root) {
    setStatus("请先输入模型根路径", "error");
    return;
  }

  setStatus("正在扫描模型目录…");
  scanButton.disabled = true;

  try {
    const response = await fetch(`/api/models?root=${escapeQueryValue(root)}`);
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "扫描失败");
    }

    state.models = payload.models;
    state.expandedFolders = new Set();
    state.autoExpandedFolders = new Set();
    state.collapsedFolders = new Set();

    updateSummary(payload.summary);
    clearPreview();
    setStatus(`扫描完成，共 ${payload.summary.total} 个模型`, "success");
  } catch (error) {
    state.models = [];
    state.filteredModels = [];
    state.expandedFolders = new Set();
    state.autoExpandedFolders = new Set();
    state.collapsedFolders = new Set();
    renderModelList();
    summaryStats.textContent = "";
    setStatus(error instanceof Error ? error.message : "扫描失败", "error");
  } finally {
    scanButton.disabled = false;
  }
}

function updateSummary(summary) {
  summaryStats.textContent = `总数 ${summary.total} · Cubism 2 ${summary.cubism2} · Cubism 3 ${summary.cubism3}`;
}

function getSearchText() {
  return searchInput.value.trim().toLowerCase();
}

function filterModels() {
  const keyword = getSearchText();
  const version = versionFilter.value;

  state.filteredModels = state.models.filter((model) => {
    const matchVersion = version === "all" || String(model.version) === version;
    if (!matchVersion) {
      return false;
    }

    if (!keyword) {
      return true;
    }

    const haystack = `${model.name} ${model.displayPath || model.relativePath} ${model.relativePath} cubism ${model.version}`.toLowerCase();
    return haystack.includes(keyword);
  });

  state.autoExpandedFolders = collectAutoExpandedFolders(state.filteredModels, keyword);
}

function compareModels(left, right) {
  const pathDiff = compareText(getModelPath(left), getModelPath(right));
  if (pathDiff !== 0) {
    return pathDiff;
  }

  if (left.version !== right.version) {
    return left.version - right.version;
  }

  return compareText(left.name, right.name);
}

function createFolderNode(name, path) {
  return {
    containsActive: false,
    folderMap: new Map(),
    folders: [],
    modelCount: 0,
    models: [],
    name,
    path
  };
}

function buildModelTree(models) {
  const root = createFolderNode("", "");

  for (const model of models) {
    const folderSegments = getModelFolderSegments(model);
    let currentNode = root;

    folderSegments.forEach((segment, index) => {
      let nextNode = currentNode.folderMap.get(segment);
      if (!nextNode) {
        nextNode = createFolderNode(segment, getFolderPath(folderSegments, index));
        currentNode.folderMap.set(segment, nextNode);
        currentNode.folders.push(nextNode);
      }
      currentNode = nextNode;
    });

    currentNode.models.push(model);
  }

  finalizeTree(root);
  return root;
}

function finalizeTree(node) {
  node.folders.sort((left, right) => compareText(left.name, right.name));
  node.models.sort(compareModels);

  let modelCount = node.models.length;
  let containsActive = node.models.some((model) => model.id === state.currentPreviewModelId);

  for (const folder of node.folders) {
    finalizeTree(folder);
    modelCount += folder.modelCount;
    containsActive = containsActive || folder.containsActive;
  }

  node.modelCount = modelCount;
  node.containsActive = containsActive;
}

function countFolders(node) {
  let total = 0;

  for (const folder of node.folders) {
    total += 1 + countFolders(folder);
  }

  return total;
}

function isFolderExpanded(folderPath, depth) {
  if (state.collapsedFolders.has(folderPath)) {
    return false;
  }

  return state.expandedFolders.has(folderPath) || state.autoExpandedFolders.has(folderPath);
}

function toggleFolder(folder, depth) {
  const expanded = isFolderExpanded(folder.path, depth);

  if (expanded) {
    if (folder.containsActive) {
      clearPreview({ render: false });
    }
    state.expandedFolders.delete(folder.path);
    state.collapsedFolders.add(folder.path);
  } else {
    state.collapsedFolders.delete(folder.path);
    state.expandedFolders.add(folder.path);
  }

  renderModelList();
}

function createFolderBranch(folder, depth) {
  const expanded = isFolderExpanded(folder.path, depth);
  const branch = document.createElement("div");
  branch.className = "tree-branch";

  const toggleButton = document.createElement("button");
  toggleButton.type = "button";
  toggleButton.className = "folder-toggle";
  toggleButton.style.setProperty("--tree-depth", String(depth));
  toggleButton.setAttribute("aria-expanded", String(expanded));
  if (folder.containsActive) {
    toggleButton.classList.add("is-active-branch");
  }

  const caret = document.createElement("span");
  caret.className = "folder-caret";
  caret.textContent = expanded ? "▾" : "▸";

  const folderInfo = document.createElement("span");
  folderInfo.className = "folder-info";

  const folderName = document.createElement("span");
  folderName.className = "folder-name";
  folderName.textContent = folder.name;

  const folderMeta = document.createElement("span");
  folderMeta.className = "folder-meta";
  folderMeta.textContent = `${folder.modelCount} 个模型`;

  const folderCount = document.createElement("span");
  folderCount.className = "folder-count";
  folderCount.textContent = String(folder.modelCount);

  folderInfo.append(folderName, folderMeta);
  toggleButton.append(caret, folderInfo, folderCount);
  toggleButton.addEventListener("click", () => {
    toggleFolder(folder, depth);
  });

  branch.appendChild(toggleButton);

  if (expanded) {
    const children = document.createElement("div");
    children.className = "folder-children";
    appendTreeChildren(children, folder, depth + 1);
    branch.appendChild(children);
  }

  return branch;
}

function createModelLeaf(model, depth) {
  const leaf = document.createElement("button");
  leaf.type = "button";
  leaf.className = "model-tree-item";
  leaf.style.setProperty("--tree-depth", String(depth));
  if (state.currentPreviewModelId === model.id) {
    leaf.classList.add("is-active");
  }

  const head = document.createElement("div");
  head.className = "model-tree-head";

  const name = document.createElement("strong");
  name.className = "model-name";
  name.textContent = model.name;

  const versionTag = document.createElement("span");
  versionTag.className = "version-tag";
  versionTag.classList.add(model.version === 2 ? "v2" : "v3");
  versionTag.textContent = getVersionLabel(model.version);

  head.append(name, versionTag);

  const pathNode = document.createElement("div");
  pathNode.className = "model-path";
  pathNode.textContent = getModelFileLabel(model);

  const metaNode = document.createElement("div");
  metaNode.className = "model-meta";
  metaNode.textContent = getModelMeta(model);

  leaf.append(head, pathNode, metaNode);
  leaf.addEventListener("click", () => {
    openPreview(model);
  });

  return leaf;
}

function appendTreeChildren(container, node, depth) {
  for (const folder of node.folders) {
    container.appendChild(createFolderBranch(folder, depth));
  }

  for (const model of node.models) {
    container.appendChild(createModelLeaf(model, depth));
  }
}

function renderModelList() {
  filterModels();
  modelList.innerHTML = "";

  if (state.filteredModels.length === 0) {
    visibleCount.textContent = "0 个结果";
    modelList.innerHTML = `<div class="empty-state"><p>没有匹配的模型。</p></div>`;
    return;
  }

  const tree = buildModelTree(state.filteredModels);
  const folderCount = countFolders(tree);
  visibleCount.textContent =
    folderCount > 0 ? `${state.filteredModels.length} 个模型 · ${folderCount} 个目录` : `${state.filteredModels.length} 个模型`;

  const fragment = document.createDocumentFragment();
  appendTreeChildren(fragment, tree, 0);
  modelList.appendChild(fragment);
}

function syncPreviewLayout() {
  document.body.classList.toggle("preview-expanded", state.isPreviewExpanded);
  layout.classList.toggle("is-preview-expanded", state.isPreviewExpanded);
  togglePreviewSizeButton.textContent = state.isPreviewExpanded ? "还原布局" : "放大预览";
  togglePreviewSizeButton.setAttribute("aria-pressed", String(state.isPreviewExpanded));
}

function buildPlayerUrl(model) {
  const params = new URLSearchParams({
    name: model.name,
    displayPath: model.displayPath || model.relativePath,
    path: model.relativePath,
    rootToken: model.rootToken,
    variants: encodeJsonQueryValue(model.variants),
    version: String(model.version)
  });

  return `/player.html?${params.toString()}`;
}

function openPreview(model) {
  const folderSegments = getModelFolderSegments(model);
  for (let index = 0; index < folderSegments.length; index += 1) {
    state.collapsedFolders.delete(getFolderPath(folderSegments, index));
  }

  state.currentPreviewModelId = model.id;
  previewCount.textContent = `${model.name} · ${getVersionLabel(model.version)}`;
  previewHost.innerHTML = "";

  const frame = document.createElement("iframe");
  frame.className = "single-preview-frame";
  frame.loading = "eager";
  frame.referrerPolicy = "no-referrer";
  frame.src = buildPlayerUrl(model);
  previewHost.appendChild(frame);

  renderModelList();
}

function clearPreview(options = {}) {
  const { render = true } = options;
  state.currentPreviewModelId = null;
  previewCount.textContent = "未选择模型";
  previewHost.innerHTML = `<div class="empty-state"><p>预览区已清空。</p></div>`;
  if (render) {
    renderModelList();
  }
}

function togglePreviewSize() {
  state.isPreviewExpanded = !state.isPreviewExpanded;
  syncPreviewLayout();
}

scanButton.addEventListener("click", scanModels);
searchInput.addEventListener("input", renderModelList);
versionFilter.addEventListener("change", renderModelList);
clearPreviewButton.addEventListener("click", clearPreview);
togglePreviewSizeButton.addEventListener("click", togglePreviewSize);

window.addEventListener("DOMContentLoaded", async () => {
  try {
    syncPreviewLayout();
    state.config = await fetchConfig();
    rootInput.value = state.config.defaultModelRoot || "";
    setStatus("读取配置完成");
    if (rootInput.value) {
      await scanModels();
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "初始化失败", "error");
  }
});
