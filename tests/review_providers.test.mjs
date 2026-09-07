import test from 'node:test';
import assert from 'node:assert/strict';
import * as provider_module from '../scripts/review_providers.mjs';
const { NVIDIA, GEMINI, resolveProvider, toJsonSchema, decisionProperties } = provider_module;
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

test('NVIDIA needs no free-tier confirmation and reads the single shared key secret', () => {
  assert.deepEqual(
    configuration({ REPORT_PROVIDER: 'nvidia', OPENAI_API_KEY: 'k' }, NVIDIA),
    { apiKey: 'k', maxRequests: 400, delayMs: 1600 },
  );
  // 40 RPM 이면 1500ms 가 한도다.
  assert.throws(() => configuration({ REPORT_PROVIDER: 'nvidia', OPENAI_API_KEY: 'k', NVIDIA_DELAY_MS: '1499' }, NVIDIA), /1500\.\.60000/);
  assert.throws(() => configuration({ REPORT_PROVIDER: 'nvidia' }, NVIDIA), /OPENAI_API_KEY is required/);
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

test('an auth failure can be diagnosed without printing the key', () => {
  const { describeKeyShape } = provider_module;
  // 다른 서비스 키가 들어 있는 경우와 붙여넣기 공백을 구분할 수 있어야 한다.
  assert.deepEqual(describeKeyShape('nvapi-0123456789'), { length: 16, prefix: 'nvapi-', issuer: 'NVIDIA build', had_surrounding_whitespace: false });
  assert.equal(describeKeyShape('sk-legacygatewaykey').prefix, 'sk-');
  assert.equal(describeKeyShape(' nvapi-0123456789\n').had_surrounding_whitespace, true);
  assert.equal(describeKeyShape(undefined).prefix, '(알 수 없는 형식)');
  // 어떤 경우에도 키 본문은 결과에 담기지 않는다.
  assert.equal(JSON.stringify(describeKeyShape('nvapi-supersecret')).includes('supersecret'), false);
});

test('a pasted key with surrounding whitespace still authenticates', () => {
  assert.equal(configuration({ REPORT_PROVIDER: 'nvidia', OPENAI_API_KEY: '  nvapi-abc\n' }, NVIDIA).apiKey, 'nvapi-abc');
});

test('a non-quote validation failure records what actually broke', async t => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { reviewArticles } = await import('../scripts/gemini_report.mjs');
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'validation-diagnostics-'));
  t.after(() => fs.rm(reviewDir, { recursive: true, force: true }));
  // 투자 후보에 not_applicable 은 스키마상 허용되지만 판정 계약에서는 거부된다.
  const broken = [{ ...decisions[0], event_stage: 'not_applicable', reason_ko: '사유', summary_ko: '요약문', summary_en: 'summary' }];
  // reviewArticles 는 환경이 정한 기본 프로바이더(Gemini)를 쓰므로 응답도 그 형식이어야 한다.
  const geminiShaped = () => new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ decisions: broken }) }] } }] }));
  const state = await reviewArticles({
    articles: [article('Broken')], reviewDir, policy: '', config: { apiKey: 'k', maxRequests: 1, delayMs: 0 },
    sleep: async () => {}, fetchImpl: async () => geminiShaped(),
  });
  assert.equal(state.diagnostics.length, 1);
  const detail = JSON.parse(await fs.readFile(path.join(path.dirname(reviewDir), state.diagnostics[0].file), 'utf8'));
  assert.match(detail.validation_message, /invalid event_stage/);
  assert.equal(detail.decisions[0].event_stage, 'not_applicable');
  assert.equal(detail.expected_kinds['investment:2'], 'investment');
  assert.equal(detail.decisions[0].reason_ko_length, 2);
  // 자유 텍스트 본문은 길이만 남고 내용은 남지 않는다.
  assert.equal(JSON.stringify(detail).includes('요약문'), false);
});
