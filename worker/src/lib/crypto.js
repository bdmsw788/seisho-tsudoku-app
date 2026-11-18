export function bytesToBase64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlToBytes(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (str.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function generateRandomToken(byteLength = 32) {
  const buf = new Uint8Array(byteLength);
  crypto.getRandomValues(buf);
  return bytesToBase64Url(buf);
}

export async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hash);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

export function parseVapidPrivateJwk(raw) {
  if (!raw) throw new Error("VAPID_PRIVATE_KEY が設定されていません。");
  const jwk = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y || !jwk.d) {
    throw new Error("VAPID_PRIVATE_KEY は EC P-256 JWK 形式である必要があります。");
  }
  return jwk;
}

export function deriveVapidPublicKey(privateJwk) {
  const jwk = parseVapidPrivateJwk(privateJwk);
  const x = base64UrlToBytes(jwk.x);
  const y = base64UrlToBytes(jwk.y);
  if (x.length !== 32 || y.length !== 32) {
    throw new Error("VAPID JWK の公開鍵座標長が不正です。");
  }
  const uncompressed = new Uint8Array(65);
  uncompressed[0] = 0x04;
  uncompressed.set(x, 1);
  uncompressed.set(y, 33);
  return bytesToBase64Url(uncompressed);
}
