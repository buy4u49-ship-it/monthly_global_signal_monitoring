#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { investmentStageSupported } from "./validate_report_inputs.mjs";

const CACHE_VERSION = 1;
const INVESTMENT_PROMPT_VERSION = "signal-summary-koen-v8";
const RELEVANT_PROMPT_VERSION = "business-summary-koen-v10";
const BUSINESS_SUMMARY_MIN_CHARS = 220;
const BUSINESS_SUMMARY_MIN_CHARS_EN = 260;
const KOREAN_TEXT_FIELDS = ["ai_summary_ko", "ai_summary_headline_ko", "ai_summary_detail_ko", "ai_summary_reason", "ai_summary_luna_draft"];
const ENGLISH_TEXT_FIELDS = ["ai_summary_en", "ai_summary_headline_en", "ai_summary_detail_en"];
const SUMMARY_FIELDS = [
  "ai_summary_ko",
  "ai_summary_headline_ko",
  "ai_summary_detail_ko",
  "ai_summary_en",
  "ai_summary_headline_en",
  "ai_summary_detail_en",
  "ai_signal_supported",
  "ai_entity_supported",
  "ai_target_technology_supported",
  "ai_indicator_supported",
  "ai_leading_indicator_supported",
  "ai_event_stage",
  "ai_summary_quality",
  "ai_summary_format_status",
  "ai_summary_confidence",
  "ai_summary_reason",
  "ai_summary_model",
  "ai_summary_tier",
  "ai_summary_luna_draft",
  "ai_summary_source",
  "ai_summary_created_at",
];

const DEFAULTS = {
  investmentSignals: "outputs/latest_investment_signals.json",
  relevantSignals: "outputs/latest_relevant_signals.json",
  cache: "outputs/ai_summary_cache.json",
  outDir: "outputs",
  lunaModel: process.env.AI_SUMMARY_LUNA_MODEL || "gpt-5.6-luna",
  terraModel: process.env.AI_SUMMARY_TERRA_MODEL || "gpt-5.6-terra",
  concurrency: 2,
  maxInputChars: 3600,
  maxOutputTokens: process.env.AI_SUMMARY_MAX_OUTPUT_TOKENS || 1600,
  retryMaxOutputTokens: process.env.AI_SUMMARY_RETRY_MAX_OUTPUT_TOKENS || 3200,
  reasoningEffort: process.env.AI_SUMMARY_REASONING_EFFORT || "low",
  failOnAllSummaryFailure: process.env.AI_SUMMARY_FAIL_ON_ALL_FAILURE || "true",
  summarizeRelevant: process.env.AI_SUMMARY_RELEVANT_SIGNALS || "true",
  onlyMissing: true,
  optional: false,
};

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) continue;
    const name = key.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      args[name] = true;
      continue;
    }
    args[name] = next;
    index += 1;
  }
  args.concurrency = Math.max(1, Number(args.concurrency) || DEFAULTS.concurrency);
  args.maxInputChars = Math.max(1000, Number(args.maxInputChars) || DEFAULTS.maxInputChars);
  args.maxOutputTokens = Math.max(500, Number(args.maxOutputTokens) || Number(DEFAULTS.maxOutputTokens));
  args.retryMaxOutputTokens = Math.max(args.maxOutputTokens, Number(args.retryMaxOutputTokens) || Number(DEFAULTS.retryMaxOutputTokens));
  args.onlyMissing = args.onlyMissing !== "false" && args.onlyMissing !== false;
  args.optional = args.optional !== "false" && args.optional !== false;
  args.failOnAllSummaryFailure = args.failOnAllSummaryFailure !== "false" && args.failOnAllSummaryFailure !== false;
  args.summarizeRelevant = args.summarizeRelevant === "true" || args.summarizeRelevant === true;
  return args;
}

async function readJson(filePath, fallback = []) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/<[^>]+>/g, " ")
    .trim();
}

// 유치필요 품목(기술) 관련성 검사를 사용자 요청으로 생략한 기업의 행.
// 이런 행은 타겟 기술 연결을 승인 조건으로 요구하지 않는다. 요구하면 분류 단계의 면제가
// AI 판정 단계에서 되살아나 어떤 행도 통과할 수 없다.
export function isRelevanceExempt(row) {
  return row?.excluded_from_relevance === true || row?.technology_gate_decision === "relevance_exempt";
}

function reasonDeniesDirectSupport(value) {
  const reason = cleanText(value);
  return [
    /직접적? (?:연관성|연계).*(?:확인되지|없음)/i,
    /직접 관련.*(?:근거.*제시되지|확인되지)/i,
    /자체는 언급되지/i,
    /not directly (?:related|linked)/i,
    /no direct (?:evidence|link|connection|relevance)/i,
  ].some((pattern) => pattern.test(reason));
}

function normalizeKoreanSummaryText(value) {
  return cleanText(value)
    .replace(/중순수%/g, "한 자릿수 중반대")
    .replace(/저순수%/g, "한 자릿수 초반대")
    .replace(/고순수%/g, "한 자릿수 후반대")
    .replace(/중순수/g, "한 자릿수 중반대")
    .replace(/저순수/g, "한 자릿수 초반대")
    .replace(/고순수/g, "한 자릿수 후반대")
    .replace(/중반 두 자릿수/g, "두 자릿수 중반대")
    .replace(/초반 두 자릿수/g, "두 자릿수 초반대")
    .replace(/후반 두 자릿수/g, "두 자릿수 후반대")
    .replace(/중반대 두 자릿수/g, "두 자릿수 중반대")
    .replace(/초반대 두 자릿수/g, "두 자릿수 초반대")
    .replace(/후반대 두 자릿수/g, "두 자릿수 후반대")
    .replace(/उपलब्ध성/g, "가용성")
    .trim();
}

function phraseEndingText(value) {
  let text = String(value || "").trim();
  const replacements = [
    [/확인되지\s+(않았다|않는다)$/g, "확인되지 않음"],
    [/제시되지\s+(않았다|않는다)$/g, "제시되지 않음"],
    [/나타나지\s+(않았다|않는다)$/g, "나타나지 않음"],
    [/부족하다$/g, "부족"],
    [/필요하다$/g, "필요"],
    [/계획이다$/g, "계획"],
    [/예정이다$/g, "예정"],
    [/목표로\s+하고\s+있다$/g, "목표"],
    [/추진\s+중이다$/g, "추진"],
    [/검토\s+중이다$/g, "검토"],
    [/진행\s+중이다$/g, "진행"],
    [/이어지고\s+있다$/g, "지속"],
    [/진행하고\s+있다$/g, "진행"],
    [/추진하고\s+있다$/g, "추진"],
    [/검토하고\s+있다$/g, "검토"],
    [/보여준다$/g, "시사"],
    [/시사한다$/g, "시사"],
    [/해석된다$/g, "해석"],
    [/판단된다$/g, "판단"],
    [/예상된다$/g, "예상"],
    [/확인된다$/g, "확인"],
    [/확인됐다$/g, "확인"],
    [/나타났다$/g, "확인"],
    [/언급됐다$/g, "언급"],
    [/언급했다$/g, "언급"],
    [/발표됐다$/g, "발표"],
    [/발표했다$/g, "발표"],
    [/공개했다$/g, "공개"],
    [/밝혔다$/g, "공개"],
    [/체결했다$/g, "체결"],
    [/서명했다$/g, "서명"],
    [/선임했다$/g, "선임"],
    [/인수했다$/g, "인수"],
    [/완료했다$/g, "완료"],
    [/가동했다$/g, "가동"],
    [/기록했다$/g, "기록"],
    [/제공한다$/g, "제공"],
    [/제공했다$/g, "제공"],
    [/지원한다$/g, "지원"],
    [/지원했다$/g, "지원"],
    [/적용한다$/g, "적용"],
    [/적용했다$/g, "적용"],
    [/수용했다$/g, "수용"],
    [/확대한다$/g, "확대"],
    [/확대했다$/g, "확대"],
    [/강화한다$/g, "강화"],
    [/강화했다$/g, "강화"],
    [/구축한다$/g, "구축"],
    [/구축했다$/g, "구축"],
    [/개발한다$/g, "개발"],
    [/개발했다$/g, "개발"],
    [/운영한다$/g, "운영"],
    [/운영했다$/g, "운영"],
    [/있다$/g, ""],
    [/없다$/g, "없음"],
    [/된다$/g, ""],
    [/됐다$/g, ""],
    [/한다$/g, ""],
    [/했다$/g, ""],
    [/이다$/g, ""],
  ];
  for (const [pattern, replacement] of replacements) {
    text = text.replace(pattern, replacement);
  }
  return text.trim();
}

function phraseifySummaryText(value) {
  const connectorMap = {
    "구축하고": "구축",
    "확보하고": "확보",
    "강화하고": "강화",
    "확대하고": "확대",
    "공급하고": "공급",
    "체결하고": "체결",
    "수행하고": "수행",
    "협력하고": "협력",
    "진행하고": "진행",
    "도입하고": "도입",
    "설치하고": "설치",
    "시연하고": "시연",
    "개발하고": "개발",
    "운영하고": "운영",
    "공개하고": "공개",
    "투자하고": "투자",
    "언급하고": "언급",
    "기록하고": "기록",
    "가동하고": "가동",
    "완료하고": "완료",
    "발표하고": "발표",
    "제공하며": "제공",
    "적용하며": "적용",
    "추진하며": "추진",
    "검토하며": "검토",
    "밝혔으며": "공개",
    "발표했으며": "발표",
    "체결했으며": "체결",
    "기록했으며": "기록",
    "확인했으며": "확인",
  };
  const connectorPattern = new RegExp(`(${Object.keys(connectorMap).join("|")})(,\\s*|\\s+|$)`, "g");
  const text = normalizeKoreanSummaryText(value)
    .replace(/^[A-Za-z0-9().&/-]+(?:\s+[A-Za-z0-9().&/-]+){0,3}(은|는|이|가)\s+/, "")
    .replace(/^[가-힣A-Za-z0-9().·&/-]+(?:와\s+[가-힣A-Za-z0-9().·&/-]+)?(은|는|이|가)\s+/, "")
    .replace(/^(이는|다만|또한)\s+/g, "")
    .replace(/([A-Za-z][A-Za-z0-9().·&/-]*)의\s+/g, "$1 ")
    .replace(connectorPattern, (_, verb, separator) => `${connectorMap[verb]}${separator?.includes(",") ? ", " : " "}`)
    .replace(/영향을\s+(줄|미칠)\s+수\s+있다고\s+밝혔다/g, "영향 가능성 언급")
    .replace(/수\s+있다고\s+밝혔다/g, "가능성 언급")
    .replace(/됐다고\s+(공개|발표|언급)/g, " $1")
    .replace(/했다고\s+(공개|발표|언급)/g, " $1")
    .replace(/([가-힣A-Za-z0-9/·().-]+)(됐|되었|했다|였다|었다|았다)고\s+(공개|발표|언급)/g, "$1 $3")
    .replace(/(이라고 밝혔다|라고 밝혔다|다고 밝혔다|다고 발표했다|다고 설명했다|으로 확인됐다|로 확인됐다|이 확인됐다|가 확인됐다|를 확인했다|을 확인했다)/g, "")
    .replace(/\s+(다만|또한|그리고)\s+/g, ", ")
    .replace(/[.!?。]+/g, ". ");

  return text
    .split(/\s*\.\s*|\s*;\s*/)
    .map((clause) => phraseEndingText(clause.replace(/^(이는|다만|또한|그리고)\s+/g, "")))
    .filter(Boolean)
    .join(", ")
    .replace(/\s*,\s*,\s*/g, ", ")
    .replace(/(을|를)\s+(발표|공개|추진|검토|확보|제공|지원|적용|수용|확대|강화|구축|개발|운영|체결|서명|선임|인수|완료|가동|기록|시연|도입)(?=,|$)/g, " $2")
    .replace(/(을|를)\s+단계적으로\s+추진/g, " 단계적 추진")
    .replace(/확대할\s+계획/g, "확대 계획")
    .replace(/(을|를)\s+위험요인으로\s+언급/g, " 위험요인 언급")
    .replace(/영향을\s+위험요인으로\s+언급/g, "영향 위험요인 언급")
    .replace(/(에|에서|와|과|으로|로)\s+(서명|참여|협력|착수|진입|진출|투자|가동|운영|적용)(?=,|$)/g, " $2")
    .replace(/(이|가|은|는)\s+(확인|예상|증가|감소|지속|필요|부족|완료)(?=,|$)/g, " $2")
    .replace(/(재활용|가동|확보|활용|도입|설치|시연|개발|운영|제공|적용|수행|체결|추진|완료)해\s+/g, "$1·")
    .replace(/([가-힣A-Za-z0-9/·().-]+)하는\s+/g, "$1 ")
    .replace(/([가-힣A-Za-z0-9/·().-]+)하려는\s+움직임으로\s+해석/g, "$1 움직임")
    .replace(/계획은 확인되지 않음/g, "계획 확인되지 않음")
    .replace(/사실은 확인되지 않음/g, "사실 확인되지 않음")
    .replace(/근거는 확인되지 않음/g, "근거 확인되지 않음")
    .replace(/내용은 확인되지 않음/g, "내용 확인되지 않음")
    .replace(/관련성은 확인되지 않음/g, "관련성 확인되지 않음")
    .replace(/직접 연계는 확인되지 않음/g, "직접 연계 확인되지 않음")
    .replace(/직접적 연관성은 확인되지 않음/g, "직접 연관성 확인되지 않음")
    .replace(/연계도 확인되지 않음/g, "연계 확인되지 않음")
    .replace(/,\s+[가-힣A-Za-z0-9().·&/-]+(?:와\s+[가-힣A-Za-z0-9().·&/-]+)?(은|는)\s+/g, ", ")
    .replace(/가능성을\s+시사/g, "가능성")
    .replace(/,\s*(다만|또한)\s+/g, ", ")
    .replace(/\s*·\s*/g, "·")
    .replace(/\s+/g, " ")
    .trim();
}

function conciseSummaryPhrase(value, limit = 80) {
  const text = phraseifySummaryText(value);
  return shortText(text, limit);
}

function summaryHeadlineDetail({ headline, detail, summary }) {
  const normalizedHeadline = conciseSummaryPhrase(headline, 58);
  const normalizedDetail = conciseSummaryPhrase(detail, 105);
  if (normalizedHeadline || normalizedDetail) {
    return {
      headline: normalizedHeadline || conciseSummaryPhrase(summary, 58),
      detail: normalizedDetail,
    };
  }

  const text = normalizeKoreanSummaryText(summary);
  const dashed = text.split(/\s[-–—]\s/);
  if (dashed.length >= 2) {
    return {
      headline: conciseSummaryPhrase(dashed[0], 58),
      detail: conciseSummaryPhrase(dashed.slice(1).join(" - "), 105),
    };
  }
  const sentences = text.split(/(?<=[.!?。])\s+/).filter(Boolean);
  if (sentences.length >= 2) {
    return {
      headline: conciseSummaryPhrase(sentences[0], 58),
      detail: conciseSummaryPhrase(sentences.slice(1).join(" "), 105),
    };
  }
  const clauses = text.split(/,\s*/).filter(Boolean);
  if (clauses.length >= 2) {
    return {
      headline: conciseSummaryPhrase(clauses[0], 58),
      detail: conciseSummaryPhrase(clauses.slice(1).join(", "), 105),
    };
  }
  return {
    headline: conciseSummaryPhrase(text, 58),
    detail: "",
  };
}

function shortText(value, limit) {
  const text = cleanText(value);
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

// 영문은 한국어 조사/종결어미 정리 규칙을 적용하지 않고 공백 정리만 한다.
function englishHeadlineDetail({ headline, detail, summary }) {
  const normalizedHeadline = shortText(headline, 110);
  const normalizedDetail = shortText(detail, 240);
  if (normalizedHeadline || normalizedDetail) {
    return { headline: normalizedHeadline || shortText(summary, 110), detail: normalizedDetail };
  }

  const text = cleanText(summary);
  const dashed = text.split(/\s[-–—]\s/);
  if (dashed.length >= 2) {
    return { headline: shortText(dashed[0], 110), detail: shortText(dashed.slice(1).join(" - "), 240) };
  }
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (sentences.length >= 2) {
    return { headline: shortText(sentences[0], 110), detail: shortText(sentences.slice(1).join(" "), 240) };
  }
  return { headline: shortText(text, 110), detail: "" };
}

function sourceEvidence(row) {
  const snippets = [
    ...(Array.isArray(row.evidence_snippets) ? row.evidence_snippets : []),
    ...(Array.isArray(row.technology_evidence_snippets) ? row.technology_evidence_snippets : []),
  ];
  return cleanText([snippets.join(" "), row.content_excerpt, row.content_text].filter(Boolean).join(" "));
}

function rowIdentity(row) {
  return [
    row.target_no,
    row.company,
    row.investment_signal_no || row.relevance_decision || "relevant",
    row.url || row.title,
  ]
    .filter((value) => value !== undefined && value !== null && value !== "")
    .join("|");
}

function sourceMaterial(row, maxInputChars) {
  const body = [
    `기업: ${row.company || ""}`,
    `유치필요 품목/기술: ${row.target_technology || ""}`,
    `시그널: ${row.investment_signal_label || row.relevance_decision || ""}`,
    `시그널 설명: ${row.investment_signal_description || ""}`,
    `제목: ${row.title || ""}`,
    `출처: ${row.source || ""}`,
    `게시일: ${row.published_at || ""}`,
    `기존 판정 근거: ${row.investment_signal_reason || row.relevance_reason || ""}`,
    `매칭 키워드: ${(row.matched_terms || row.technology_matched_terms || []).join(", ")}`,
    `본문/근거: ${sourceEvidence(row)}`,
  ].join("\n");
  return shortText(body, maxInputChars);
}

function cachePayload(row, args) {
  return {
    prompt_version: row.investment_signal_no ? INVESTMENT_PROMPT_VERSION : RELEVANT_PROMPT_VERSION,
    company: cleanText(row.company),
    target_no: String(row.target_no || ""),
    signal: String(row.investment_signal_no || row.relevance_decision || "relevant"),
    target_technology: cleanText(row.target_technology),
    title: cleanText(row.title),
    url: cleanText(row.url),
    source: cleanText(row.source),
    published_at: cleanText(row.published_at),
    input: sourceMaterial(row, args.maxInputChars),
  };
}

function cacheKey(row, args) {
  return crypto.createHash("sha256").update(JSON.stringify(cachePayload(row, args))).digest("hex").slice(0, 32);
}

function summaryFromRow(row) {
  if (!cleanText(row.ai_summary_ko) && !cleanText(row.ai_summary_headline_ko) && !cleanText(row.ai_summary_detail_ko)) return null;
  const summary = {};
  for (const field of SUMMARY_FIELDS) {
    if (row[field] !== undefined && row[field] !== null && row[field] !== "") {
      if (KOREAN_TEXT_FIELDS.includes(field)) summary[field] = normalizeKoreanSummaryText(row[field]);
      else if (ENGLISH_TEXT_FIELDS.includes(field)) summary[field] = cleanText(row[field]);
      else summary[field] = row[field];
    }
  }
  return summary;
}

function hasCompleteSummaryDecision(row) {
  if (!cleanText(row?.ai_summary_ko) || !cleanText(row?.ai_summary_en) || !cleanText(row?.ai_summary_reason)) return false;
  if (!["pass", "needs_review"].includes(row?.ai_summary_quality)) return false;
  if (!["exploratory", "planned", "precursor", "committed", "completed", "not_applicable", "unclear"].includes(row?.ai_event_stage)) {
    return false;
  }
  return [
    "ai_signal_supported",
    "ai_entity_supported",
    "ai_target_technology_supported",
    "ai_indicator_supported",
    "ai_leading_indicator_supported",
  ].every((field) => typeof row?.[field] === "boolean");
}

function withoutSummaryFields(row) {
  const next = { ...row };
  for (const field of SUMMARY_FIELDS) delete next[field];
  delete next.ai_summary_cache_hit_at;
  return next;
}

async function readSummaryCache(cachePath) {
  const fallback = { version: CACHE_VERSION, entries: {} };
  const cache = await readJson(cachePath, fallback);
  if (!cache || typeof cache !== "object" || Array.isArray(cache)) return fallback;
  return {
    version: cache.version || CACHE_VERSION,
    updated_at: cache.updated_at || "",
    entries: cache.entries && typeof cache.entries === "object" && !Array.isArray(cache.entries) ? cache.entries : {},
  };
}

function cacheMetadata(row, key) {
  return {
    cache_key: key,
    row_identity: rowIdentity(row),
    company: row.company || "",
    target_no: row.target_no || "",
    investment_signal_no: row.investment_signal_no || "",
    relevance_decision: row.relevance_decision || "",
    title: row.title || "",
    url: row.url || "",
    source: row.source || "",
    published_at: row.published_at || "",
    target_technology: row.target_technology || "",
  };
}

function applyCachedSummaries(rows, args, cache) {
  let hitCount = 0;
  const updated = rows.map((row) => {
    const key = cacheKey(row, args);
    const existingSummary = summaryFromRow(row);
    if (hasCompleteSummaryDecision(row) && row.ai_summary_cache_key === key) {
      hitCount += 1;
      return { ...row, ai_summary_cache_key: key, ai_summary_cache_status: row.ai_summary_cache_status || "existing" };
    }
    const entry = cache.entries[key];
    const summary = entry && hasCompleteSummaryDecision(entry) ? summaryFromRow(entry) : null;
    if (!summary) {
      const baseRow = existingSummary && row.ai_summary_cache_key !== key ? withoutSummaryFields(row) : row;
      return { ...baseRow, ai_summary_cache_key: key, ai_summary_cache_status: existingSummary ? "miss_changed" : "miss" };
    }
    hitCount += 1;
    return {
      ...row,
      ...summary,
      ai_summary_cache_key: key,
      ai_summary_cache_status: "hit",
      ai_summary_cache_hit_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    };
  });
  return { rows: updated, hitCount };
}

function updateSummaryCache(cache, rows, args) {
  const next = {
    version: CACHE_VERSION,
    updated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    entries: { ...(cache.entries || {}) },
  };
  let storedCount = 0;
  for (const row of rows) {
    const summary = summaryFromRow(row);
    if (!summary || row.ai_summary_quality === "failed") continue;
    const key = row.ai_summary_cache_key || cacheKey(row, args);
    next.entries[key] = {
      ...cacheMetadata(row, key),
      ...summary,
      prompt_version: row.investment_signal_no ? INVESTMENT_PROMPT_VERSION : RELEVANT_PROMPT_VERSION,
      cached_at: next.updated_at,
    };
    storedCount += 1;
  }
  return { cache: next, storedCount };
}

function extractOutputText(payload) {
  if (typeof payload.output_text === "string") return payload.output_text;
  const chunks = [];
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") chunks.push(content.text);
      if (typeof content.output_text === "string") chunks.push(content.output_text);
    }
  }
  return chunks.join("\n").trim();
}

function parseModelJson(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) throw new Error("empty model output");
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`non-json model output: ${trimmed.slice(0, 120)}`);
    return JSON.parse(match[0]);
  }
}

function emptyOutputErrorMessage({ tier, model, payload, maxOutputTokens }) {
  const status = payload.status || "unknown";
  const reason = payload.incomplete_details?.reason || "none";
  const outputTokens = payload.usage?.output_tokens ?? "unknown";
  return `${tier} ${model}: empty model output (status=${status}, reason=${reason}, output_tokens=${outputTokens}, max_output_tokens=${maxOutputTokens})`;
}

function shouldRetryModelOutput(error) {
  return /empty model output|max_output_tokens/i.test(error.message || "");
}

async function callOpenAI({ apiKey, model, row, args, tier, maxOutputTokens, kind }) {
  const input = sourceMaterial(row, args.maxInputChars);
  const isBusinessSummary = kind === "relevant";
  const relevanceExempt = isRelevanceExempt(row);
  const prompt = [
    "너는 KOTRA 투자유치 모니터링 보고서 편집자다.",
    "주어진 공식 보도자료/IR/뉴스 본문에서 유치필요 품목/기술과 관련된 사실만 골라 한국어로 요약한다.",
    isBusinessSummary
      ? "이 항목은 보고서 하단의 글로벌 사업현황 박스에 들어간다. summary_ko는 PDF에서 4줄 전후로 보이는 통합 한국어 요약문으로 작성한다. 반드시 3~4문장, 총 260~360자 내외로 쓴다. summary_headline_ko와 summary_detail_ko는 빈 문자열로 둔다."
      : "이 항목은 5대 투자동향 시그널 상세에 들어간다. 완전한 문장이 아니라 보고서식 간략 문구로 작성한다.",
    isBusinessSummary
      ? "별도 해석 문장이나 편집자 코멘트를 덧붙이지 말고, 보도자료/IR에 담긴 사업 활동·기술 적용·고객/시장 흐름을 하나의 자연스러운 요약으로 통합한다."
      : "summary_headline_ko는 전체 내용의 개괄 요약 문구다. 18~42자, 명사구 중심, 종결어미 없이 쓴다.",
    isBusinessSummary
      ? "보고서체 문장으로 작성한다. 존대말과 구어체를 쓰지 않는다. '습니다', '합니다', '했습니다', '보여줍니다', '분류했습니다', '보완합니다'는 절대 쓰지 않는다."
      : "summary_detail_ko는 관련 핵심 내용의 상세 요약 문구다. 35~85자, 종결어미 없이 보고서 캡션처럼 쓴다.",
    isBusinessSummary
      ? "summary_ko에는 자연스러운 문장형 요약만 넣고, '-'로 headline/detail을 나누지 않는다. 1문장짜리 또는 2문장짜리 요약은 실패로 간주된다. 문장 종결은 '확인된다', '제시된다', '예정이다', '수행한다', '추진한다' 같은 객관적 보고서체를 사용한다."
      : "summary_ko는 'summary_headline_ko - summary_detail_ko' 형식으로 합쳐서 쓴다. 회사명+은/는 형태로 시작하지 않는다. '했다', '한다', '있다', '없다', '보여준다' 같은 문장형 종결은 쓰지 않는다.",
    "성장률 표현은 자연스럽게 번역한다. 예: mid-single-digit=한 자릿수 중반대, low-single-digit=한 자릿수 초반대, high-single-digit=한 자릿수 후반대, mid double-digit=두 자릿수 중반대. '중순수%', '저순수%', '고순수%' 같은 표현은 절대 쓰지 않는다.",
    "근거가 부족하면 quality를 needs_review로 둔다.",
    "entity_supported는 기사 속 사건이 현재 검토 기업 자체에 귀속될 때만 true다. 모회사·관계사 자료는 본문에 검토 기업명, 해당 사업부, 제품 또는 임원이 명시되어 사건 귀속이 확인될 때만 true다.",
    "target_technology_supported는 사건이 '유치필요 품목/기술'과 직접 연결될 때만 true다. 같은 기업의 다른 사업부·제품·일반 경영활동이면 false다.",
    isBusinessSummary
      ? "indicator_supported는 구체적인 기술·사업 활동이 있을 때 true다. 단순 행사 안내·배당·회사 소개는 false다. leading_indicator_supported만 true로 둔다. 기술 관련성 면제도 구체적 사업 활동 근거는 요구한다."
      : "indicator_supported는 본문이 위 '시그널' 정의에 해당하는 구체적 사건을 보여줄 때만 true다. 키워드 언급, 위험고지·전망 상용문구, 일반 재무항목만 있으면 false다.",
    isBusinessSummary
      ? "event_stage는 not_applicable로 둔다."
      : "event_stage는 exploratory, planned, precursor, committed, completed, unclear 중 하나다. exploratory/planned는 향후 투자 검토·계획, committed/completed는 최종 투자 프로젝트의 확정·완료다. precursor는 지표 1·3·4·5의 구체적 공급망 대응·투자 재원 조달·연구협업·전략 인력 이동 활동이 확인된 경우다. 이 활동의 계약·발표 완료만으로 최종 투자 확정으로 분류하지 않는다. 생산시설 투자 자체의 확정·가동이나 일반 인수 완료를 precursor로 우회 승인하지 않는다.",
    isBusinessSummary
      ? "leading_indicator_supported는 true로 둔다."
      : "leading_indicator_supported는 지표에 맞는 구체적 전조 활동이나 향후 투자 검토·계획의 근거가 있을 때 true다. 조달은 투자·사업 확장 용도, 협업은 특정 기술 과제, 인력 이동은 전략 역할·실사·사업 기회 탐색 연결이 필요하다. 일반 배당·인사·위험고지는 false다. 특정 최종 투자 완료 사실만 있으면 false다. 전조 활동을 근거로 미확인 투자 지역·금액·계획을 만들지 않는다.",
    "signal_supported는 위 개별 판정의 논리곱이어야 한다. 하나라도 false이거나 불명확하면 false로 둔다.",
    relevanceExempt
      ? "다만 이 기업은 유치필요 품목(기술) 관련성 검사에서 제외된 대상이다. target_technology_supported는 본문 근거대로 판단해 그대로 보고하되, 이 항목만은 signal_supported의 논리곱에서 제외한다. 판정 사유에 타겟 기술과의 연계 부재를 적더라도 그것만으로 signal_supported를 false로 두지 않는다."
      : "",
    "signal_supported가 false여도 요약문은 본문에 있는 사실 그대로 작성한다. 요약을 비우거나 지어내지 않는다.",
    "한국어 요약과 함께 같은 내용의 영문 요약도 작성한다. 영문은 한국어를 직역한 것이 아니라, 같은 사실을 영어 보고서 문체로 자연스럽게 쓴 것이어야 한다. 두 언어의 사실관계는 반드시 일치해야 한다.",
    isBusinessSummary
      ? "summary_en은 summary_ko와 같은 내용을 담은 3~4문장, 총 300~460자 내외의 영문 단락으로 쓴다. summary_headline_en과 summary_detail_en은 빈 문자열로 둔다."
      : "summary_headline_en은 명사구 중심의 짧은 영문 표제(40~90자)로 쓰고, summary_detail_en은 영문 보고서 캡션체(70~180자)로 쓴다. 둘 다 마침표로 끝내지 않는다. summary_en은 'summary_headline_en - summary_detail_en' 형식으로 합쳐서 쓴다.",
  ]
    .filter(Boolean)
    .join("\n");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      store: false,
      reasoning: { effort: args.reasoningEffort },
      max_output_tokens: maxOutputTokens,
      input: [
        { role: "system", content: [{ type: "input_text", text: prompt }] },
        { role: "user", content: [{ type: "input_text", text: input }] },
      ],
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "signal_summary",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              summary_ko: { type: "string" },
              summary_headline_ko: { type: "string" },
              summary_detail_ko: { type: "string" },
              summary_en: { type: "string" },
              summary_headline_en: { type: "string" },
              summary_detail_en: { type: "string" },
              signal_supported: { type: "boolean" },
              entity_supported: { type: "boolean" },
              target_technology_supported: { type: "boolean" },
              indicator_supported: { type: "boolean" },
              leading_indicator_supported: { type: "boolean" },
              // 사업동향은 단계 판정 대상이 아니고, 투자 시그널에는 not_applicable이 성립하지
              // 않는다. 두 값을 한 enum에 두면 모델이 투자 행에도 not_applicable을 골라
              // 단계 판정 자체를 건너뛴다.
              event_stage: {
                type: "string",
                enum: isBusinessSummary
                  ? ["not_applicable"]
                  : ["exploratory", "planned", "precursor", "committed", "completed", "unclear"],
              },
              quality: { type: "string", enum: ["pass", "needs_review"] },
              confidence: { type: "number" },
              reason: { type: "string" },
            },
            required: [
              "summary_ko",
              "summary_headline_ko",
              "summary_detail_ko",
              "summary_en",
              "summary_headline_en",
              "summary_detail_en",
              "signal_supported",
              "entity_supported",
              "target_technology_supported",
              "indicator_supported",
              "leading_indicator_supported",
              "event_stage",
              "quality",
              "confidence",
              "reason",
            ],
          },
        },
      },
    }),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body.error?.message || response.statusText || `HTTP ${response.status}`;
    throw new Error(`${tier} ${model}: ${message}`);
  }

  const outputText = extractOutputText(body);
  if (!cleanText(outputText)) {
    throw new Error(emptyOutputErrorMessage({ tier, model, payload: body, maxOutputTokens }));
  }

  const parsed = parseModelJson(outputText);
  const entitySupported = parsed.entity_supported === true;
  const targetTechnologySupported = parsed.target_technology_supported === true;
  const indicatorSupported = parsed.indicator_supported === true;
  const leadingIndicatorSupported = parsed.leading_indicator_supported === true;
  const decisionQualitySupported = parsed.quality === "pass";
  const eventStageSupported = isBusinessSummary
    ? parsed.event_stage === "not_applicable"
    : investmentStageSupported(parsed.event_stage, row.investment_signal_no);
  // 관련성 면제 행은 타겟 기술 연결을 요구하지 않으므로, 사유가 그 연결의 부재를 말하는 것도
  // 모순이 아니다. 따라서 사유 기반 거부도 함께 적용하지 않는다.
  const targetTechnologyRequired = !relevanceExempt;
  const targetTechnologySatisfied = targetTechnologySupported || !targetTechnologyRequired;
  const reasonSupported = !targetTechnologyRequired || !reasonDeniesDirectSupport(parsed.reason);
  const computedSignalSupported = isBusinessSummary
    ? entitySupported &&
      indicatorSupported &&
      targetTechnologySatisfied &&
      decisionQualitySupported &&
      eventStageSupported &&
      reasonSupported &&
      parsed.signal_supported === true
    : entitySupported &&
      targetTechnologySatisfied &&
      indicatorSupported &&
      leadingIndicatorSupported &&
      decisionQualitySupported &&
      eventStageSupported &&
      reasonSupported &&
      parsed.signal_supported === true;
  if (isBusinessSummary) {
    return {
      ai_summary_ko: normalizeKoreanSummaryText(parsed.summary_ko),
      ai_summary_headline_ko: "",
      ai_summary_detail_ko: "",
      ai_summary_en: cleanText(parsed.summary_en),
      ai_summary_headline_en: "",
      ai_summary_detail_en: "",
      ai_signal_supported: computedSignalSupported,
      ai_entity_supported: entitySupported,
      ai_target_technology_supported: targetTechnologySupported,
      ai_indicator_supported: indicatorSupported,
      ai_leading_indicator_supported: leadingIndicatorSupported,
      ai_event_stage: parsed.event_stage,
      ai_summary_quality: parsed.quality,
      ai_summary_confidence: Number(parsed.confidence) || 0,
      ai_summary_reason: normalizeKoreanSummaryText(parsed.reason),
      ai_summary_model: model,
      ai_summary_tier: tier,
    };
  }
  const parts = summaryHeadlineDetail({
    headline: parsed.summary_headline_ko,
    detail: parsed.summary_detail_ko,
    summary: parsed.summary_ko,
  });
  const englishParts = englishHeadlineDetail({
    headline: parsed.summary_headline_en,
    detail: parsed.summary_detail_en,
    summary: parsed.summary_en,
  });
  return {
    ai_summary_ko: normalizeKoreanSummaryText(`${parts.headline}${parts.detail ? ` - ${parts.detail}` : ""}`),
    ai_summary_headline_ko: parts.headline,
    ai_summary_detail_ko: parts.detail,
    ai_summary_en: cleanText(`${englishParts.headline}${englishParts.detail ? ` - ${englishParts.detail}` : ""}`),
    ai_summary_headline_en: englishParts.headline,
    ai_summary_detail_en: englishParts.detail,
    ai_signal_supported: computedSignalSupported,
    ai_entity_supported: entitySupported,
    ai_target_technology_supported: targetTechnologySupported,
    ai_indicator_supported: indicatorSupported,
    ai_leading_indicator_supported: leadingIndicatorSupported,
    ai_event_stage: parsed.event_stage,
    ai_summary_quality: parsed.quality,
    ai_summary_confidence: Number(parsed.confidence) || 0,
    ai_summary_reason: normalizeKoreanSummaryText(parsed.reason),
    ai_summary_model: model,
    ai_summary_tier: tier,
  };
}

async function callOpenAIWithRetry({ apiKey, model, row, args, tier, kind }) {
  try {
    return await callOpenAI({ apiKey, model, row, args, tier, maxOutputTokens: args.maxOutputTokens, kind });
  } catch (error) {
    if (!shouldRetryModelOutput(error) || args.retryMaxOutputTokens <= args.maxOutputTokens) {
      throw error;
    }
    const retried = await callOpenAI({ apiKey, model, row, args, tier, maxOutputTokens: args.retryMaxOutputTokens, kind });
    return {
      ...retried,
      ai_summary_reason: `${retried.ai_summary_reason} / initial retry after ${error.message}`,
      ai_summary_retry: true,
    };
  }
}

function needsBusinessSummaryRefresh(row) {
  const text = cleanText(row.ai_summary_ko);
  if (!text) return true;
  if (text.length < BUSINESS_SUMMARY_MIN_CHARS) return true;
  if (cleanText(row.ai_summary_headline_ko) || cleanText(row.ai_summary_detail_ko)) return true;
  if (/습니다|합니다|했습니다|보여줍니다|분류했습니다|보완합니다/.test(text)) return true;
  const english = cleanText(row.ai_summary_en);
  if (!english || english.length < BUSINESS_SUMMARY_MIN_CHARS_EN) return true;
  return false;
}

// 재요약이 필요한 이유와 그 성격을 함께 돌려준다.
// kind="format"은 요약문의 분량·문체 문제이고, kind="evidence"는 근거 자체가 약하다는 신호다.
// 두 가지를 구분해야 분량이 짧다는 이유로 근거가 확인된 행을 보고서에서 빼지 않는다.
export function terraReason(summary, kind) {
  const text = cleanText(summary.ai_summary_ko);
  const english = cleanText(summary.ai_summary_en);
  const koreanChars = (text.match(/[가-힣]/g) || []).length;
  const latinChars = (text.match(/[A-Za-z]/g) || []).length;
  const format = (message) => ({ kind: "format", message });
  const evidence = (message) => ({ kind: "evidence", message });
  if (!text || text.length < 35) return format("한국어 요약 분량 미달");
  if (!english || english.length < 30) return format("영문 요약 분량 미달");
  if (kind === "relevant" && text.length < BUSINESS_SUMMARY_MIN_CHARS) {
    return format(`한국어 요약 목표 분량 미달(${text.length}자 < ${BUSINESS_SUMMARY_MIN_CHARS}자)`);
  }
  if (koreanChars < 15) return format("한국어 문자 비중 부족");
  if (latinChars > koreanChars * 1.8) return format("한국어 요약에 원문 영문이 과다");
  if (/요약할 수 없|확인할 수 없|정보가 부족|needs_review/i.test(`${text} ${summary.ai_summary_quality}`)) {
    return evidence("요약문이 근거 부족을 명시");
  }
  if (summary.ai_summary_quality !== "pass") return evidence(`모델 품질 판정 ${summary.ai_summary_quality}`);
  if (summary.ai_summary_confidence < 0.72) return evidence(`모델 확신도 미달(${summary.ai_summary_confidence})`);
  return null;
}

function needsTerra(summary, kind) {
  return terraReason(summary, kind) !== null;
}

// 판정 이후 quality를 낮출 때는 승인값도 함께 내려야 supported=true와
// quality=needs_review가 동시에 남는 계약 위반이 생기지 않는다.
export function downgradeSummaryQuality(summary, reason) {
  return {
    ...summary,
    ai_signal_supported: false,
    ai_summary_quality: "needs_review",
    ai_summary_reason: reason,
  };
}

// 분량·문체 문제는 근거 판정이 아니므로 quality와 승인값을 건드리지 않고 별도 필드에만 남긴다.
// 근거가 확인된 행을 요약문이 짧다는 이유로 보고서에서 빼면 조용한 누락이 된다.
export function flagSummaryFormat(summary, status) {
  return { ...summary, ai_summary_format_status: status };
}

// Terra 재요약 뒤에도 남은 문제를 성격에 따라 다르게 반영한다.
function applyTerraShortfall(summary, shortfall, context) {
  if (!shortfall) return { ...summary, ai_summary_format_status: "ok" };
  const message = `${context}: ${shortfall.message}`;
  if (shortfall.kind === "format") return flagSummaryFormat(summary, message);
  return flagSummaryFormat(downgradeSummaryQuality(summary, `${summary.ai_summary_reason} / ${message}`), "ok");
}

async function summarizeRow(row, args, apiKey, kind) {
  const base = {
    ai_summary_created_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    ai_summary_source: "openai_responses_api",
    ai_summary_cache_status: "new",
  };
  let luna = await callOpenAIWithRetry({ apiKey, model: args.lunaModel, row, args, tier: "luna", kind });
  if (!needsTerra(luna, kind)) return { ...row, ...base, ...luna, ai_summary_format_status: "ok" };

  try {
    const terra = await callOpenAIWithRetry({ apiKey, model: args.terraModel, row, args, tier: "terra", kind });
    const terraShortfall = kind === "relevant" ? terraReason(terra, kind) : null;
    return {
      ...row,
      ...base,
      ...applyTerraShortfall(terra, terraShortfall, "Terra 재요약 후에도 미해결"),
      ai_summary_luna_draft: luna.ai_summary_ko,
    };
  } catch (error) {
    return {
      ...row,
      ...base,
      ...applyTerraShortfall(luna, terraReason(luna, kind), `Terra 재요약 실패(${error.message}) 후 Luna 결과 유지`),
    };
  }
}

async function mapLimit(rows, limit, mapper) {
  const result = new Array(rows.length);
  let cursor = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (cursor < rows.length) {
      const index = cursor;
      cursor += 1;
      result[index] = await mapper(rows[index], index);
    }
  });
  await Promise.all(workers);
  return result;
}

function allCsvHeaders(rows) {
  const seen = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row)) seen.add(key);
  }
  return [...seen];
}

function toCsvValue(value) {
  if (Array.isArray(value)) return toCsvValue(value.join("; "));
  if (value === null || value === undefined) return "";
  const stringValue = String(value);
  if (/[",\n\r]/.test(stringValue)) return `"${stringValue.replace(/"/g, '""')}"`;
  return stringValue;
}

async function writeCsv(filePath, rows) {
  const headers = allCsvHeaders(rows);
  const lines = [headers.join(",")];
  for (const row of rows) lines.push(headers.map((header) => toCsvValue(row[header])).join(","));
  await fs.writeFile(filePath, `\uFEFF${lines.join("\n")}\n`, "utf8");
}

async function summarizeRows(rows, args, apiKey, kind) {
  const targetRows = rows.map((row) => ({
    row,
    shouldSummarize:
      !args.onlyMissing ||
      !cleanText(row.ai_summary_ko) ||
      !cleanText(row.ai_summary_en) ||
      (kind === "relevant" && needsBusinessSummaryRefresh(row)),
  }));
  const targetCount = targetRows.filter((item) => item.shouldSummarize).length;
  let completed = 0;
  const updated = await mapLimit(targetRows, args.concurrency, async ({ row, shouldSummarize }) => {
    if (!shouldSummarize) return row;
    try {
      const summarized = await summarizeRow(row, args, apiKey, kind);
      completed += 1;
      process.stderr.write(`[${kind}] ${completed}/${targetCount} ${row.company}\n`);
      return summarized;
    } catch (error) {
      return {
        ...row,
        ai_signal_supported: false,
        ai_entity_supported: false,
        ai_target_technology_supported: false,
        ai_indicator_supported: false,
        ai_leading_indicator_supported: false,
        ai_event_stage: "unclear",
        ai_summary_quality: "failed",
        ai_summary_reason: error.message,
        ai_summary_created_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        ai_summary_cache_status: "failed",
      };
    }
  });
  return updated;
}

async function writeOutputs(rows, sourcePath, outDir, prefix) {
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
  const jsonPath = path.join(outDir, `${prefix}_${timestamp}.json`);
  const csvPath = path.join(outDir, `${prefix}_${timestamp}.csv`);
  await fs.writeFile(sourcePath, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
  await fs.writeFile(jsonPath, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
  await writeCsv(sourcePath.replace(/\.json$/i, ".csv"), rows);
  await writeCsv(csvPath, rows);
  return { latest_json: sourcePath, latest_csv: sourcePath.replace(/\.json$/i, ".csv"), json: jsonPath, csv: csvPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.OPENAI_API_KEY;
  await fs.mkdir(args.outDir, { recursive: true });
  await fs.mkdir(path.dirname(args.cache), { recursive: true });

  const [investmentRows, relevantRows, summaryCache] = await Promise.all([
    readJson(args.investmentSignals, []),
    readJson(args.relevantSignals, []),
    readSummaryCache(args.cache),
  ]);

  const investmentCached = applyCachedSummaries(investmentRows, args, summaryCache);
  const relevantCached = args.summarizeRelevant
    ? applyCachedSummaries(relevantRows, args, summaryCache)
    : { rows: relevantRows, hitCount: 0 };
  const cacheHitCount = investmentCached.hitCount + relevantCached.hitCount;
  const changedStaleCount = [...investmentCached.rows, ...relevantCached.rows].filter(
    (row) => row.ai_summary_cache_status === "miss_changed",
  ).length;

  if (!apiKey) {
    let investmentOutputs = null;
    let relevantOutputs = null;
    const expectedCacheCount = investmentCached.rows.length + (args.summarizeRelevant ? relevantCached.rows.length : 0);
    const completeCacheCoverage = cacheHitCount === expectedCacheCount && changedStaleCount === 0;
    if (completeCacheCoverage) {
      investmentOutputs = await writeOutputs(investmentCached.rows, args.investmentSignals, args.outDir, "investment_signals_ai_summary");
      if (args.summarizeRelevant) {
        relevantOutputs = await writeOutputs(relevantCached.rows, args.relevantSignals, args.outDir, "relevant_signals_ai_summary");
      }
    }
    const summary = {
      run_started_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      status: completeCacheCoverage
        ? "cache_only_complete_missing_openai_api_key"
        : args.optional
          ? "skipped_missing_openai_api_key"
          : "failed_missing_openai_api_key",
      summarize_relevant_signals: args.summarizeRelevant,
      cache_path: args.cache,
      cache_entry_count: Object.keys(summaryCache.entries || {}).length,
      cache_hit_count: cacheHitCount,
      changed_stale_count: changedStaleCount,
      note: completeCacheCoverage
        ? "OPENAI_API_KEY is missing, but every requested row had a complete cache hit."
        : "OPENAI_API_KEY is missing. Latest report inputs were not overwritten because one or more rows lack a current cached validation.",
      outputs: { investment: investmentOutputs, relevant: relevantOutputs },
    };
    await fs.writeFile(path.join(args.outDir, "latest_ai_summary_summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(summary, null, 2));
    if (!completeCacheCoverage && !args.optional) process.exitCode = 1;
    return;
  }

  const investmentUpdated = await summarizeRows(investmentCached.rows, args, apiKey, "investment");
  const relevantUpdated = args.summarizeRelevant
    ? await summarizeRows(relevantCached.rows, args, apiKey, "relevant")
    : relevantCached.rows;
  const allRows = args.summarizeRelevant ? [...investmentUpdated, ...relevantUpdated] : investmentUpdated;
  const cacheUpdate = updateSummaryCache(summaryCache, allRows, args);
  const investmentFailedCount = investmentUpdated.filter((row) => row.ai_summary_quality === "failed").length;
  const relevantFailedCount = args.summarizeRelevant
    ? relevantUpdated.filter((row) => row.ai_summary_quality === "failed").length
    : 0;
  if (investmentFailedCount + relevantFailedCount > 0) {
    await fs.writeFile(args.cache, `${JSON.stringify(cacheUpdate.cache, null, 2)}\n`, "utf8");
    const failedSummary = {
      run_started_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      status: "failed_ai_summaries",
      investment_signal_count: investmentUpdated.length,
      relevant_signal_count: relevantUpdated.length,
      investment_failed_count: investmentFailedCount,
      relevant_failed_count: relevantFailedCount,
      failed_count: investmentFailedCount + relevantFailedCount,
      note: "At least one requested AI validation failed. Latest report inputs were not overwritten.",
      outputs: { investment: null, relevant: null },
    };
    await fs.writeFile(path.join(args.outDir, "latest_ai_summary_summary.json"), `${JSON.stringify(failedSummary, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(failedSummary, null, 2));
    process.exitCode = 1;
    return;
  }
  const investmentOutputs = await writeOutputs(investmentUpdated, args.investmentSignals, args.outDir, "investment_signals_ai_summary");
  const relevantOutputs = args.summarizeRelevant
    ? await writeOutputs(relevantUpdated, args.relevantSignals, args.outDir, "relevant_signals_ai_summary")
    : null;
  await fs.writeFile(args.cache, `${JSON.stringify(cacheUpdate.cache, null, 2)}\n`, "utf8");

  const summary = {
    run_started_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    status: "completed",
    method: "luna_first_terra_retry",
    luna_model: args.lunaModel,
    terra_model: args.terraModel,
    reasoning_effort: args.reasoningEffort,
    max_output_tokens: args.maxOutputTokens,
    retry_max_output_tokens: args.retryMaxOutputTokens,
    summarize_relevant_signals: args.summarizeRelevant,
    cache_path: args.cache,
    cache_entry_count: Object.keys(cacheUpdate.cache.entries || {}).length,
    cache_hit_count: allRows.filter((row) => row.ai_summary_cache_status === "hit").length,
    cache_miss_count: allRows.filter((row) => row.ai_summary_cache_status === "new" || row.ai_summary_cache_status === "failed").length,
    cache_stored_count: cacheUpdate.storedCount,
    investment_signal_count: investmentUpdated.length,
    relevant_signal_count: relevantUpdated.length,
    summarized_count: investmentUpdated.filter((row) => cleanText(row.ai_summary_ko)).length,
    terra_retry_count: investmentUpdated.filter((row) => row.ai_summary_tier === "terra").length,
    investment_failed_count: investmentFailedCount,
    relevant_failed_count: relevantFailedCount,
    failed_count: investmentFailedCount + relevantFailedCount,
    outputs: { investment: investmentOutputs, relevant: relevantOutputs },
  };
  if (summary.failed_count && summary.summarized_count === 0) {
    summary.status = "failed_all_ai_summaries";
    summary.note =
      "Every AI summary request failed, so the workflow must stop instead of publishing untranslated source excerpts as if summarization succeeded.";
  } else if (summary.failed_count) {
    summary.status = "completed_with_ai_summary_failures";
  }
  await fs.writeFile(path.join(args.outDir, "latest_ai_summary_summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));
  if (summary.status === "failed_all_ai_summaries" && args.failOnAllSummaryFailure) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
