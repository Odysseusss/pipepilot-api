import { PETEY_SYSTEM_PROMPT } from './_lib/petey-prompt.mjs';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGE_CHARS = 4000;
const MAX_HISTORY_MESSAGES = 12;
const DEFAULT_MODEL = 'gpt-5-mini';
const DEFAULT_ALLOWED_ORIGINS = [
  'https://pipepilotapp.com',
  'https://app.pipepilotapp.com',
];
const UPSTREAM_TIMEOUT_MS = 25_000;
const PETEY_RESPONSE_FORMAT = {
  type: 'json_schema',
  name: 'petey_reply',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      answer: { type: 'string' },
      intent: {
        type: 'string',
        enum: ['answer', 'drawing_command', 'clarification', 'unsupported'],
      },
      yaketyCommand: { type: ['string', 'null'] },
    },
    required: ['answer', 'intent', 'yaketyCommand'],
  },
};

const sharedRateLimiter = createMemoryRateLimiter();

export const config = { maxDuration: 30 };

export function createPeteyHandler({
  environment = process.env,
  fetcher = globalThis.fetch,
  rateLimiter = sharedRateLimiter,
} = {}) {
  return async function peteyHandler(request, response) {
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

    const contentLength = Number(header(request, 'content-length') ?? 0);
    if (contentLength > MAX_BODY_BYTES) {
      return response.status(413).json({ error: 'Petey request is too large.' });
    }

    const body = await readRequestBody(request);
    if (!validRequest(body)) {
      return response.status(400).json({ error: 'Invalid Petey request.' });
    }
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_BODY_BYTES) {
      return response.status(413).json({ error: 'Petey request is too large.' });
    }

    if (!rateLimiter.allow(normalizedActor(request))) {
      return response.status(429).json({
        error: 'Petey is getting too many requests. Try again shortly.',
      });
    }

    const apiKey = environment.OPENAI_API_KEY?.trim();
    const model = environment.PETEY_MODEL?.trim() || DEFAULT_MODEL;
    if (!apiKey) {
      return response.status(503).json({ error: 'Petey is not configured.' });
    }

    const apiBaseUrl = (environment.AI_BASE_URL || 'https://api.openai.com/v1')
      .replace(/\/$/, '');
    let upstreamResponse;
    try {
      upstreamResponse = await fetcher(`${apiBaseUrl}/responses`, {
        method: 'POST',
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          instructions: PETEY_SYSTEM_PROMPT,
          input: responseInput(body),
          max_output_tokens: 700,
          store: false,
          text: { format: PETEY_RESPONSE_FORMAT },
        }),
      });
    } catch (error) {
      console.error('Petey upstream request failed', error?.name ?? 'unknown');
      return response.status(502).json({
        error: 'Petey could not reach the language service.',
      });
    }

    const result = await safelyReadJson(upstreamResponse);
    if (!upstreamResponse.ok) {
      console.error(
        'Petey upstream rejected request',
        upstreamResponse.status,
        upstreamResponse.headers.get('x-request-id') ?? '',
      );
      return response.status(502).json({
        error: 'Petey could not answer that request.',
      });
    }

    const reply = structuredReply(responseText(result));
    if (!reply) {
      return response.status(502).json({ error: 'Petey returned an invalid answer.' });
    }
    return response.status(200).json({
      ...reply,
      requestId: upstreamResponse.headers.get('x-request-id'),
    });
  };
}

export function createMemoryRateLimiter({
  limit = 20,
  periodMs = 60_000,
  now = () => Date.now(),
} = {}) {
  const buckets = new Map();
  return {
    allow(key) {
      const current = now();
      const previous = buckets.get(key);
      if (!previous || current >= previous.resetAt) {
        buckets.set(key, { count: 1, resetAt: current + periodMs });
        return true;
      }
      if (previous.count >= limit) return false;
      previous.count += 1;
      if (buckets.size > 5000) {
        for (const [candidate, bucket] of buckets) {
          if (current >= bucket.resetAt) buckets.delete(candidate);
        }
      }
      return true;
    },
  };
}

function responseInput(body) {
  const history = body.history.map(({ role, content }) => ({ role, content }));
  const context = JSON.stringify({
    drawing: body.drawingSummary ?? null,
    selection: body.selection ?? null,
  });
  return [
    ...history,
    {
      role: 'user',
      content: `${body.message}\n\n<pipe_pilot_context>${context}</pipe_pilot_context>`,
    },
  ];
}

function validRequest(body) {
  return Boolean(
    body &&
      body.version === 1 &&
      body.mode === 'petey_chat' &&
      typeof body.message === 'string' &&
      body.message.trim().length > 0 &&
      body.message.length <= MAX_MESSAGE_CHARS &&
      Array.isArray(body.history) &&
      body.history.length <= MAX_HISTORY_MESSAGES &&
      body.history.every(
        (item) =>
          item &&
          (item.role === 'user' || item.role === 'assistant') &&
          typeof item.content === 'string' &&
          item.content.length <= MAX_MESSAGE_CHARS,
      ) &&
      optionalObject(body.drawingSummary) &&
      optionalObject(body.selection),
  );
}

function optionalObject(value) {
  return value == null || (typeof value === 'object' && !Array.isArray(value));
}

function responseText(result) {
  if (typeof result?.output_text === 'string') return result.output_text.trim();
  for (const item of result?.output ?? []) {
    for (const part of item?.content ?? []) {
      if (part?.type === 'output_text' && typeof part.text === 'string') {
        return part.text.trim();
      }
    }
  }
  return '';
}

function structuredReply(value) {
  const parsed = safelyParse(value);
  if (
    !parsed ||
    typeof parsed.answer !== 'string' ||
    parsed.answer.trim().length === 0 ||
    !['answer', 'drawing_command', 'clarification', 'unsupported'].includes(
      parsed.intent,
    ) ||
    (parsed.yaketyCommand !== null && typeof parsed.yaketyCommand !== 'string')
  ) {
    return null;
  }
  const command =
    typeof parsed.yaketyCommand === 'string' && parsed.yaketyCommand.trim().length > 0
      ? parsed.yaketyCommand.trim()
      : null;
  if ((parsed.intent === 'drawing_command') !== (command !== null)) return null;
  return {
    answer: parsed.answer.trim(),
    intent: parsed.intent,
    yaketyCommand: command,
  };
}

async function readRequestBody(request) {
  const supplied = request.body;
  if (supplied && typeof supplied === 'object' && !Buffer.isBuffer(supplied)) {
    return supplied;
  }
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

function normalizedActor(request) {
  const forwarded = header(request, 'x-forwarded-for')?.split(',')[0]?.trim();
  if (forwarded && forwarded.length <= 100) return `ip:${forwarded}`;
  const supplied = header(request, 'x-pipe-pilot-client') ?? '';
  if (/^[a-zA-Z0-9._:-]{8,100}$/.test(supplied)) return `client:${supplied}`;
  return `ip:${request.socket?.remoteAddress ?? 'anonymous'}`;
}

function allowRequestOrigin(request, response, environment) {
  const origin = header(request, 'origin');
  if (!origin) return true;
  const allowed = [
    ...DEFAULT_ALLOWED_ORIGINS,
    ...(environment.PETEY_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  ];
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  const local =
    parsed.protocol === 'http:' &&
    (parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname.startsWith('192.168.') ||
      parsed.hostname.startsWith('10.') ||
      isPrivate172Address(parsed.hostname));
  if (!local && !allowed.includes(origin)) return false;
  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, X-Pipe-Pilot-Client',
  );
  response.setHeader('Vary', 'Origin');
  return true;
}

function isPrivate172Address(hostname) {
  const match = /^172\.(\d{1,2})\./.exec(hostname);
  if (!match) return false;
  const secondOctet = Number(match[1]);
  return secondOctet >= 16 && secondOctet <= 31;
}

function header(request, name) {
  const value = request.headers?.[name] ?? request.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function safelyParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function safelyReadJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export default createPeteyHandler();
