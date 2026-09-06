#!/usr/bin/env node
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DEFAULTS = {
  investmentSignals: "outputs/latest_investment_signals.json",
  relevantSignals: "outputs/latest_relevant_signals.json",
};

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) continue;
    const name = key.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    args[name] = argv[index + 1];
    index += 1;
  }
  return args;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function rowId(row, kind, index) {
  return `${kind}[${index}] ${row.company || "?"} S${row.investment_signal_no || "-"} ${row.url || row.title || "?"}`;
}

const REQUIRED_DECISIONS = [
  "ai_signal_supported",
  "ai_entity_supported",
  "ai_target_technology_supported",
  "ai_indicator_supported",
  "ai_leading_indicator_supported",
];

// 분류 단계에서 유치필요 품목(기술) 관련성 검사를 생략한 행.
// 승인 조건으로 타겟 기술 근거를 요구하면 그 면제가 무효가 되므로 여기서도 동일하게 제외한다.
function isRelevanceExempt(row) {
  return row?.excluded_from_relevance === true || row?.technology_gate_decision === "relevance_exempt";
}

const DENIAL_PATTERNS = [
  /직접적? (?:연관성|연계).*(?:확인되지|없음)/i,
  /직접 관련.*(?:근거.*제시되지|확인되지)/i,
  /자체는 언급되지/i,
  /not directly (?:related|linked)/i,
  /no direct (?:evidence|link|connection|relevance)/i,
];

// precursor = verified enabling activity, not a committed final investment project.
export function investmentStageSupported(stage, indicatorNo) {
  return ["exploratory", "planned"].includes(stage) ||
    (stage === "precursor" && [1, 3, 4, 5].includes(Number(indicatorNo)));
}

export function validateRows(rows, kind) {
  const errors = [];
  rows.forEach((row, index) => {
    const id = rowId(row, kind, index);
    for (const field of REQUIRED_DECISIONS) {
      if (typeof row[field] !== "boolean") errors.push(`${id}: missing boolean ${field}`);
    }
    if (!cleanText(row.ai_summary_ko)) errors.push(`${id}: missing ai_summary_ko`);
    if (!cleanText(row.ai_summary_en)) errors.push(`${id}: missing ai_summary_en`);
    if (!cleanText(row.ai_summary_reason)) errors.push(`${id}: missing ai_summary_reason`);
    if (!cleanText(row.ai_event_stage)) errors.push(`${id}: missing ai_event_stage`);

    if (row.ai_signal_supported === true) {
      const targetTechnologyRequired = !isRelevanceExempt(row);
      if (row.ai_summary_quality !== "pass") errors.push(`${id}: supported row is not quality=pass`);
      if (row.ai_entity_supported !== true) errors.push(`${id}: supported row lacks entity evidence`);
      if (targetTechnologyRequired && row.ai_target_technology_supported !== true) {
        errors.push(`${id}: supported row lacks target-technology evidence`);
      }
      if (row.ai_indicator_supported !== true) errors.push(`${id}: supported row lacks indicator evidence`);
      if (row.ai_leading_indicator_supported !== true) errors.push(`${id}: supported row is not a leading indicator`);
      if (targetTechnologyRequired && DENIAL_PATTERNS.some((pattern) => pattern.test(cleanText(row.ai_summary_reason)))) {
        errors.push(`${id}: supported row reason denies direct relevance`);
      }
      if (kind === "investment" && !investmentStageSupported(row.ai_event_stage, row.investment_signal_no)) {
        errors.push(`${id}: supported investment row has non-leading event stage ${row.ai_event_stage}`);
      }
    }
  });
  return errors;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [investmentRows, relevantRows] = await Promise.all([
    readJson(args.investmentSignals),
    readJson(args.relevantSignals),
  ]);
  const errors = [
    ...validateRows(investmentRows, "investment"),
    ...validateRows(relevantRows, "relevant"),
  ];
  const result = {
    status: errors.length ? "failed" : "passed",
    investment_signal_count: investmentRows.length,
    relevant_signal_count: relevantRows.length,
    error_count: errors.length,
    errors: errors.slice(0, 100),
  };
  console.log(JSON.stringify(result, null, 2));
  if (errors.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
