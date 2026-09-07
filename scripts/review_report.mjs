#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sourceCandidates, groupArticles, importReview, normalizeQuote, build } from './local_report.mjs';
import { resolveProvider, describeKeyShape } from './review_providers.mjs';

// 판정은 NVIDIA build 의 OpenAI 호환 엔드포인트로 보낸다. 모델은 NVIDIA_MODEL 로 바꾼다.
// 모델 이름은 정책 다이제스트에 들어가므로, 바꾸면 앞선 판정은 재사용되지 않는다.
export const PROVIDER = resolveProvider();
export const MODEL = PROVIDER.model;
const VERSION = 'article-review-v1';
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const write = async (file, value) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, JSON.stringify(value, null, 2) + '\n');
  await fs.rename(`${file}.tmp`, file);
};

export function configuration(env = process.env, provider = resolveProvider(env)) {
  const prefix = provider.id.toUpperCase();
  const keyEnv = provider.keyEnv.find(name => env[name]);
  if (!keyEnv) throw new Error(`${provider.keyEnv.join(' or ')} is required`);
  const maxRequests = Number(env[`${prefix}_MAX_REQUESTS`] || env.REPORT_MAX_REQUESTS || 400);
  const delayMs = Number(env[`${prefix}_DELAY_MS`] || env.REPORT_DELAY_MS || provider.defaultDelayMs);
  // 대기 하한은 프로바이더의 관측 RPM 에서 온다(60000 / RPM). 429 가 나도 저장 후 멈추고
  // 다음 실행이 이어간다. 400 상한은 한 회차 전체를 한 번에 덮는다.
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 400) throw new Error(`${prefix}_MAX_REQUESTS must be 1..400`);
  if (!Number.isFinite(delayMs) || delayMs < provider.minDelayMs || delayMs > 60000) {
    throw new Error(`${prefix}_DELAY_MS must be ${provider.minDelayMs}..60000`);
  }
  return { apiKey: String(env[keyEnv]).trim(), maxRequests, delayMs };
}

function invalidResponse(code, label = PROVIDER.label) {
  return Object.assign(new Error(`${label} invalid response: ${code}`), { response_code: code });
}

// A quote array can contain separate passages. Split joined sentences only
// when EVERY sentence independently matches the SAME source block in order.
// Never fill omitted text, remove ellipses, or use fuzzy/semantic matching.
export function separateVerifiedQuotes(article, decisions) {
  const evidence = article.evidence.map(normalizeQuote);
  const repairs = [];
  return {
    decisions: decisions.map(decision => {
      if (!Array.isArray(decision.evidence_quotes)) return decision;
      const quotes = decision.evidence_quotes.flatMap((quote, quote_index) => {
        if (typeof quote !== 'string' || evidence.some(block => block.includes(normalizeQuote(quote)))) return [quote];
        if (/\.{3}|…/.test(quote)) return [quote];
        const sentences = quote.trim().split(/(?<=[.!?])\s+/);
        if (sentences.length < 2 || sentences.some(s => s.length < 30 || !/[.!?]$/.test(s))) return [quote];
        const normalized = sentences.map(normalizeQuote);
        const blockIndex = evidence.findIndex(block => {
          let offset = 0;
          for (const sentence of normalized) {
            const index = block.indexOf(sentence, offset);
            if (index < 0) return false;
            offset = index + sentence.length;
          }
          return true;
        });
        if (blockIndex < 0) return [quote];
        repairs.push({ candidate_id: decision.candidate_id, quote_index, original_quote: quote,
          separated_quotes: sentences, evidence_block_index: blockIndex });
        return sentences;
      });
      return { ...decision, evidence_quotes: quotes };
    }),
    repairs,
  };
}

// Diagnostic data is never imported as a review. Keep only evidence-related
// fields, not provider bodies, thoughts, summaries, headers or error messages.
const textLength = value => (typeof value === 'string' ? value.trim().length : null);

function quoteDiagnostics(article, decisions, apiKey, validationMessage = null) {
  const evidence = article.evidence.map((text, index) => ({ index, text, normalized: normalizeQuote(text) }));
  const detail = {
    company: article.company, url: article.url, title: article.title,
    ...(validationMessage ? { validation_message: validationMessage } : {}),
    expected_candidate_ids: article.candidates.map(c => c.id),
    expected_kinds: Object.fromEntries(article.candidates.map(c => [c.id, c.kind])),
    evidence_blocks: evidence,
    decisions: decisions.map((d, decision_index) => ({
      decision_index,
      candidate_id: typeof d.candidate_id === 'string' ? d.candidate_id : null,
      // enum·불리언은 그대로, 자유 텍스트는 길이만. 어느 검증이 깨졌는지 이걸로 좁힌다.
      event_stage: typeof d.event_stage === 'string' ? d.event_stage : null,
      quality: typeof d.quality === 'string' ? d.quality : null,
      booleans: Object.fromEntries(['entity_supported', 'target_technology_supported', 'indicator_supported', 'leading_indicator_supported']
        .map(k => [k, typeof d[k] === 'boolean' ? d[k] : `(${typeof d[k]})`])),
      reason_ko_length: textLength(d.reason_ko),
      summary_ko_length: textLength(d.summary_ko),
      summary_en_length: textLength(d.summary_en),
      quotes_is_array: Array.isArray(d.evidence_quotes),
      quotes: Array.isArray(d.evidence_quotes) ? d.evidence_quotes.map((quote, quote_index) => {
        if (typeof quote !== 'string') return { quote_index, invalid_type: quote === null ? 'null' : typeof quote };
        const normalized = normalizeQuote(quote);
        return { quote_index, quote, normalized,
          matching_block_indices: normalized ? evidence.filter(block => block.normalized.includes(normalized)).map(block => block.index) : [] };
      }) : [],
    })),
  };
  // Redact the configured key even if it unexpectedly appears in supplied text.
  return JSON.parse(JSON.stringify(detail, (_, value) => typeof value === 'string' && apiKey
    ? value.split(apiKey).join('[REDACTED]') : value));
}

export async function requestReview(article, policy, apiKey, fetchImpl = fetch, retry = false, provider = PROVIDER) {
  const invalid = code => invalidResponse(code, provider.label);
  let response;
  try {
    response = await fetchImpl(provider.url(provider.model), {
      method: 'POST', headers: provider.headers(apiKey),
      signal: AbortSignal.timeout(120000),
      body: JSON.stringify(provider.body({ article, policy, retry, model: provider.model })),
    });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError' || error instanceof TypeError) {
      throw Object.assign(new Error(`${provider.label} transport error`), { transport_error: true });
    }
    throw error;
  }
  // Do not log provider response bodies: they may contain supplied text or credentials.
  if (!response.ok) {
    const error = new Error(`${provider.label} HTTP ${response.status}`);
    error.status = response.status;
    const detail = await response.json().catch(() => ({}));
    const message = String(detail.error?.message || '').toLowerCase();
    error.provider_reason = /overload|high demand|capacity/.test(message) ? 'capacity'
      : /model.*not found|model.*not supported/.test(message) ? 'model_unavailable'
      : /api key/.test(message) ? 'api_key' : 'unspecified';
    throw error;
  }
  const payload = await response.json().catch(() => { throw invalid('invalid_json'); });
  const { text, usage } = provider.parse(payload, invalid);
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw invalid('invalid_json'); }
  if (!parsed || !Array.isArray(parsed.decisions) || parsed.decisions.some(d => !d || typeof d !== 'object')) throw invalid('invalid_decisions');
  // Business activity has no investment-stage test. These are contract constants,
  // not model judgements; entity, technology, concrete activity and quotes still gate approval.
  if (Array.isArray(parsed.decisions)) parsed.decisions = parsed.decisions.map(decision =>
    article.candidates.some(c => c.id === decision.candidate_id && c.kind === 'relevant')
      ? { ...decision, leading_indicator_supported: true, event_stage: 'not_applicable' } : decision);
  const separated = separateVerifiedQuotes(article, parsed.decisions);
  const review = { article_id: article.id, reviewer: `${provider.model}/${VERSION}`, provider: provider.id, decisions: separated.decisions,
    ...(separated.repairs.length ? { quote_repairs: separated.repairs } : {}), usage };
  try { importReview(article, review); } catch (error) {
    const failure = invalid(/evidence_quotes/.test(error.message) ? 'evidence_mismatch'
      : /needs an evidence quote/.test(error.message) ? 'missing_evidence' : 'review_validation');
    // importReview 의 메시지는 우리가 만든 문구다. 회사명과 후보 id 만 담고 모델 출력은 담지 않는다.
    failure.diagnostic = quoteDiagnostics(article, parsed.decisions, apiKey, error.message);
    throw failure;
  }
  return review;
}

export async function reviewArticles({ articles, reviewDir, policy, config, fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), random = Math.random }) {
  let requests = 0, cached = 0, completed = 0;
  const failed = [];
  const diagnostics = [];
  const state = extra => ({ requests, cached, completed, total: articles.length, failed_articles: failed, diagnostics, ...extra });
  for (const article of articles) {
    const file = path.join(reviewDir, `${article.id}.json`);
    try {
      const review = await read(file);
      if (review.reviewer !== `${PROVIDER.model}/${VERSION}` || review.provider !== PROVIDER.id) throw new Error('cache provider mismatch');
      importReview(article, review);
      cached++; completed++;
      continue;
    } catch (error) {
      if (error.code !== 'ENOENT') console.log(`Rechecking invalid cache: ${article.id}`);
    }
    let providerRetries = 0, waitMs = config.delayMs;
    for (let attempt = 0; attempt < 2;) {
      if (requests >= config.maxRequests) return state({ status: 'paused', reason: 'request_budget' });
      if (requests) await sleep(waitMs);
      waitMs = config.delayMs;
      requests++;
      let review;
      try {
        review = await requestReview(article, policy, config.apiKey, fetchImpl, attempt > 0);
      } catch (error) {
        // Outage retries and invalid-output retries share the run request budget.
        if ((error.status >= 500 || error.transport_error) && providerRetries < 2) {
          waitMs = Math.max(config.delayMs, 15000 * 2 ** providerRetries + Math.floor(random() * 1000));
          providerRetries++;
          console.log(`Article ${article.id}: transient provider error; retry ${providerRetries}/2 after ${waitMs}ms`);
          continue;
        }
        if (error.status === 429 || error.status >= 500) return state({ status: 'paused', reason: error.status === 429 ? 'quota' : 'provider_unavailable', http_status: error.status, provider_reason: error.provider_reason });
        if (error.transport_error) return state({ status: 'paused', reason: 'transport_error' });
        if (!error.response_code) throw error;
        const diagnosticPath = `${path.basename(reviewDir)}/diagnostics/${article.id}/${crypto.randomUUID()}-attempt-${attempt + 1}.json`;
        await write(path.join(path.dirname(reviewDir), diagnosticPath), {
          schema_version: 1, article_id: article.id, model: MODEL,
          created_at: new Date().toISOString(), attempt: attempt + 1,
          reason: error.response_code, ...(error.diagnostic || {}),
        });
        diagnostics.push({ article_id: article.id, attempt: attempt + 1, reason: error.response_code, file: diagnosticPath });
        const failure = { article_id: article.id, reason: error.response_code };
        console.log(`Article ${article.id}: ${error.response_code} (attempt ${attempt + 1}/2)`);
        if (attempt === 1) failed.push(failure);
        attempt++;
        continue;
      }
      await write(file, review);
      completed++;
      console.log(`Reviewed ${completed}/${articles.length}: ${article.company}`);
      break;
    }
  }
  return state(failed.length ? { status: 'paused', reason: 'invalid_responses' } : { status: 'completed' });
}

async function main() {
  const config = configuration(); // fail before crawling or calling any model
  const from = process.env.REPORT_FROM_DATE, to = process.env.REPORT_TO_DATE;
  for (const date of [from, to]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error('Valid REPORT_FROM_DATE and REPORT_TO_DATE are required');
  }
  if (from > to) throw new Error('Invalid reporting period');
  const period = { from_date: from, to_date: to };
  const root = path.resolve('outputs/review_work');
  const policyDoc = await fs.readFile('docs/local_report_review.md', 'utf8');
  // Share the reviewed judgement contract, excluding instructions for the local CLI workflow.
  const policyText = policyDoc.split('## 판정 기준')[1].split('## 기사별 응답 형식')[0];
  const [targets, technology, indicators] = await Promise.all([
    read('data/target_companies.json'), read('data/company_technology_map.json'), read('config/investment_signal_indicators.json'),
  ]);
  const policy = `${VERSION}:${digest([PROVIDER.id, MODEL, policyText, technology, indicators])}`;
  const inputDir = path.join(root, `${from}_${to}`);
  const sourceFile = path.join(inputDir, 'latest_company_signals.json');
  if (process.env.REPORT_REFRESH === 'true') await fs.rm(inputDir, { recursive: true, force: true });
  try { await fs.access(sourceFile); await fs.access(path.join(inputDir, 'latest_collection_summary.json')); }
  catch {
    const result = spawnSync(process.execPath, ['scripts/collect_company_signals.mjs', '--companies', 'data/target_companies.json', '--source-config', 'config/company_sources.json', '--out-dir', inputDir,
      '--sources', 'official_feeds,official_pages,google_news', '--from-date', from, '--to-date', to,
      '--max-per-source', '6', '--max-per-company', '10', '--max-detail-per-company', '10', '--fallback-mode', 'missing', '--fallback-min-results', '1', '--rate-limit-seconds', '0.5', '--company-concurrency', '4'], { stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error('Collection failed');
  }
  const [signals, summary] = await Promise.all([read(sourceFile), read(path.join(inputDir, 'latest_collection_summary.json'))]);
  if (summary.from_date !== from || summary.to_date !== to) throw new Error('Cached collection period mismatch');
  const candidates = sourceCandidates(signals, technology, indicators, period);
  const articles = groupArticles(candidates.investment, candidates.relevant, period, policy);
  const snapshot = { policy, period, summary, signals, articles, targets, technology, indicators };
  const runDir = path.join(root, `${from.slice(0, 7)}-${digest(snapshot)}`);
  await write(path.join(runDir, 'snapshot.json'), snapshot);
  const state = await reviewArticles({ articles, reviewDir: path.join(root, 'reviews'), policy: policyText, config });
  await write(path.join(root, 'status.json'), { ...state, period, provider: PROVIDER.id, model: MODEL });
  console.log(JSON.stringify(state));
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,
    `### ${PROVIDER.label} report\n${state.status}: ${state.completed}/${state.total} articles; ${state.requests} API requests; ${state.cached} cached.\n` +
    (state.status === 'paused' ? `Reason: ${state.reason}. Saved progress; rerun the same dates with refresh=false. For quota/provider errors, wait for recovery first. Existing published PDFs are unchanged.\n` : '') +
    state.failed_articles.map(item => `- Article ${item.article_id}: ${item.reason}\n`).join('') +
    state.diagnostics.map(item => `- Diagnostic in progress artifact: ${item.file} (${item.reason})\n`).join(''));
  if (state.status !== 'completed') { process.exitCode = 75; return; }
  const reportDir = await build({ runDir, issueNumber: process.env.REPORT_ISSUE_NUMBER || '2' });
  const investment = await read(path.join(reportDir, 'investment.json'));
  const relevant = await read(path.join(reportDir, 'relevant.json'));
  // The workflow commits these files together only after both PDFs have succeeded.
  for (const [source, target] of [['signals.json', 'latest_company_signals.json'], ['summary.json', 'latest_collection_summary.json'], ['investment.json', 'latest_investment_signals.json'], ['relevant.json', 'latest_relevant_signals.json']]) {
    await fs.copyFile(path.join(reportDir, source), path.join('outputs', target));
  }
  await write('outputs/latest_investment_signal_summary.json', { investment_signal_count: investment.length, companies_with_investment_signals: new Set(investment.map(r => r.company)).size, provider: PROVIDER.id });
  await write('outputs/latest_relevance_summary.json', { relevant_signal_count: relevant.length, companies_with_relevant_signals: new Set(relevant.map(r => r.company)).size, provider: PROVIDER.id });
  await write('outputs/latest_ai_summary_summary.json', { ...state, period, provider: PROVIDER.id, model: MODEL });
  await fs.mkdir('public/reports', { recursive: true });
  await fs.copyFile(path.join(reportDir, 'report_ko.pdf'), 'public/reports/latest_report.pdf');
  await fs.copyFile(path.join(reportDir, 'report_en.pdf'), 'public/reports/latest_report_en.pdf');
  await fs.rm(reportDir, { recursive: true, force: true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(async error => {
  console.error(error.message);
  await write(path.resolve('outputs/review_work/status.json'), {
    status: 'failed', reason: error.status ? 'provider_error' : 'validation_or_execution',
    http_status: error.status || null, provider: PROVIDER.id, model: MODEL,
    period: { from_date: process.env.REPORT_FROM_DATE || null, to_date: process.env.REPORT_TO_DATE || null },
  }).catch(() => {});
  if (error.status === 401 || error.status === 403) {
    const apiKey = PROVIDER.keyEnv.map(name => process.env[name]).find(Boolean);
    const shape = describeKeyShape(apiKey);
    console.error(`${PROVIDER.keyEnv[0]} 이 ${PROVIDER.label} 에서 거절됐다. 키는 찍지 않고 모양만 보고한다:`);
    console.error(`  길이 ${shape.length}, 접두사 ${shape.prefix} (${shape.issuer}), 앞뒤 공백 ${shape.had_surrounding_whitespace ? '있음' : '없음'}`);
    if (PROVIDER.expectedKeyPrefix && !String(apiKey).trim().startsWith(PROVIDER.expectedKeyPrefix)) {
      console.error(`  ${PROVIDER.label} 키는 보통 ${PROVIDER.expectedKeyPrefix} 로 시작한다. 이 시크릿에 다른 서비스 키가 들어 있는지 확인할 것.`);
    }
  }
  if (error.status === 404) {
    // Metadata-only request: report available model IDs, never select a paid fallback.
    try {
      const apiKey = PROVIDER.keyEnv.map(name => process.env[name]).find(Boolean);
      const models = await PROVIDER.listModels(apiKey);
      console.error(models.length ? `Available models: ${models.join(', ')}` : 'Model metadata unavailable');
    } catch { console.error('Model metadata unavailable'); }
  }
  process.exitCode = 1;
});
