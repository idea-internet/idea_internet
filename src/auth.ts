import { RESERVED_SUBDOMAINS } from "./reserved";

export function generateApiKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hashPassword(password: string, salt?: Uint8Array): Promise<{ hash: string; salt: string }> {
  const encoder = new TextEncoder();
  const saltBytes = salt || crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const hashBuffer = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    256
  );
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  const saltHex = Array.from(saltBytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return { hash: hashHex, salt: saltHex };
}

export async function verifyPassword(password: string, saltHex: string, hashHex: string): Promise<boolean> {
  const saltBytes = new Uint8Array(saltHex.match(/.{2}/g)!.map((byte) => parseInt(byte, 16)));
  const { hash } = await hashPassword(password, saltBytes);
  return hash === hashHex;
}

export function isReservedSubdomain(subdomain: string): boolean {
  return RESERVED_SUBDOMAINS.has(subdomain.toLowerCase());
}

export function sanitizeSubdomain(subdomain: string): string {
  return subdomain.toLowerCase().replace(/[^a-z0-9-]/g, "").replace(/^-+|-+$/g, "").slice(0, 63);
}

export function isValidSubdomain(subdomain: string): boolean {
  if (!subdomain || subdomain.length < 1 || subdomain.length > 63) return false;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(subdomain)) return false;
  return true;
}

export function isValidPath(path: string): boolean {
  if (path.includes("..")) return false;
  if (path.includes("\\")) return false;
  if (path.startsWith("//")) return false;
  return true;
}

export function getContentType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  const types: Record<string, string> = {
    html: "text/html",
    htm: "text/html",
    css: "text/css",
    js: "application/javascript",
    mjs: "application/javascript",
    json: "application/json",
    xml: "application/xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    ico: "image/x-icon",
    pdf: "application/pdf",
    txt: "text/plain",
    md: "text/markdown",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    mp4: "video/mp4",
    webm: "video/webm",
    zip: "application/zip",
    gz: "application/gzip",
    tar: "application/x-tar",
    eot: "application/vnd.ms-fontobject",
    ttf: "font/ttf",
    otf: "font/otf",
    woff: "font/woff",
    woff2: "font/woff2",
    wasm: "application/wasm",
    webmanifest: "application/manifest+json",
    manifest: "application/manifest+json",
    map: "application/json",
    avif: "image/avif",
    bmp: "image/bmp",
    tiff: "image/tiff",
    flv: "video/x-flv",
    mov: "video/quicktime",
    avi: "video/x-msvideo",
    ogg: "audio/ogg",
    oga: "audio/ogg",
    ogv: "video/ogg",
    aac: "audio/aac",
    flac: "audio/flac",
    csv: "text/csv",
    rss: "application/rss+xml",
    atom: "application/atom+xml",
    yaml: "text/yaml",
    yml: "text/yaml",
    toml: "text/toml",
    sh: "text/x-shellscript",
    bat: "text/plain",
    ps1: "text/plain",
    epub: "application/epub+zip",
    rar: "application/vnd.rar",
    "7z": "application/x-7z-compressed",
  };
  return types[ext] || "application/octet-stream";
}

export function generateId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function generateDeploymentId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return "dep_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
