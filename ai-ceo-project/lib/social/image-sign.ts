import crypto from "node:crypto";

/**
 * 投稿用の画像を、ログインなしで取り出すための「期限つき署名付きリンク」。
 * Instagram に投稿するとき、Meta のサーバーが画像を取りに来るために使う（ログインできないため）。
 * 鍵は Turso のトークン（サーバーだけが持つ秘密）から作る。
 */
function key(): string | null {
  const t = process.env.TURSO_AUTH_TOKEN || process.env.SESSION_SECRET;
  return t && t.length >= 32 ? `post-image:v1:${t}` : null;
}

function mac(k: string, id: number, kind: string, n: number, exp: number): string {
  return crypto.createHmac("sha256", k).update(`${id}.${kind}.${n}.${exp}`).digest("hex");
}

export function signImage(id: number, kind: string, n = 0, ttlSec = 3600, now = Date.now()): string | null {
  const k = key();
  if (!k) return null;
  const exp = Math.floor(now / 1000) + ttlSec;
  return `exp=${exp}&sig=${mac(k, id, kind, n, exp)}`;
}

export function verifyImage(id: number, kind: string, n: number, exp: number, sig: string, now = Date.now()): boolean {
  const k = key();
  if (!k || !Number.isFinite(exp) || exp < Math.floor(now / 1000) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  return crypto.timingSafeEqual(Buffer.from(mac(k, id, kind, n, exp)), Buffer.from(sig));
}
