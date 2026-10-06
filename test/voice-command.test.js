import assert from 'node:assert/strict';
import test from 'node:test';

import { createVoiceCommandHandler } from '../api/voice-command.mjs';

const previewOrigin =
  'https://pipepilot-app-git-codex-voice-command-service-pipe-pilot.vercel.app';
const requestBody = {
  version: 1,
  mode: 'voice_command',
  audio: {
    base64: Buffer.from('recorded audio').toString('base64'),
    mimeType: 'audio/webm',
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
  assert.equal(JSON.parse(calls[1].init.body).store, false);
  assert.equal(result.headers['access-control-allow-origin'], previewOrigin);
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
