import fs from "node:fs/promises";
import path from "node:path";

export async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" && fallback !== null) return fallback;
    throw error;
  }
}

export async function writeJsonAtomic(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`);
  await fs.rename(tmpPath, filePath);
}

export function resolveFromConfig(configPath, value) {
  if (!value) return null;
  if (path.isAbsolute(value)) return value;
  return path.resolve(path.dirname(configPath), value);
}

export async function readFileQuietly(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

export async function removeFileQuietly(filePath) {
  try {
    await fs.rm(filePath, { force: true });
  } catch {
    // Best effort cleanup only.
  }
}

export async function appendJsonLine(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(data)}\n`, "utf8");
}

export function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

export function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function makeKey(providerId, model) {
  return `${providerId}::${model}`;
}

export function normalizePathSegment(value, fallback) {
  const normalized = String(value || fallback).trim().replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

export async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  return { response, payload, text };
}

export function providerUrl(provider, providerPath) {
  if (/^https?:\/\//i.test(providerPath)) return providerPath;
  const normalizedPath = providerPath.startsWith("/") ? providerPath : `/${providerPath}`;
  return `${provider.baseUrl}${normalizedPath}`;
}

export function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function jsonScriptEscape(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}
