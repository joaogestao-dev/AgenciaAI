// Bearer auth com comparacao time-constant para evitar timing attacks

export type AuthResult = { ok: true } | { ok: false; status: number; error: string };

export function authenticate(req: Request): AuthResult {
  const expected = Deno.env.get("PAPERCLIP_WEBHOOK_SECRET");
  if (!expected) {
    return { ok: false, status: 500, error: "PAPERCLIP_WEBHOOK_SECRET nao configurado" };
  }

  const header = req.headers.get("authorization") ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) {
    return { ok: false, status: 401, error: "Authorization Bearer ausente ou malformado" };
  }
  const token = header.slice(7).trim();
  if (!timingSafeEqual(token, expected)) {
    return { ok: false, status: 401, error: "Bearer invalido" };
  }
  return { ok: true };
}

function timingSafeEqual(a: string, b: string): boolean {
  const aBuf = new TextEncoder().encode(a);
  const bBuf = new TextEncoder().encode(b);
  if (aBuf.byteLength !== bBuf.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < aBuf.byteLength; i++) diff |= aBuf[i] ^ bBuf[i];
  return diff === 0;
}
