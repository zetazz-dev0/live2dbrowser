import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const configPath = path.join(__dirname, "app-config.json");

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".moc": "application/octet-stream",
  ".moc3": "application/octet-stream",
  ".model3.json": "application/json; charset=utf-8",
  ".motion3.json": "application/json; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".mtn": "application/octet-stream",
  ".ogg": "audio/ogg",
  ".physics3.json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wav": "audio/wav",
  ".webp": "image/webp"
};

function json(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(body);
}

function text(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "text/plain; charset=utf-8"
  });
  res.end(body);
}

function normalizeSlashes(value) {
  return value.replaceAll("\\", "/");
}

function encodeRootToken(rootPath) {
  return Buffer.from(rootPath, "utf8").toString("base64url");
}

function decodeRootToken(rootToken) {
  return Buffer.from(rootToken, "base64url").toString("utf8");
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function ensureInside(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function guessContentType(filePath) {
  const lowerPath = filePath.toLowerCase();
  for (const [extension, contentType] of Object.entries(CONTENT_TYPES)) {
    if (lowerPath.endsWith(extension)) {
      return contentType;
    }
  }

  return "application/octet-stream";
}

async function readConfig() {
  try {
    const raw = (await fs.readFile(configPath, "utf8")).replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw);
    return {
      host: parsed.host || "127.0.0.1",
      port: Number(parsed.port) || 4173,
      defaultModelRoot: parsed.defaultModelRoot || ""
    };
  } catch (error) {
    return {
      host: "127.0.0.1",
      port: 4173,
      defaultModelRoot: ""
    };
  }
}

function makeModelName(groupPath) {
  return path.posix.basename(normalizeSlashes(groupPath));
}

function makeModelId(version, relativePath) {
  return `${version}:${normalizeSlashes(relativePath)}`;
}

function buildPublicAssetUrl(rootToken, relativePath) {
  return `/fs/${rootToken}/${normalizeSlashes(relativePath)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

function stripExtension(fileName, extensionPattern) {
  return fileName.replace(extensionPattern, "");
}

async function isV2ModelSetting(filePath) {
  try {
    const raw = (await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw);
    return Boolean(parsed && typeof parsed.model === "string" && Array.isArray(parsed.textures));
  } catch {
    return false;
  }
}

async function scanModels(modelRoot) {
  const resolvedRoot = path.resolve(modelRoot);
  const rootToken = encodeRootToken(resolvedRoot);
  const stats = await fs.stat(resolvedRoot);
  if (!stats.isDirectory()) {
    throw new Error("模型根路径不是目录");
  }

  const v2Candidates = [];
  const v3Candidates = [];

  function getV2GroupPath(relativePath) {
    const normalizedPath = normalizeSlashes(relativePath);
    const directory = path.posix.dirname(normalizedPath);
    const parentName = path.posix.basename(directory).toLowerCase();

    if (parentName === "normal" || parentName === "destroy") {
      return path.posix.dirname(directory);
    }

    return directory;
  }

  function getV2Priority(relativePath) {
    const normalizedPath = normalizeSlashes(relativePath);
    const directory = path.posix.dirname(normalizedPath);
    const parentName = path.posix.basename(directory).toLowerCase();
    const fileName = path.posix.basename(normalizedPath).toLowerCase();

    if (parentName === "normal" && fileName === "model.json") {
      return 0;
    }

    if (fileName === "model.json") {
      return parentName === "destroy" ? 2 : 1;
    }

    if (fileName === "model.default.json") {
      return 3;
    }

    if (/^model1\.json$/i.test(fileName)) {
      return 4;
    }

    if (/^model\d+\.json$/i.test(fileName)) {
      const numberValue = Number(fileName.match(/\d+/)?.[0] || "99");
      return 10 + numberValue;
    }

    if (/^model\./i.test(fileName)) {
      return 100 + fileName.length;
    }

    return 1000 + fileName.length;
  }

  function chooseV2Entry(entries) {
    return [...entries].sort((left, right) => {
      const priorityDiff = getV2Priority(left.relativePath) - getV2Priority(right.relativePath);
      if (priorityDiff !== 0) {
        return priorityDiff;
      }

      return left.relativePath.localeCompare(right.relativePath, "zh-Hans-CN");
    })[0];
  }

  function chooseV3Entry(entries) {
    return [...entries].sort((left, right) => {
      const leftDirName = path.posix.basename(path.posix.dirname(left.relativePath)).toLowerCase();
      const rightDirName = path.posix.basename(path.posix.dirname(right.relativePath)).toLowerCase();
      const leftFileName = path.posix.basename(left.relativePath).toLowerCase();
      const rightFileName = path.posix.basename(right.relativePath).toLowerCase();
      const leftPriority = leftFileName === `${leftDirName}.model3.json` ? 0 : 1;
      const rightPriority = rightFileName === `${rightDirName}.model3.json` ? 0 : 1;

      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }

      return left.relativePath.localeCompare(right.relativePath, "zh-Hans-CN");
    })[0];
  }

  function sortV2Entries(entries) {
    return [...entries].sort((left, right) => {
      const priorityDiff = getV2Priority(left.relativePath) - getV2Priority(right.relativePath);
      if (priorityDiff !== 0) {
        return priorityDiff;
      }

      return left.relativePath.localeCompare(right.relativePath, "zh-Hans-CN");
    });
  }

  function sortV3Entries(entries) {
    return [...entries].sort((left, right) => {
      const leftDirName = path.posix.basename(path.posix.dirname(left.relativePath)).toLowerCase();
      const rightDirName = path.posix.basename(path.posix.dirname(right.relativePath)).toLowerCase();
      const leftFileName = path.posix.basename(left.relativePath).toLowerCase();
      const rightFileName = path.posix.basename(right.relativePath).toLowerCase();
      const leftPriority = leftFileName === `${leftDirName}.model3.json` ? 0 : 1;
      const rightPriority = rightFileName === `${rightDirName}.model3.json` ? 0 : 1;

      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }

      return left.relativePath.localeCompare(right.relativePath, "zh-Hans-CN");
    });
  }

  function makeV2VariantLabel(groupPath, relativePath) {
    const normalizedGroupPath = normalizeSlashes(groupPath);
    const normalizedPath = normalizeSlashes(relativePath);
    const withinGroup = normalizedPath.startsWith(`${normalizedGroupPath}/`)
      ? normalizedPath.slice(normalizedGroupPath.length + 1)
      : path.posix.basename(normalizedPath);
    const segments = withinGroup.split("/");
    const fileName = segments.at(-1) || "";
    const fileStem = stripExtension(fileName, /\.json$/i);
    const fallbackLabel = path.posix.basename(groupPath);

    if (segments.length === 2 && /^model\.json$/i.test(fileName)) {
      return segments[0];
    }

    let label = fileStem.replace(/\.model$/i, "");
    if (label === "model.default") {
      return "default";
    }

    if (label === "model" || label === "index") {
      return segments.length > 1 ? segments[0] : fallbackLabel;
    }

    if (/^model\./i.test(label)) {
      return label.slice("model.".length);
    }

    return label;
  }

  function makeV3VariantLabel(groupPath, relativePath) {
    const directoryName = path.posix.basename(groupPath).toLowerCase();
    const fileName = path.posix.basename(relativePath);
    const fileStem = stripExtension(fileName, /\.model3\.json$/i);

    if (!fileStem || fileStem.toLowerCase() === directoryName) {
      return "default";
    }

    return fileStem;
  }

  async function walk(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") {
        continue;
      }

      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const lowerName = entry.name.toLowerCase();
      const relativePath = normalizeSlashes(path.relative(resolvedRoot, fullPath));

      if (lowerName.endsWith(".model3.json")) {
        v3Candidates.push({
          groupPath: path.posix.dirname(relativePath),
          relativePath
        });
        continue;
      }

      if (
        !lowerName.endsWith(".json") ||
        lowerName.endsWith(".model3.json") ||
        lowerName.endsWith(".motion3.json") ||
        lowerName.endsWith(".physics3.json")
      ) {
        continue;
      }

      if (await isV2ModelSetting(fullPath)) {
        v2Candidates.push({
          groupPath: getV2GroupPath(relativePath),
          relativePath
        });
      }
    }
  }

  await walk(resolvedRoot);

  const models = [];
  const groupedV2 = new Map();
  for (const candidate of v2Candidates) {
    const groupEntries = groupedV2.get(candidate.groupPath) || [];
    groupEntries.push(candidate);
    groupedV2.set(candidate.groupPath, groupEntries);
  }

  for (const [groupPath, entries] of groupedV2) {
    const sortedEntries = sortV2Entries(entries);
    const chosen = sortedEntries[0];
    models.push({
      displayPath: groupPath,
      groupPath,
      id: makeModelId(2, groupPath),
      name: makeModelName(groupPath),
      relativePath: chosen.relativePath,
      root: resolvedRoot,
      rootToken,
      url: buildPublicAssetUrl(rootToken, chosen.relativePath),
      variants: sortedEntries.map((entry) => ({
        label: makeV2VariantLabel(groupPath, entry.relativePath),
        relativePath: entry.relativePath
      })),
      version: 2
    });
  }

  const groupedV3 = new Map();
  for (const candidate of v3Candidates) {
    const groupEntries = groupedV3.get(candidate.groupPath) || [];
    groupEntries.push(candidate);
    groupedV3.set(candidate.groupPath, groupEntries);
  }

  for (const [groupPath, entries] of groupedV3) {
    const sortedEntries = sortV3Entries(entries);
    const chosen = sortedEntries[0];
    models.push({
      displayPath: groupPath,
      groupPath,
      id: makeModelId(3, groupPath),
      name: makeModelName(groupPath),
      relativePath: chosen.relativePath,
      root: resolvedRoot,
      rootToken,
      url: buildPublicAssetUrl(rootToken, chosen.relativePath),
      variants: sortedEntries.map((entry) => ({
        label: makeV3VariantLabel(groupPath, entry.relativePath),
        relativePath: entry.relativePath
      })),
      version: 3
    });
  }

  models.sort((left, right) => {
    if (left.version !== right.version) {
      return left.version - right.version;
    }

    return left.displayPath.localeCompare(right.displayPath, "zh-Hans-CN");
  });

  const cubism2Count = models.filter((item) => item.version === 2).length;
  const cubism3Count = models.length - cubism2Count;

  return {
    models,
    root: resolvedRoot,
    summary: {
      cubism2: cubism2Count,
      cubism3: cubism3Count,
      total: models.length
    }
  };
}

async function serveStatic(res, requestPath) {
  const normalizedPath = requestPath === "/" ? "/index.html" : requestPath;
  const filePath = path.resolve(publicDir, `.${normalizedPath}`);

  if (!ensureInside(publicDir, filePath)) {
    text(res, 403, "Forbidden");
    return;
  }

  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      text(res, 404, "Not Found");
      return;
    }

    res.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": guessContentType(filePath)
    });

    createReadStream(filePath).pipe(res);
  } catch {
    text(res, 404, "Not Found");
  }
}

async function serveFileFromRoot(res, rootToken, assetPathParam) {
  if (!rootToken || !assetPathParam) {
    json(res, 400, { error: "缺少 token 或 path 参数" });
    return;
  }

  let rootPath;
  try {
    rootPath = path.resolve(decodeRootToken(rootToken));
  } catch {
    json(res, 400, { error: "非法 token" });
    return;
  }

  const requestedPath = path.resolve(rootPath, assetPathParam);

  if (!ensureInside(rootPath, requestedPath)) {
    text(res, 403, "Forbidden");
    return;
  }

  try {
    const stats = await fs.stat(requestedPath);
    if (!stats.isFile()) {
      text(res, 404, "Not Found");
      return;
    }

    res.writeHead(200, {
      "Cache-Control": "public, max-age=300",
      "Content-Type": guessContentType(requestedPath)
    });

    createReadStream(requestedPath).pipe(res);
  } catch {
    text(res, 404, "Not Found");
  }
}

async function listDirectoryFromRoot(rootToken, directoryPathParam) {
  if (!rootToken) {
    throw new Error("缺少 token");
  }

  const rootPath = path.resolve(decodeRootToken(rootToken));
  const requestedPath = path.resolve(rootPath, directoryPathParam || ".");

  if (!ensureInside(rootPath, requestedPath)) {
    throw new Error("Forbidden");
  }

  let stats;
  try {
    stats = await fs.stat(requestedPath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  if (!stats.isDirectory()) {
    return [];
  }

  const entries = await fs.readdir(requestedPath, { withFileTypes: true });
  return entries.map((entry) => ({
    isDirectory: entry.isDirectory(),
    isFile: entry.isFile(),
    name: entry.name
  }));
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
  const pathname = requestUrl.pathname;

  if (pathname === "/api/config") {
    const config = await readConfig();
    json(res, 200, config);
    return;
  }

  if (pathname === "/api/models") {
    const config = await readConfig();
    const rootParam = safeDecodeURIComponent(requestUrl.searchParams.get("root") || "");
    const modelRoot = rootParam || config.defaultModelRoot;

    if (!modelRoot) {
      json(res, 400, { error: "未配置模型根路径" });
      return;
    }

    try {
      const result = await scanModels(modelRoot);
      json(res, 200, result);
    } catch (error) {
      json(res, 500, {
        error: error instanceof Error ? error.message : "扫描模型失败"
      });
    }
    return;
  }

  if (pathname.startsWith("/fs/")) {
    const segments = pathname.split("/").filter(Boolean);
    const rootToken = segments[1] || "";
    const assetPathParam = segments.slice(2).map(safeDecodeURIComponent).join("/");
    await serveFileFromRoot(res, rootToken, assetPathParam);
    return;
  }

  if (pathname === "/api/list") {
    const rootToken = requestUrl.searchParams.get("rootToken") || "";
    const directoryPath = safeDecodeURIComponent(requestUrl.searchParams.get("dir") || "");

    try {
      const entries = await listDirectoryFromRoot(rootToken, directoryPath);
      json(res, 200, { entries });
    } catch (error) {
      json(res, 400, {
        error: error instanceof Error ? error.message : "读取目录失败"
      });
    }
    return;
  }

  await serveStatic(res, pathname);
});

const config = await readConfig();
server.listen(config.port, config.host, () => {
  console.log(`Live2D Viewer running at http://${config.host}:${config.port}`);
});
