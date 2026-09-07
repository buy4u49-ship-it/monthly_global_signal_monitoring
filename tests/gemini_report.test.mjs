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
  assert.deepEqual(configuration({ GEMINI_FREE_TIER_CONFIRMED: 'true', GEMINI_API_KEY: 'key' }), { apiKey: 'key', maxRequests: 400, delayMs: 4500 });
  assert.throws(() => configuration({ GEMINI_FREE_TIER_CONFIRMED: 'true', GEMINI_API_KEY: 'key', GEMINI_MAX_REQUESTS: '0' }), /1..400/);
  assert.throws(() => configuration({ GEMINI_FREE_TIER_CONFIRMED: 'true', GEMINI_API_KEY: 'key', GEMINI_DELAY_MS: '3999' }), /4000..60000/);
  assert.deepEqual(configuration({ GEMINI_FREE_TIER_CONFIRMED: 'true', GEMINI_API_KEY: 'key', GEMINI_MAX_REQUESTS: '400', GEMINI_DELAY_MS: '4500' }), { apiKey: 'key', maxRequests: 400, delayMs: 4500 });
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
  const invalid = await reviewArticles({ articles: [articles[1]], reviewDir, policy: '', config, sleep: async () => {}, fetchImpl: async () => response([{ ...decisions[0], evidence_quotes: ['Invented quote'] }]) });
  assert.equal(invalid.reason, 'invalid_responses');
  assert.equal(invalid.requests, 2);
  assert.deepEqual(invalid.failed_articles, [{ article_id: articles[1].id, reason: 'evidence_mismatch' }]);
  await assert.rejects(fs.access(path.join(reviewDir, `${articles[1].id}.json`)));
});

test('authentication failures and truncated responses fail closed', async () => {
  await assert.rejects(requestReview(article('A'), '', 'key', async () => new Response('secret detail', { status: 403 })), /^Error: Gemini HTTP 403$/);
  await assert.rejects(requestReview(article('A'), '', 'key', async () => response(decisions, 'MAX_TOKENS')), /incomplete_response/);
});

test('invalid article retries once, later articles are saved, and resume repairs only the failed article', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-review-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  const articles = [article('Bad'), article('Good')];
  let calls = 0;
  const delays = [];
  const first = await reviewArticles({ articles, reviewDir, policy: '', config,
    sleep: async ms => delays.push(ms), fetchImpl: async (_, init) => {
      const body = JSON.parse(init.body);
      calls++;
      if (calls === 2) assert.match(body.contents[0].parts[1].text, /Copy evidence_quotes verbatim/);
      return calls <= 2 ? response([]) : response();
    } });
  assert.equal(first.status, 'paused');
  assert.equal(first.completed, 1);
  assert.equal(first.requests, 3);
  assert.deepEqual(delays, [15000, 15000]);
  await assert.rejects(fs.access(path.join(reviewDir, `${articles[0].id}.json`)));
  const resumed = await reviewArticles({ articles, reviewDir, policy: '', config, fetchImpl: async () => response() });
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.cached, 1);
  assert.equal(resumed.requests, 1);
});

test('retry respects request budget and quota; authentication still fails immediately', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-review-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  const args = { articles: [article('A')], reviewDir, policy: '', config, sleep: async () => {} };
  let calls = 0;
  const limited = await reviewArticles({ ...args, config: { ...config, maxRequests: 1 }, fetchImpl: async () => { calls++; return response([]); } });
  assert.equal(limited.reason, 'request_budget');
  assert.equal(calls, 1);
  calls = 0;
  const quota = await reviewArticles({ ...args, fetchImpl: async () => ++calls === 1 ? response([]) : new Response('', { status: 429 }) });
  assert.equal(quota.reason, 'quota');
  assert.equal(quota.requests, 2);
  calls = 0;
  await assert.rejects(reviewArticles({ ...args, fetchImpl: async () => { calls++; return new Response('', { status: 403 }); } }), /HTTP 403/);
  assert.equal(calls, 1);
});

test('malformed or truncated output recovers on retry without caching the bad response', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-review-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  for (const [index, bad] of [() => response(decisions, 'MAX_TOKENS'), () => new Response('null'),
    () => new Response('{'), () => response([null]), () => response([{ ...decisions[0], evidence_quotes: [] }])].entries()) {
    let calls = 0;
    const result = await reviewArticles({ articles: [article(`A${index}`)], reviewDir, policy: '', config,
      sleep: async () => {}, fetchImpl: async () => ++calls === 1 ? bad() : response() });
    assert.equal(result.status, 'completed');
    assert.equal(result.requests, 2);
  }
});

test('persistent provider outages use bounded backoff and expose only safe diagnostics', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-review-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  let calls = 0;
  const delays = [];
  const state = await reviewArticles({ articles: [article('A')], reviewDir, policy: '', config, random: () => 0, sleep: async ms => delays.push(ms), fetchImpl: async () => {
    calls++;
    return new Response(JSON.stringify({ error: { message: 'High demand; private provider detail' } }), { status: 503 });
  } });
  assert.equal(calls, 3);
  assert.deepEqual(delays, [15000, 30000]);
  assert.equal(state.http_status, 503);
  assert.equal(state.provider_reason, 'capacity');
  assert.equal(JSON.stringify(state).includes('private provider detail'), false);
});

test('503 recovers automatically with cached progress and retries obey budget', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-review-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  const a = article('Cached'), b = article('Pending');
  const args = { reviewDir, policy: '', config, sleep: async () => {}, random: () => 0 };
  await reviewArticles({ ...args, articles: [a], fetchImpl: async () => response() });
  let calls = 0;
  const recovered = await reviewArticles({ ...args, articles: [a, b], fetchImpl: async () => ++calls === 1 ? new Response('', { status: 503 }) : response() });
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.cached, 1);
  assert.equal(recovered.requests, 2);
  const limited = await reviewArticles({ ...args, articles: [article('Budget')], config: { ...config, maxRequests: 1 }, fetchImpl: async () => new Response('', { status: 503 }) });
  assert.equal(limited.reason, 'request_budget');
  assert.equal(limited.requests, 1);
});

test('quote failure artifacts retain both attempts, original evidence and normalized comparisons without secrets', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-diagnostics-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  const a = article('Diagnostic');
  a.evidence.push('Company’s capacity is 10 tonnes.');
  const args = { articles: [a], reviewDir, policy: '', config, sleep: async () => {} };
  const invalid = [{ ...decisions[0], summary_en: 'DO NOT SAVE SUMMARY', evidence_quotes: [
    "Company's capacity is 10 tonnes.", 'Capacity is 100 tonnes. test-key',
  ] }];
  const state = await reviewArticles({ ...args, fetchImpl: async () => response(invalid) });
  assert.equal(state.diagnostics.length, 2);
  assert.notEqual(state.diagnostics[0].file, state.diagnostics[1].file);
  const readDiagnostic = async item => JSON.parse(await fs.readFile(path.join(path.dirname(reviewDir), item.file), 'utf8'));
  const detail = await readDiagnostic(state.diagnostics[0]);
  assert.equal(detail.reason, 'evidence_mismatch');
  assert.equal(detail.decisions[0].candidate_id, 'investment:2');
  assert.equal(detail.decisions[0].quotes[0].quote, "Company's capacity is 10 tonnes.");
  assert.deepEqual(detail.decisions[0].quotes[0].matching_block_indices, [2]);
  assert.deepEqual(detail.decisions[0].quotes[1].matching_block_indices, []);
  assert.equal(detail.evidence_blocks[2].text, 'Company’s capacity is 10 tonnes.');
  assert.equal(JSON.stringify(detail).includes('test-key'), false);
  assert.equal(JSON.stringify(detail).includes('DO NOT SAVE SUMMARY'), false);
  assert.equal(JSON.stringify(state).includes('Capacity is'), false);
  await assert.rejects(fs.access(path.join(reviewDir, `${a.id}.json`)));
  const again = await reviewArticles({ ...args, fetchImpl: async () => response(invalid) });
  assert.notEqual(again.diagnostics[0].file, state.diagnostics[0].file);
  assert.deepEqual(await readDiagnostic(state.diagnostics[0]), detail);
  const recovered = await reviewArticles({ ...args, fetchImpl: async () => response() });
  assert.equal(recovered.status, 'completed');
  assert.deepEqual(recovered.diagnostics, []);
  const cached = await reviewArticles({ ...args, fetchImpl: async () => { throw new Error('must use cache'); } });
  assert.equal(cached.cached, 1);
});

test('missing and malformed quotes produce readable diagnostics without saving arbitrary objects', async t => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-diagnostics-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  for (const quotes of [[], null, [{ secret: 'private object' }]]) {
    const state = await reviewArticles({ articles: [article('Missing')], reviewDir, policy: '', config: { ...config, maxRequests: 1 },
      fetchImpl: async () => response([{ ...decisions[0], evidence_quotes: quotes }]) });
    assert.equal(state.diagnostics.length, 1);
    const content = await fs.readFile(path.join(path.dirname(reviewDir), state.diagnostics[0].file), 'utf8');
    assert.equal(content.includes('private object'), false);
    const detail = JSON.parse(content);
    assert.equal(detail.decisions[0].quotes_is_array, Array.isArray(quotes));
  }
});

test('business non-applicable fields are constants without bypassing the activity gate', async () => {
  const original = article('A').candidates[0].row;
  const a = groupArticles([], [original], { from_date: '2026-08-01', to_date: '2026-08-31' })[0];
  const review = await requestReview(a, '', 'key', async () => response([{ ...decisions[0], candidate_id: 'relevant', indicator_supported: false, leading_indicator_supported: false, event_stage: 'unclear', summary_ko: '', summary_en: '' }]));
  assert.equal(review.decisions[0].event_stage, 'not_applicable');
  assert.equal(review.decisions[0].leading_indicator_supported, true);
  assert.equal(review.decisions[0].indicator_supported, false);
});
