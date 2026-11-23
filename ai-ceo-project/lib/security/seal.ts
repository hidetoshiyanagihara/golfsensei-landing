import crypto from "node:crypto";

/**
 * データベースに置く合鍵の暗号化（AES-256-GCM）。鍵はデータベースの外にある秘密（例：YT_CLIENT_SECRET）から作る。
 * データベースが読まれても、外の秘密がなければ合鍵は取り出せない。
 */
function key(secret: string, purpose: string): Buffer {
  return crypto.createHash("sha256").update(`seal:v1:${purpose}:${secret}`).digest();
}

export function seal(plain: string, secret: string, purpose: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(secret, purpose), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function unseal(sealed: string, secret: string, purpose: string): string | null {
  const [v, iv, tag, body] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || !body) return null;
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", key(secret, purpose), Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(body, "base64url")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}
