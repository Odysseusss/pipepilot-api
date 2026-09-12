const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:56069",
  "http://127.0.0.1:56069",
  "https://app.pipepilotapp.com",
];

export function allowedAppOrigins() {
  const configured = process.env.APP_ALLOWED_ORIGINS
    ?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return configured?.length ? configured : DEFAULT_ALLOWED_ORIGINS;
}

export function appCorsHeaders(origin) {
  const headers = {
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Cache-Control": "no-store",
    Vary: "Origin",
  };
  if (origin && allowedAppOrigins().includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

export function appJson(body, status, origin) {
  return Response.json(body, { status, headers: appCorsHeaders(origin) });
}

export function requireAllowedAppOrigin(request) {
  const origin = request.headers.get("origin");
  return {
    origin,
    allowed: Boolean(origin && allowedAppOrigins().includes(origin)),
  };
}
