import { createRemoteJWKSet, jwtVerify } from "jose";

let cachedJwksUrl;
let cachedJwks;

function authConfiguration() {
  const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
  if (!supabaseUrl) throw new Error("SUPABASE_URL is not configured.");
  return {
    issuer: `${supabaseUrl}/auth/v1`,
    audience: process.env.SUPABASE_JWT_AUDIENCE || "authenticated",
    jwksUrl: new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`),
  };
}

function bearerToken(request) {
  const authorization = request.headers.get("authorization") ?? "";
  return /^Bearer\s+([^\s]+)$/i.exec(authorization)?.[1] ?? null;
}

function jwksFor(url) {
  const value = url.toString();
  if (!cachedJwks || cachedJwksUrl !== value) {
    cachedJwksUrl = value;
    cachedJwks = createRemoteJWKSet(url);
  }
  return cachedJwks;
}

export async function requireVerifiedAccount(request) {
  const token = bearerToken(request);
  if (!token) {
    return { ok: false, status: 401, error: "Authentication required." };
  }
  try {
    const configuration = authConfiguration();
    const { payload } = await jwtVerify(token, jwksFor(configuration.jwksUrl), {
      issuer: configuration.issuer,
      audience: configuration.audience,
    });
    const subject = String(payload.sub ?? "").trim();
    const email = String(payload.email ?? "").trim().toLowerCase();
    if (!subject || !email) {
      return { ok: false, status: 401, error: "Verified email required." };
    }
    return { ok: true, subject, email };
  } catch (error) {
    console.warn(
      "App access token rejected:",
      error instanceof Error ? error.code ?? error.name : "unknown_error",
    );
    return { ok: false, status: 401, error: "Invalid or expired session." };
  }
}
