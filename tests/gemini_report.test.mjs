import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configuration, requestReview, reviewArticles, MODEL } from '../scripts/gemini_report.mjs';
import { groupArticles } from '../scripts/local_report.mjs';

const article = company => groupArticles([{ company, target_no: 1, url: `https://example.com/${company}`, title: 'Pilot plant', published_at: '2026-08-02', investment_signal_no: 2, target_technology: 'material', content_text: 'The company plans a pilot plant.' }], [], { from_date: '2026-08-01', to_date: '2026-08-31' })[0];
const decisions = [{ candidate_id: 'investment:2', entity_supported: true, target_technology_supported: true, indicator_supported: true, leading_indicator_supported: true, event_stage: 'planned', quality: 'pass', reason_ko: '파일럿 생산시설 계획을 확인함', evidence_quotes: ['The company plans a pilot plant.'], summary_ko: '파일럿 생산시설 계획', summary_en: 'Pilot production plant planned' }];
const response = (ds = decisions, finishReason = 'STOP') => new Response(JSON.stringify({ candidates: [{ finishReason, content: { parts: [{ text: JSON.stringify({ decisions: ds }) }] } }] }));
const config = { apiKey: 'test-key', maxRequests: 40, delayMs: 15000 };

test('requires explicit free-tier confirmation and bounds API requests', () => {
  assert.throws(() => configuration({ GEMINI_API_KEY: 'key' }), /FREE_TIER_CONFIRMED/);
  assert.throws(() => configuration({ GEMINI_FREE_TIER_CONFIRMED: 'true' }), /API_KEY/);
  assert.throws(() => configuration({ GEMINI_FREE_TIER_CONFIRMED: 'true', GEMINI_API_KEY: 'key', GEMINI_MAX_REQUESTS: '0' }), /1..200/);
});

test('uses one fixed Gemini endpoint, structured output and all article candidates', async () => {
  const a = article('Example');
  const review = await requestReview(a, 'policy', 'test-key', async (url, init) => {
    assert.equal(url, `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`);
    assert.equal(init.headers['x-goog-api-key'], 'test-key');
    const body = JSON.parse(init.body);
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    assert.equal(body.tools, undefined);
    assert.equal(JSON.parse(body.contents[0].parts[0].text).candidates.length, a.candidates.length);
    return response();
  });
  assert.equal(review.provider, 'gemini');
});

test('quota interruption preserves completed reviews and the next run resumes only pending articles', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-review-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  const articles = [article('A'), article('B')];
  let calls = 0;
  const first = await reviewArticles({ articles, reviewDir, policy: '', config, sleep: async () => {}, fetchImpl: async () => ++calls === 1 ? response() : new Response('', { status: 429 }) });
  assert.equal(first.status, 'paused');
  assert.equal(first.completed, 1);
  assert.equal(first.reason, 'quota');
  assert.equal(calls, 2);
  let resumedCalls = 0;
  const next = await reviewArticles({ articles, reviewDir, policy: '', config, sleep: async () => {}, fetchImpl: async () => { resumedCalls++; return response(); } });
  assert.equal(next.status, 'completed');
  assert.equal(next.cached, 1);
  assert.equal(resumedCalls, 1);
});

test('request budget pauses without fallback and corrupt evidence is never cached', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-review-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  const articles = [article('A'), article('B')];
  const state = await reviewArticles({ articles, reviewDir, policy: '', config: { ...config, maxRequests: 1 }, fetchImpl: async () => response() });
  assert.equal(state.reason, 'request_budget');
  assert.equal(state.requests, 1);
  await assert.rejects(reviewArticles({ articles: [articles[1]], reviewDir, policy: '', config, fetchImpl: async () => response([{ ...decisions[0], evidence_quotes: ['Invented quote'] }]) }), /exact passages/);
  await assert.rejects(fs.access(path.join(reviewDir, `${articles[1].id}.json`)));
});

test('authentication failures and truncated responses fail closed', async () => {
  await assert.rejects(requestReview(article('A'), '', 'key', async () => new Response('secret detail', { status: 403 })), /^Error: Gemini HTTP 403$/);
  await assert.rejects(requestReview(article('A'), '', 'key', async () => response(decisions, 'MAX_TOKENS')), /incomplete response/);
});
