import test from 'node:test';
import assert from 'node:assert/strict';
import { NVIDIA, GEMINI, resolveProvider, toJsonSchema, decisionProperties } from '../scripts/review_providers.mjs';
import { configuration, requestReview } from '../scripts/gemini_report.mjs';
import { groupArticles } from '../scripts/local_report.mjs';

const article = company => groupArticles([{ company, target_no: 1, url: `https://example.com/${company}`, title: 'Pilot plant', published_at: '2026-08-02', investment_signal_no: 2, target_technology: 'material', content_text: 'The company plans a pilot plant.' }], [], { from_date: '2026-08-01', to_date: '2026-08-31' })[0];
const decisions = [{ candidate_id: 'investment:2', entity_supported: true, target_technology_supported: true, indicator_supported: true, leading_indicator_supported: true, event_stage: 'planned', quality: 'pass', reason_ko: '파일럿 생산시설 계획을 확인함', evidence_quotes: ['The company plans a pilot plant.'], summary_ko: '파일럿 생산시설 계획', summary_en: 'Pilot production plant planned' }];
const chat = (ds = decisions, finish_reason = 'stop') =>
  new Response(JSON.stringify({ choices: [{ finish_reason, message: { content: JSON.stringify({ decisions: ds }) } }], usage: { total_tokens: 12 } }));

test('the Gemini schema converts to a strict JSON Schema without losing enums', () => {
  const schema = toJsonSchema({ type: 'OBJECT', properties: { decisions: { type: 'ARRAY', items: { type: 'OBJECT', properties: decisionProperties } } } });
  const item = schema.properties.decisions.items;
  assert.equal(schema.type, 'object');
  assert.equal(item.properties.entity_supported.type, 'boolean');
  assert.equal(item.properties.evidence_quotes.items.type, 'string');
  assert.deepEqual(item.properties.quality.enum, ['pass', 'needs_review']);
  // strict 모드는 모든 필드가 required 이고 추가 필드가 금지돼야 한다.
  assert.deepEqual(item.required, Object.keys(decisionProperties));
  assert.equal(item.additionalProperties, false);
});

test('the NVIDIA request disables reasoning and pins deterministic structured output', () => {
  const body = NVIDIA.body({ article: article('Acme'), policy: 'POLICY', retry: false, model: NVIDIA.model });
  // 추론 토큰이 출력 예산을 먹으면 JSON 이 잘려 응답 전체가 폐기된다.
  assert.deepEqual(body.chat_template_kwargs, { thinking: false });
  assert.equal(body.temperature, 0);
  assert.equal(body.stream, false);
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.deepEqual(body.messages.map(m => m.role), ['system', 'user']);
  assert.match(body.messages[0].content, /POLICY$/);
  // 원본 수집 행은 모델에 보내지 않는다.
  assert.equal(JSON.parse(body.messages[1].content).candidates.every(c => c.row === undefined), true);
});

test('a retry adds the verbatim-quote instruction as another user turn', () => {
  const body = NVIDIA.body({ article: article('Acme'), policy: '', retry: true, model: NVIDIA.model });
  assert.deepEqual(body.messages.map(m => m.role), ['system', 'user', 'user']);
  assert.match(body.messages[2].content, /Copy evidence_quotes verbatim/);
});

test('a truncated NVIDIA response is rejected instead of parsed', () => {
  const invalid = code => Object.assign(new Error(code), { response_code: code });
  assert.throws(() => NVIDIA.parse({ choices: [{ finish_reason: 'length', message: { content: '{"decisions":[' } }] }, invalid), /incomplete_response/);
  assert.throws(() => NVIDIA.parse({ choices: [{ finish_reason: 'stop', message: {} }] }, invalid), /invalid_parts/);
  const ok = NVIDIA.parse({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }], usage: { total_tokens: 3 } }, invalid);
  assert.equal(ok.text, '{}');
  assert.deepEqual(ok.usage, { total_tokens: 3 });
});

test('requestReview sends the NVIDIA article to the OpenAI-compatible endpoint', async () => {
  const a = article('Acme');
  const review = await requestReview(a, 'policy', 'test-key', async (url, init) => {
    assert.equal(url, 'https://integrate.api.nvidia.com/v1/chat/completions');
    assert.equal(init.headers.Authorization, 'Bearer test-key');
    assert.equal(JSON.parse(init.body).model, NVIDIA.model);
    return chat();
  }, false, NVIDIA);
  assert.equal(review.provider, 'nvidia');
  assert.equal(review.reviewer, `${NVIDIA.model}/gemini-article-v1`);
  assert.deepEqual(review.usage, { total_tokens: 12 });
});

test('an NVIDIA HTTP failure is labelled without leaking the response body', async () => {
  await assert.rejects(
    requestReview(article('Acme'), '', 'key', async () => new Response('secret detail', { status: 403 }), false, NVIDIA),
    /^Error: NVIDIA HTTP 403$/,
  );
});

test('NVIDIA needs no free-tier confirmation and accepts the OpenAI-named secret', () => {
  assert.deepEqual(
    configuration({ REPORT_PROVIDER: 'nvidia', OPENAI_API_KEY: 'k' }, NVIDIA),
    { apiKey: 'k', maxRequests: 400, delayMs: 1600 },
  );
  // 40 RPM 이면 1500ms 가 한도다.
  assert.throws(() => configuration({ REPORT_PROVIDER: 'nvidia', OPENAI_API_KEY: 'k', NVIDIA_DELAY_MS: '1499' }, NVIDIA), /1500\.\.60000/);
  assert.throws(() => configuration({ REPORT_PROVIDER: 'nvidia' }, NVIDIA), /NVIDIA_API_KEY or OPENAI_API_KEY/);
});

test('the provider is chosen by env and the model stays overridable', () => {
  assert.equal(resolveProvider({}).id, 'gemini');
  assert.equal(resolveProvider({ REPORT_PROVIDER: 'nvidia' }).model, NVIDIA.model);
  assert.equal(resolveProvider({ REPORT_PROVIDER: 'gemini', GEMINI_MODEL: 'gemini-3.1-flash-lite' }).model, 'gemini-3.1-flash-lite');
  assert.throws(() => resolveProvider({ REPORT_PROVIDER: 'openai' }), /Unknown REPORT_PROVIDER/);
});

test('the two providers never share a cached judgement', () => {
  assert.notEqual(GEMINI.model, NVIDIA.model);
  assert.notEqual(GEMINI.id, NVIDIA.id);
});
