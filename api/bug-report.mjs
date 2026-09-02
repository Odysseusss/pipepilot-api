const RESEND_ENDPOINT = "https://api.resend.com/emails";
const REPORT_RECIPIENT = "craig@pipepilotapp.com";
const MAX_REPORT_BYTES = 1024 * 1024;

function configuredOrigins() {
  return (process.env.BUG_REPORT_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function setCorsHeaders(response, origin, allowedOrigins) {
  response.setHeader("Vary", "Origin");

  if (origin && allowedOrigins.includes(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
  }
}

function sendJson(response, status, body) {
  return response.status(status).json(body);
}

function parseBody(body) {
  if (Buffer.isBuffer(body)) {
    body = body.toString("utf8");
  }

  if (typeof body === "string") {
    if (Buffer.byteLength(body, "utf8") > MAX_REPORT_BYTES) {
      throw new RangeError("The diagnostic report must be no larger than 1 MiB.");
    }

    try {
      body = JSON.parse(body);
    } catch {
      throw new SyntaxError("The request body must contain valid JSON.");
    }
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new TypeError("The diagnostic report must be a JSON object.");
  }

  if (Object.keys(body).length === 0) {
    throw new TypeError("The diagnostic report must not be empty.");
  }

  let serialized;
  try {
    serialized = JSON.stringify(body, null, 2);
  } catch {
    throw new TypeError("The diagnostic report must be JSON-serializable.");
  }

  if (Buffer.byteLength(serialized, "utf8") > MAX_REPORT_BYTES) {
    throw new RangeError("The diagnostic report must be no larger than 1 MiB.");
  }

  return serialized;
}

function reportSubject(report) {
  const version =
    typeof report.appVersion === "string" && report.appVersion.trim()
      ? ` (${report.appVersion.trim().replace(/[\r\n]+/g, " ").slice(0, 80)})`
      : "";

  return `Pipe Pilot diagnostic report${version}`;
}

export default async function handler(request, response) {
  const origin = request.headers.origin;
  const allowedOrigins = configuredOrigins();
  setCorsHeaders(response, origin, allowedOrigins);

  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return sendJson(response, 405, {
      ok: false,
      error: "Method not allowed. Use POST.",
    });
  }

  if (!origin || !allowedOrigins.includes(origin)) {
    return sendJson(response, 403, {
      ok: false,
      error: "Origin not allowed.",
    });
  }

  const contentType = request.headers["content-type"] ?? "";
  if (contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return sendJson(response, 415, {
      ok: false,
      error: "Content-Type must be application/json.",
    });
  }

  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_REPORT_BYTES) {
    return sendJson(response, 413, {
      ok: false,
      error: "The diagnostic report must be no larger than 1 MiB.",
    });
  }

  let diagnosticJson;
  try {
    diagnosticJson = parseBody(request.body);
  } catch (error) {
    const status = error instanceof RangeError ? 413 : 400;
    return sendJson(response, status, {
      ok: false,
      error: error instanceof Error ? error.message : "Invalid request body.",
    });
  }

  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.BUG_REPORT_FROM?.trim();

  if (!apiKey || !from) {
    console.error("Bug report email is missing required environment variables.");
    return sendJson(response, 503, {
      ok: false,
      error: "Bug reporting is not configured.",
    });
  }

  const report = JSON.parse(diagnosticJson);

  try {
    const resendResponse = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [REPORT_RECIPIENT],
        subject: reportSubject(report),
        text: `A Pipe Pilot diagnostic report was submitted.\n\n${diagnosticJson}`,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!resendResponse.ok) {
      const providerError = await resendResponse.text();
      console.error("Resend rejected a bug report:", resendResponse.status, providerError);
      return sendJson(response, 502, {
        ok: false,
        error: "The diagnostic report could not be sent.",
      });
    }

    const result = await resendResponse.json();
    return sendJson(response, 200, {
      ok: true,
      message: "Diagnostic report sent.",
      reportId: result.id,
    });
  } catch (error) {
    console.error("Failed to send bug report:", error);
    return sendJson(response, 502, {
      ok: false,
      error: "The diagnostic report could not be sent.",
    });
  }
}
