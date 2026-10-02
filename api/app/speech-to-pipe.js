import { neon } from "@neondatabase/serverless";
import { requireVerifiedAccount } from "../_lib/app-auth.js";
import { appCorsHeaders, appJson, requireAllowedAppOrigin } from "../_lib/app-http.js";
import { SPEECH_TO_PIPE_RESPONSE_FORMAT, SPEECH_TO_PIPE_SYSTEM_PROMPT } from "../_lib/speech-to-pipe-prompt.js";
import { createSpeechToPipeStore } from "../_lib/speech-to-pipe-store.js";

const MAX_BODY_BYTES = 32 * 1024;
const MAX_INSTRUCTION_CHARS = 1200;
const MAX_HISTORY_MESSAGES = 6;
const MAX_HISTORY_CHARS = 1200;
const DEFAULT_MODEL = "gpt-6-luna";
const DEFAULT_REASONING_EFFORT = "none";
const REASONING_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);
const DEFAULT_DAILY_LIMIT = 10;
const UPSTREAM_TIMEOUT_MS = 20_000;
const OUTCOMES = new Set([
  "validationRejected", "previewCancelled", "applied",
  "executionFailed", "undone", "corrected",
]);
const databaseUrl = process.env.STORAGE_DATABASE_URL_UNPOOLED;
const sql = databaseUrl ? neon(databaseUrl) : null;
const defaultStore = sql ? createSpeechToPipeStore(sql) : null;
const sharedRateLimiter = createMemoryRateLimiter();

export const config = { maxDuration: 30 };

export function OPTIONS(request) {
  const { origin, allowed } = requireAllowedAppOrigin(request);
  if (!allowed) return appJson({ error: "Origin not allowed." }, 403, origin);
  return new Response(null, { status: 204, headers: appCorsHeaders(origin) });
}

export function createSpeechToPipeHandler({
  environment = process.env,
  fetcher = globalThis.fetch,
  verifier = requireVerifiedAccount,
  store = defaultStore,
  rateLimiter = sharedRateLimiter,
  now = () => Date.now(),
} = {}) {
  return async function speechToPipeHandler(request) {
    const { origin, allowed } = requireAllowedAppOrigin(request);
    if (!allowed) return appJson({ error: "Origin not allowed." }, 403, origin);
    if (!store) return appJson({ error: "Speech-to-Pipe is unavailable." }, 503, origin);
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > MAX_BODY_BYTES) {
      return appJson({ error: "Speech-to-Pipe request is too large." }, 413, origin);
    }

    const identity = await verifier(request);
    if (!identity.ok) return appJson({ error: identity.error }, identity.status, origin);
    if (!rateLimiter.allow(identity.subject)) {
      return appJson({ error: "Too many requests. Try again shortly." }, 429, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return appJson({ error: "Invalid Speech-to-Pipe request." }, 400, origin);
    }
    if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_BODY_BYTES) {
      return appJson({ error: "Speech-to-Pipe request is too large." }, 413, origin);
    }

    if (body?.mode === "outcome") {
      return recordOutcome({ body, identity, store, origin });
    }
    if (!validInterpretRequest(body)) {
      return appJson({ error: "Invalid Speech-to-Pipe request." }, 400, origin);
    }

    const dailyLimit = positiveInteger(environment.SPEECH_TO_PIPE_DAILY_LIMIT, DEFAULT_DAILY_LIMIT);
    const requestContext = {
      history: body.history,
      drawingContext: body.drawingContext ?? null,
      selection: body.selection ?? null,
    };
    let started;
    try {
      started = await store.startSubmission({
        identity,
        dailyLimit,
        assistanceId: body.assistanceId ?? null,
        instruction: body.instruction.trim(),
        requestContext,
      });
    } catch (error) {
      console.error("Speech-to-Pipe allowance lookup failed", error instanceof Error ? error.message : error);
      return appJson({ error: "Speech-to-Pipe is unavailable." }, 503, origin);
    }
    if (!started.allowed) {
      if (started.reason === "paid") {
        return appJson({ error: "Speech-to-Pipe — Beta is available to paid accounts." }, 403, origin);
      }
      if (started.reason === "quota") {
        return appJson({ error: `Your daily Speech-to-Pipe allowance of ${dailyLimit} submissions has been used.` }, 429, origin);
      }
      return appJson({ error: "That clarification session is no longer available." }, 400, origin);
    }

    const apiKey = environment.OPENAI_API_KEY?.trim();
    const model = environment.SPEECH_TO_PIPE_MODEL?.trim() || DEFAULT_MODEL;
    const reasoningEffort = configuredReasoningEffort(environment.SPEECH_TO_PIPE_REASONING_EFFORT);
    if (!apiKey) {
      await safeFail(store, started, model, reasoningEffort, "configuration", "OPENAI_API_KEY is missing", 0);
      return appJson({ error: "Speech-to-Pipe is not configured." }, 503, origin);
    }

    const requestStartedAt = now();
    const apiBaseUrl = (environment.AI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
    let upstreamResponse;
    try {
      upstreamResponse = await fetcher(`${apiBaseUrl}/responses`, {
        method: "POST",
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          reasoning: { effort: reasoningEffort },
          instructions: SPEECH_TO_PIPE_SYSTEM_PROMPT,
          input: responseInput(body, started),
          max_output_tokens: 900,
          store: false,
          text: { format: SPEECH_TO_PIPE_RESPONSE_FORMAT },
        }),
      });
    } catch (error) {
      const latencyMs = Math.max(0, now() - requestStartedAt);
      await safeFail(store, started, model, reasoningEffort, "upstream", error?.name ?? "request failed", latencyMs);
      return appJson({ error: "Speech-to-Pipe could not reach the language service." }, 502, origin);
    }

    const result = await safelyReadJson(upstreamResponse);
    const latencyMs = Math.max(0, now() - requestStartedAt);
    if (!upstreamResponse.ok) {
      await safeFail(store, started, model, reasoningEffort, "upstream", `HTTP ${upstreamResponse.status}`, latencyMs);
      return appJson({ error: "Speech-to-Pipe could not interpret that instruction." }, 502, origin);
    }
    const reply = enforceConversationContinuity(
      structuredReply(responseText(result)),
      started,
    );
    if (!reply) {
      await safeFail(store, started, model, reasoningEffort, "structured_output", "Invalid structured response", latencyMs);
      return appJson({ error: "Speech-to-Pipe returned an invalid plan." }, 502, origin);
    }

    const inputTokens = nonNegativeInteger(result?.usage?.input_tokens);
    const outputTokens = nonNegativeInteger(result?.usage?.output_tokens);
    const estimatedCostMicros = estimateCostMicros(inputTokens, outputTokens, environment);
    try {
      await store.completeSubmission({
        started, model, reasoningEffort,
        upstreamRequestId: upstreamResponse.headers.get("x-request-id"),
        reply, inputTokens, outputTokens, estimatedCostMicros, latencyMs,
      });
    } catch (error) {
      console.error("Speech-to-Pipe assistance report failed", error instanceof Error ? error.message : error);
    }
    return appJson({
      assistanceId: started.assistanceId,
      remainingRequests: started.remaining,
      ...reply,
    }, 200, origin);
  };
}

export const POST = createSpeechToPipeHandler();

async function recordOutcome({ body, identity, store, origin }) {
  if (!validOutcomeRequest(body)) {
    return appJson({ error: "Invalid Speech-to-Pipe outcome." }, 400, origin);
  }
  try {
    const recorded = await store.recordOutcome({
      identity,
      assistanceId: body.assistanceId,
      outcome: body.outcome,
      stage: body.stage ?? null,
      message: body.message ?? null,
      steps: body.steps,
    });
    if (!recorded) return appJson({ error: "Assistance report not found." }, 404, origin);
    return appJson({ ok: true }, 200, origin);
  } catch (error) {
    console.error("Speech-to-Pipe outcome report failed", error instanceof Error ? error.message : error);
    return appJson({ error: "Unable to record the assistance outcome." }, 500, origin);
  }
}

function responseInput(body, started) {
  return [
    ...body.history.map(({ role, content }) => ({ role, content })),
    {
      role: "user",
      content: JSON.stringify({
        originalInstruction: started.originalInstruction ?? body.instruction.trim(),
        priorFittingRequirements: started.priorRequirements ?? null,
        instruction: body.instruction.trim(),
        drawingContext: body.drawingContext ?? null,
        selection: body.selection ?? null,
      }),
    },
  ];
}

function validInterpretRequest(body) {
  return Boolean(
    body && body.version === 1 && body.mode === "interpret" &&
    typeof body.instruction === "string" && body.instruction.trim().length > 0 &&
    body.instruction.length <= MAX_INSTRUCTION_CHARS &&
    Array.isArray(body.history) && body.history.length <= MAX_HISTORY_MESSAGES &&
    body.history.every((item) => item &&
      (item.role === "user" || item.role === "assistant") &&
      typeof item.content === "string" && item.content.length <= MAX_HISTORY_CHARS) &&
    optionalObject(body.drawingContext) && optionalObject(body.selection) &&
    optionalUuid(body.assistanceId) && optionalUuid(body.correctionOf)
  );
}

function validOutcomeRequest(body) {
  return Boolean(
    body && body.version === 1 && body.mode === "outcome" &&
    typeof body.assistanceId === "string" && optionalUuid(body.assistanceId) &&
    OUTCOMES.has(body.outcome) && optionalString(body.stage) &&
    optionalString(body.message) && Array.isArray(body.steps) &&
    body.steps.length <= 6 && body.steps.every((step) => typeof step === "string" && step.length <= 500)
  );
}

function structuredReply(value) {
  const parsed = safelyParse(value);
  if (!parsed || !["ready", "clarification", "unsupported"].includes(parsed.status) ||
      typeof parsed.message !== "string" || !parsed.message.trim() ||
      !parsed.source || !["default", "selected", "reference"].includes(parsed.source.mode) ||
      !validFittingRequirements(parsed.requirements) ||
      !Array.isArray(parsed.operations) || parsed.operations.length > 6) return null;
  const question = typeof parsed.question === "string" && parsed.question.trim() ? parsed.question.trim() : null;
  if (parsed.status === "ready" && (parsed.operations.length === 0 || question !== null)) return null;
  if (parsed.status === "clarification" && (!question || parsed.operations.length !== 0)) return null;
  if (parsed.status === "unsupported" && parsed.operations.length !== 0) return null;
  if (parsed.source.mode === "reference" && typeof parsed.source.fittingType !== "string") return null;
  return {
    status: parsed.status,
    message: parsed.message.trim(),
    question,
    source: parsed.source,
    requirements: parsed.requirements,
    operations: parsed.operations,
  };
}

function enforceConversationContinuity(reply, started) {
  if (!reply) return null;
  const prior = started.priorRequirements?.fittingRoles ?? [];
  const current = reply.requirements.fittingRoles;
  const retained = prior.every((requiredRole) => current.some((candidate) =>
    sameFittingRole(requiredRole, candidate) &&
    (requiredRole.fittingType == null ||
      requiredRole.fittingType === candidate.fittingType)
  ));
  const readyIsComplete = reply.status !== "ready" ||
    (current.every((role) => typeof role.fittingType === "string" && role.fittingType.length > 0) &&
      current.every((role) => fittingRoleIsRepresented(role, reply)));
  if (retained && readyIsComplete) return reply;

  const requirements = mergeFittingRequirements(prior, current);
  const unresolved = requirements.fittingRoles
    .filter((role) => role.fittingType == null)
    .map((role) => role.role);
  return {
    status: "clarification",
    message: "The fitting requirements still need to be resolved before preview.",
    question: unresolved.length > 0
      ? `Which fitting belongs in the unresolved ${[...new Set(unresolved)].join(" and ")} position?`
      : "Please confirm the complete fitting-to-fitting instruction so no fitting is dropped.",
    source: reply.source,
    requirements,
    operations: [],
  };
}

function mergeFittingRequirements(prior, current) {
  const merged = new Map();
  for (const role of prior) merged.set(fittingRoleKey(role), { ...role });
  for (const role of current) {
    const key = fittingRoleKey(role);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...role });
    } else if (existing.fittingType == null && role.fittingType != null) {
      merged.set(key, { ...existing, fittingType: role.fittingType });
    }
  }
  return { fittingRoles: [...merged.values()] };
}

function validFittingRequirements(value) {
  if (!value || !Array.isArray(value.fittingRoles) || value.fittingRoles.length > 18) {
    return false;
  }
  const keys = new Set();
  for (const role of value.fittingRoles) {
    if (!role || !Number.isInteger(role.operationIndex) ||
        role.operationIndex < 0 || role.operationIndex > 5 ||
        !["start", "end", "fitting", "source", "reference"].includes(role.role) ||
        !(role.fittingType == null || (typeof role.fittingType === "string" && role.fittingType.length > 0))) {
      return false;
    }
    const key = fittingRoleKey(role);
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}

function sameFittingRole(left, right) {
  return fittingRoleKey(left) === fittingRoleKey(right);
}

function fittingRoleKey(role) {
  return `${role.operationIndex}:${role.role}`;
}

function fittingRoleIsRepresented(requirement, reply) {
  const operation = reply.operations[requirement.operationIndex];
  if (!operation) return false;
  const type = requirement.fittingType;
  if (operation.kind === "double_ninety" &&
      (requirement.role === "start" || requirement.role === "end")) {
    return type === "ELBOW_90";
  }
  if (requirement.role === "source") {
    return reply.source?.fittingType === type;
  }
  if (requirement.role === "reference") {
    return operation.referenceFittingType === type;
  }
  if (requirement.role === "start") return operation.startFitting === type;
  if (requirement.role === "end") return operation.endFitting === type;
  return operation.fittingType === type;
}

function estimateCostMicros(inputTokens, outputTokens, environment) {
  const inputRate = nonNegativeNumber(environment.SPEECH_TO_PIPE_INPUT_USD_PER_MILLION, 0.10);
  const outputRate = nonNegativeNumber(environment.SPEECH_TO_PIPE_OUTPUT_USD_PER_MILLION, 0.50);
  return Math.round(inputTokens * inputRate + outputTokens * outputRate);
}

export function createMemoryRateLimiter({ limit = 8, periodMs = 60_000, now = () => Date.now() } = {}) {
  const buckets = new Map();
  return { allow(key) {
    const current = now();
    const bucket = buckets.get(key);
    if (!bucket || current >= bucket.resetAt) {
      buckets.set(key, { count: 1, resetAt: current + periodMs });
      return true;
    }
    if (bucket.count >= limit) return false;
    bucket.count += 1;
    return true;
  } };
}

async function safeFail(store, started, model, reasoningEffort, stage, message, latencyMs) {
  try { await store.failSubmission({ started, model, reasoningEffort, stage, message, latencyMs }); }
  catch (error) { console.error("Speech-to-Pipe failure report failed", error instanceof Error ? error.message : error); }
}
function responseText(result) {
  if (typeof result?.output_text === "string") return result.output_text.trim();
  for (const item of result?.output ?? []) for (const part of item?.content ?? [])
    if (part?.type === "output_text" && typeof part.text === "string") return part.text.trim();
  return "";
}
function safelyParse(value) { try { return JSON.parse(value); } catch { return null; } }
async function safelyReadJson(response) { try { return await response.json(); } catch { return null; } }
function optionalObject(value) { return value == null || (typeof value === "object" && !Array.isArray(value)); }
function optionalString(value) { return value == null || (typeof value === "string" && value.length <= 1000); }
function optionalUuid(value) { return value == null || (typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)); }
function positiveInteger(value, fallback) { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback; }
function nonNegativeInteger(value) { return Number.isInteger(value) && value >= 0 ? value : 0; }
function nonNegativeNumber(value, fallback) { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback; }
function configuredReasoningEffort(value) {
  const effort = typeof value === "string" ? value.trim().toLowerCase() : "";
  return REASONING_EFFORTS.has(effort) ? effort : DEFAULT_REASONING_EFFORT;
}
