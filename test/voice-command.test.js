import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createFixedWindowRateLimiter,
  createVoiceCommandHandler,
} from '../api/voice-command.mjs';

const previewOrigin =
  'https://pipepilot-app-git-codex-voice-command-service-pipe-pilot.vercel.app';
const requestBody = {
  version: 1,
  mode: 'voice_command',
  audio: {
    base64: Buffer.from('recorded audio').toString('base64'),
    mimeType: 'audio/mp4; codecs=mp4a.40.2',
  },
  drawingSummary: { runCount: 1 },
  selection: null,
};

function request({ body = requestBody, method = 'POST', headers = {} } = {}) {
  return {
    method,
    body,
    headers: { 'content-type': 'application/json', origin: previewOrigin, ...headers },
  };
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

test('transcribes audio then returns a structured command', async () => {
  const calls = [];
  const handler = createVoiceCommandHandler({
    environment: {
      OPENAI_API_KEY: 'test-key',
      AI_BASE_URL: 'https://example.test/v1',
    },
    fetcher: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/audio/transcriptions')) {
        return new Response(JSON.stringify({ text: 'run a 90 90 north' }), { status: 200 });
      }
      return new Response(JSON.stringify({
        output_text: JSON.stringify({
          action: 'draw_route', confidence: 0.98, ambiguous: false,
          route: {
            fitting: 'ELBOW_90', direction: 'north',
            length: { feet: 0, inches: 90, eighths: 0 },
          },
          viewpoint: null, clarificationQuestion: null, alternatives: [],
        }),
      }), { status: 200 });
    },
  });
  const result = response();

  await handler(request(), result);

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.transcript, 'run a 90 90 north');
  assert.equal(result.body.route.fitting, 'ELBOW_90');
  assert.equal(result.body.route.length.inches, 90);
  assert.equal(calls.length, 2);
  const uploadedFile = calls[0].init.body.get('file');
  assert.equal(uploadedFile.name, 'pipepilot-voice.mp4');
  assert.equal(uploadedFile.type, 'audio/mp4');
  assert.equal(JSON.parse(calls[1].init.body).store, false);
  assert.equal(result.headers['access-control-allow-origin'], previewOrigin);
});

test('maps upstream authentication failure to service misconfiguration', async () => {
  const handler = createVoiceCommandHandler({
    environment: { OPENAI_API_KEY: 'invalid-key' },
    fetcher: async () => new Response(
      JSON.stringify({ error: { message: 'Incorrect API key provided' } }),
      { status: 401 },
    ),
  });
  const result = response();

  await handler(request(), result);

  assert.equal(result.statusCode, 500);
  assert.equal(result.body.error, 'Voice service is misconfigured.');
  assert.equal(result.body.upstreamStage, 'transcription');
});

test('preserves retryable upstream status and retry-after', async () => {
  const handler = createVoiceCommandHandler({
    environment: { OPENAI_API_KEY: 'test-key' },
    fetcher: async () => new Response(
      JSON.stringify({ error: { message: 'Rate limited' } }),
      { status: 429, headers: { 'retry-after': '12' } },
    ),
  });
  const result = response();

  await handler(request(), result);

  assert.equal(result.statusCode, 429);
  assert.equal(result.headers['retry-after'], '12');
  assert.equal(result.body.upstreamStage, 'transcription');
});

test('forwards an upstream audio rejection as a client error', async () => {
  const handler = createVoiceCommandHandler({
    environment: { OPENAI_API_KEY: 'test-key' },
    fetcher: async () => new Response(
      JSON.stringify({ error: { message: 'Invalid file format' } }),
      { status: 400 },
    ),
  });
  const result = response();

  await handler(request(), result);

  assert.equal(result.statusCode, 400);
  assert.equal(result.body.error, 'Voice transcription rejected the audio.');
  assert.equal(result.body.upstreamStage, 'transcription');
});

test('rejects unknown origins before calling upstream', async () => {
  let called = false;
  const handler = createVoiceCommandHandler({
    environment: { OPENAI_API_KEY: 'test-key' },
    fetcher: async () => { called = true; throw new Error('should not run'); },
  });
  const result = response();

  await handler(request({ headers: { origin: 'https://untrusted.example' } }), result);

  assert.equal(result.statusCode, 403);
  assert.equal(called, false);
});

test('rejects malformed audio before calling upstream', async () => {
  let called = false;
  const handler = createVoiceCommandHandler({
    environment: { OPENAI_API_KEY: 'test-key' },
    fetcher: async () => { called = true; throw new Error('should not run'); },
  });
  const result = response();

  await handler(request({
    body: { ...requestBody, audio: { base64: '', mimeType: 'application/octet-stream' } },
  }), result);

  assert.equal(result.statusCode, 400);
  assert.equal(called, false);
});

test('rate limits repeated voice requests before calling upstream again', async () => {
  let called = 0;
  const handler = createVoiceCommandHandler({
    environment: { OPENAI_API_KEY: 'test-key' },
    fetcher: async () => {
      called += 1;
      return new Response(JSON.stringify({ text: 'north' }), { status: 200 });
    },
    rateLimiter: createFixedWindowRateLimiter({ limit: 1, windowMs: 60_000 }),
  });
  const first = response();
  const second = response();
  const actorHeaders = { 'x-forwarded-for': '203.0.113.9' };

  await handler(request({ body: { ...requestBody, audio: { base64: '', mimeType: 'audio/webm' } }, headers: actorHeaders }), first);
  await handler(request({ headers: actorHeaders }), second);

  assert.equal(first.statusCode, 400);
  assert.equal(second.statusCode, 429);
  assert.equal(second.headers['retry-after'], '60');
  assert.equal(called, 0);
});
