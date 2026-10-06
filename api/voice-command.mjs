import { VOICE_COMMAND_SYSTEM_PROMPT } from './_lib/voice-command-prompt.mjs';

const MAX_AUDIO_BYTES = 3 * 1024 * 1024;
const MAX_BODY_BYTES = 4 * 1024 * 1024 + 64 * 1024;
const DEFAULT_MODEL = 'gpt-5-mini';
const DEFAULT_TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';
const DEFAULT_ALLOWED_ORIGINS = [
  'https://app.pipepilotapp.com',
  'https://pipepilot-app-git-codex-voice-command-service-pipe-pilot.vercel.app',
];
const UPSTREAM_TIMEOUT_MS = 40_000;
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
              fitting: { type: 'string' },
              direction: { type: 'string', enum: ['north', 'south', 'east', 'west', 'up', 'down'] },
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
            required: ['fitting', 'direction', 'length'],
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

export function createVoiceCommandHandler({
  environment = process.env,
  fetcher = globalThis.fetch,
  rateLimiter = defaultVoiceRateLimiter,
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
    try {
      const transcript = await transcribe(audio, {
        apiKey,
        baseUrl,
        fetcher,
        model: environment.VOICE_TRANSCRIBE_MODEL || DEFAULT_TRANSCRIBE_MODEL,
      });
      const command = await interpret(transcript, body, {
        apiKey,
        baseUrl,
        fetcher,
        model: environment.VOICE_COMMAND_MODEL || DEFAULT_MODEL,
      });
      return response.status(200).json({ transcript, ...command });
    } catch (error) {
      console.error('Voice command upstream failed', error?.name ?? 'unknown');
      return response.status(502).json({ error: 'Voice command could not be processed.' });
    }
  };
}

async function transcribe(audio, { apiKey, baseUrl, fetcher, model }) {
  const form = new FormData();
  form.append('model', model);
  form.append('file', new Blob([audio.bytes], { type: audio.mimeType }), audio.fileName);
  const response = await fetcher(`${baseUrl}/audio/transcriptions`, {
    method: 'POST',
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const body = await response.json();
  if (!response.ok || typeof body?.text !== 'string' || !body.text.trim()) {
    throw new Error('transcription_failed');
  }
  return body.text.trim();
}

async function interpret(transcript, requestBody, { apiKey, baseUrl, fetcher, model }) {
  const context = JSON.stringify({
    drawing: requestBody.drawingSummary ?? null,
    selection: requestBody.selection ?? null,
  });
  const response = await fetcher(`${baseUrl}/responses`, {
    method: 'POST',
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      instructions: VOICE_COMMAND_SYSTEM_PROMPT,
      input: `${transcript}\n\n<pipe_pilot_context>${context}</pipe_pilot_context>`,
      max_output_tokens: 500,
      store: false,
      text: { format: RESPONSE_FORMAT },
    }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error('interpretation_failed');
  const parsed = JSON.parse(responseText(body));
  if (!parsed || typeof parsed.action !== 'string') throw new Error('invalid_interpretation');
  return parsed;
}

function decodeAudio(body) {
  if (body?.version !== 1 || body?.mode !== 'voice_command') return null;
  const encoded = body?.audio?.base64;
  const mimeType = body?.audio?.mimeType;
  if (typeof encoded !== 'string' || typeof mimeType !== 'string') return null;
  if (!/^audio\/(?:mp4|webm|mpeg|wav|x-m4a)(?:;.*)?$/i.test(mimeType)) return null;
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > MAX_AUDIO_BYTES) return null;
  return {
    bytes,
    mimeType,
    fileName: mimeType.includes('mp4') ? 'pipepilot-voice.m4a' : 'pipepilot-voice.webm',
  };
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
