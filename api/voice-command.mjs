import { VOICE_COMMAND_SYSTEM_PROMPT } from './_lib/voice-command-prompt.mjs';

const MAX_AUDIO_BYTES = 3 * 1024 * 1024;
const MAX_BODY_BYTES = 4 * 1024 * 1024 + 64 * 1024;
const DEFAULT_MODEL = 'gpt-5-mini';
const DEFAULT_TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';
const DEFAULT_ALLOWED_ORIGINS = [
  'https://app.pipepilotapp.com',
  'https://pipepilot-app-git-codex-voice-command-service-pipe-pilot.vercel.app',
];
const UPSTREAM_CALL_TIMEOUT_MS = 25_000;
const UPSTREAM_TOTAL_BUDGET_MS = 40_000;
const INTERPRETATION_MAX_OUTPUT_TOKENS = 1500;
const DEFAULT_RATE_LIMIT = 12;
const DEFAULT_RATE_WINDOW_MS = 60_000;
const RESPONSE_FORMAT = {
  type: 'json_schema',
  name: 'pipe_pilot_voice_command',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: { type: 'string', enum: ['draw_route', 'rotate_view', 'add_weld_map', 'save_drawing', 'clarification', 'unsupported'] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      ambiguous: { type: 'boolean' },
      route: {
        anyOf: [
          { type: 'null' },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              startFitting: { type: 'string' },
              endFitting: { type: 'string' },
              direction: { type: 'string', enum: ['north', 'south', 'east', 'west', 'up', 'down'] },
              dimensionBasis: { type: 'string', enum: ['end_to_end', 'end_to_center', 'center_to_center'] },
              length: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  feet: { type: 'integer', minimum: 0 },
                  inches: { type: 'integer', minimum: 0 },
                  eighths: { type: 'integer', minimum: 0, maximum: 7 },
                },
                required: ['feet', 'inches', 'eighths'],
              },
            },
            required: ['startFitting', 'endFitting', 'direction', 'dimensionBasis', 'length'],
          },
        ],
      },
      viewpoint: { type: ['string', 'null'], enum: ['SE', 'NE', 'NW', 'SW', null] },
      clarificationQuestion: { type: ['string', 'null'] },
      alternatives: { type: 'array', items: { type: 'string' }, maxItems: 3 },
    },
    required: ['action', 'confidence', 'ambiguous', 'route', 'viewpoint', 'clarificationQuestion', 'alternatives'],
  },
};

export const config = { maxDuration: 45 };

export function createFixedWindowRateLimiter({
  limit = DEFAULT_RATE_LIMIT,
  windowMs = DEFAULT_RATE_WINDOW_MS,
  clock = Date.now,
} = {}) {
  const actors = new Map();
  return (request) => {
    const now = clock();
    const actor = requestActor(request);
    const current = actors.get(actor);
    if (!current || now >= current.resetAt) {
      actors.set(actor, { count: 1, resetAt: now + windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (current.count >= limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
      };
    }
    current.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  };
}

const defaultVoiceRateLimiter = createFixedWindowRateLimiter();

class VoiceUpstreamError extends Error {
  constructor(phase, response, bodyText) {
    super(`${phase}_failed`);
    this.name = 'VoiceUpstreamError';
    this.phase = phase;
    this.status = response.status;
    this.retryAfter = response.headers.get('retry-after');
    this.responseBody = bodyText.slice(0, 2000);
  }
}

class VoiceInterpretationError extends Error {
  constructor(message, responseBody) {
    super(message);
    this.name = 'VoiceInterpretationError';
    this.phase = 'interpretation';
    this.responseBody = JSON.stringify({
      responseStatus: responseBody?.status ?? null,
      incompleteDetails: responseBody?.incomplete_details ?? null,
      outputLength: responseText(responseBody).length,
    });
  }
}

export function createVoiceCommandHandler({
  environment = process.env,
  fetcher = globalThis.fetch,
  rateLimiter = defaultVoiceRateLimiter,
  clock = Date.now,
} = {}) {
  return async function voiceCommandHandler(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    if (!allowRequestOrigin(request, response, environment)) {
      return response.status(403).json({ error: 'Request origin is not allowed.' });
    }
    if (request.method === 'OPTIONS') {
      response.setHeader('Allow', 'POST, OPTIONS');
      return response.status(204).end();
    }
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST, OPTIONS');
      return response.status(405).json({ error: 'Method not allowed.' });
    }
    const rate = rateLimiter(request);
    if (!rate.allowed) {
      response.setHeader('Retry-After', String(rate.retryAfterSeconds));
      return response.status(429).json({ error: 'Too many voice command requests. Try again shortly.' });
    }
    const contentLength = Number(header(request, 'content-length') ?? 0);
    if (contentLength > MAX_BODY_BYTES) {
      return response.status(413).json({ error: 'Voice command request is too large.' });
    }
    const body = await readRequestBody(request);
    if (!body) return response.status(400).json({ error: 'Invalid voice command request.' });
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_BODY_BYTES) {
      return response.status(413).json({ error: 'Voice command request is too large.' });
    }
    const audio = decodeAudio(body);
    if (!audio) return response.status(400).json({ error: 'Invalid voice command request.' });
    const apiKey = environment.OPENAI_API_KEY?.trim();
    if (!apiKey) return response.status(503).json({ error: 'Voice commands are not configured.' });
    const baseUrl = (environment.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
    const upstreamDeadline = clock() + UPSTREAM_TOTAL_BUDGET_MS;
    try {
      const transcript = await transcribe(audio, {
        apiKey,
        baseUrl,
        fetcher,
        model: environment.VOICE_TRANSCRIBE_MODEL || DEFAULT_TRANSCRIBE_MODEL,
        upstreamDeadline,
        clock,
      });
      const command = await interpret(transcript, body, {
        apiKey,
        baseUrl,
        fetcher,
        model: environment.VOICE_COMMAND_MODEL || DEFAULT_MODEL,
        upstreamDeadline,
        clock,
      });
      return response.status(200).json({ transcript, ...command });
    } catch (error) {
      console.error('Voice command upstream failed', {
        name: error?.name ?? 'unknown',
        message: error?.message ?? null,
        phase: error?.phase ?? 'unknown',
        status: error?.status ?? null,
        body: error?.responseBody ?? null,
      });
      if (error instanceof VoiceUpstreamError) {
        if (error.status === 401 || error.status === 403) {
          return response.status(500).json({
            error: 'Voice service is misconfigured.',
            upstreamStage: error.phase,
          });
        }
        if (error.status === 429) {
          if (error.retryAfter) response.setHeader('Retry-After', error.retryAfter);
          return response.status(429).json({
            error: 'Voice service is busy. Try again shortly.',
            upstreamStage: error.phase,
          });
        }
        if (error.status >= 400 && error.status < 500) {
          return response.status(error.status).json({
            error: error.phase === 'transcription'
              ? 'Voice transcription rejected the audio.'
              : 'Voice interpretation request was rejected.',
            upstreamStage: error.phase,
          });
        }
        return response.status(502).json({
          error: 'Voice service upstream is unavailable.',
          upstreamStage: error.phase,
        });
      }
      if (error instanceof VoiceInterpretationError) {
        return response.status(502).json({
          error: 'Voice interpretation returned incomplete data.',
          upstreamStage: error.phase,
        });
      }
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        return response.status(504).json({ error: 'Voice command upstream timed out.' });
      }
      return response.status(502).json({ error: 'Voice command could not be processed.' });
    }
  };
}

async function transcribe(audio, {
  apiKey,
  baseUrl,
  fetcher,
  model,
  upstreamDeadline,
  clock,
}) {
  const form = new FormData();
  form.append('model', model);
  form.append('file', new Blob([audio.bytes], { type: audio.mimeType }), audio.fileName);
  const response = await fetchUpstream(fetcher, `${baseUrl}/audio/transcriptions`, {
    method: 'POST',
    signal: AbortSignal.timeout(upstreamTimeoutMs(upstreamDeadline, clock)),
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
  }, 'transcription');
  const body = await readUpstreamJson(response, 'transcription');
  if (!response.ok || typeof body?.text !== 'string' || !body.text.trim()) {
    throw new Error('invalid_transcription');
  }
  return body.text.trim();
}

async function interpret(transcript, requestBody, {
  apiKey,
  baseUrl,
  fetcher,
  model,
  upstreamDeadline,
  clock,
}) {
  const context = JSON.stringify({
    drawing: requestBody.drawingSummary ?? null,
    selection: requestBody.selection ?? null,
  });
  const response = await fetchUpstream(fetcher, `${baseUrl}/responses`, {
    method: 'POST',
    signal: AbortSignal.timeout(upstreamTimeoutMs(upstreamDeadline, clock)),
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      instructions: VOICE_COMMAND_SYSTEM_PROMPT,
      input: `${transcript}\n\n<pipe_pilot_context>${context}</pipe_pilot_context>`,
      max_output_tokens: INTERPRETATION_MAX_OUTPUT_TOKENS,
      store: false,
      text: { format: RESPONSE_FORMAT },
    }),
  }, 'interpretation');
  const body = await readUpstreamJson(response, 'interpretation');
  const output = responseText(body);
  if (body?.status === 'incomplete' || !output) {
    throw new VoiceInterpretationError('incomplete_interpretation', body);
  }
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (cause) {
    throw new VoiceInterpretationError(cause?.message || 'invalid_interpretation_json', body);
  }
  if (!parsed || typeof parsed.action !== 'string') throw new Error('invalid_interpretation');
  return parsed;
}

function decodeAudio(body) {
  if (body?.version !== 1 || body?.mode !== 'voice_command') return null;
  const encoded = body?.audio?.base64;
  const mimeType = body?.audio?.mimeType;
  if (typeof encoded !== 'string' || typeof mimeType !== 'string') return null;
  const normalizedMimeType = mimeType.split(';', 1)[0].trim().toLowerCase();
  if (!/^audio\/(?:mp4|webm|mpeg|wav|x-m4a)$/i.test(normalizedMimeType)) return null;
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > MAX_AUDIO_BYTES) return null;
  return {
    bytes,
    mimeType: normalizedMimeType,
    fileName: audioFileName(normalizedMimeType),
  };
}

function audioFileName(mimeType) {
  if (mimeType === 'audio/mp4') return 'pipepilot-voice.mp4';
  if (mimeType === 'audio/x-m4a') return 'pipepilot-voice.m4a';
  if (mimeType === 'audio/mpeg') return 'pipepilot-voice.mp3';
  if (mimeType === 'audio/wav') return 'pipepilot-voice.wav';
  return 'pipepilot-voice.webm';
}

async function readUpstreamJson(response, phase) {
  const bodyText = await response.text();
  const body = safelyParse(bodyText);
  if (!response.ok) throw new VoiceUpstreamError(phase, response, bodyText);
  return body;
}

async function fetchUpstream(fetcher, url, init, phase) {
  try {
    return await fetcher(url, init);
  } catch (cause) {
    const error = new Error(cause?.message || `${phase}_request_failed`, { cause });
    error.name = cause?.name || 'VoiceUpstreamRequestError';
    error.phase = phase;
    throw error;
  }
}

export function upstreamTimeoutMs(deadline, clock = Date.now) {
  const remaining = deadline - clock();
  return Math.max(1, Math.min(UPSTREAM_CALL_TIMEOUT_MS, remaining));
}

function responseText(result) {
  if (typeof result?.output_text === 'string') return result.output_text.trim();
  for (const item of result?.output ?? []) {
    for (const part of item?.content ?? []) {
      if (part?.type === 'output_text' && typeof part.text === 'string') return part.text.trim();
    }
  }
  return '';
}

async function readRequestBody(request) {
  const supplied = request.body;
  if (supplied && typeof supplied === 'object' && !Buffer.isBuffer(supplied)) return supplied;
  if (typeof supplied === 'string') return safelyParse(supplied);
  if (Buffer.isBuffer(supplied)) return safelyParse(supplied.toString('utf8'));
  if (!request[Symbol.asyncIterator]) return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  return safelyParse(Buffer.concat(chunks).toString('utf8'));
}

function allowRequestOrigin(request, response, environment) {
  const origin = header(request, 'origin');
  if (!origin) return true;
  const allowed = (environment.VOICE_COMMAND_ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(','))
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!allowed.includes(origin)) return false;
  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Vary', 'Origin');
  return true;
}

function header(request, name) {
  const value = request.headers?.[name] ?? request.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function requestActor(request) {
  const forwarded = header(request, 'x-forwarded-for');
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim().slice(0, 128);
  }
  const remote = request.socket?.remoteAddress;
  return typeof remote === 'string' && remote.trim() ? remote.trim().slice(0, 128) : 'unknown';
}

function safelyParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export default createVoiceCommandHandler();
