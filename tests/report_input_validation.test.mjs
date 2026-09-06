import assert from "node:assert/strict";
import test from "node:test";

import { validateRows } from "../scripts/validate_report_inputs.mjs";

function validRow(overrides = {}) {
  return {
    company: "Example",
    investment_signal_no: 2,
    title: "Example plans a target-technology pilot facility",
    url: "https://example.com/news/pilot",
    ai_summary_ko: "타겟 기술 파일럿 시설 검토",
    ai_summary_en: "Target-technology pilot facility under consideration",
    ai_summary_reason: "기업과 타겟 기술 및 생산 확대 검토가 본문에서 직접 확인됨",
    ai_summary_quality: "pass",
    ai_signal_supported: true,
    ai_entity_supported: true,
    ai_target_technology_supported: true,
    ai_indicator_supported: true,
    ai_leading_indicator_supported: true,
    ai_event_stage: "exploratory",
    ...overrides,
  };
}

test("accepts a fully evidenced leading investment signal", () => {
  assert.deepEqual(validateRows([validRow()], "investment"), []);
});

test("rejects a supported row that needs review", () => {
  assert.ok(validateRows([validRow({ ai_summary_quality: "needs_review" })], "investment").length > 0);
});

test("rejects a supported row whose reason denies target relevance", () => {
  const errors = validateRows(
    [validRow({ ai_summary_reason: "타겟 기술과의 직접적 연관성은 확인되지 않음" })],
    "investment",
  );
  assert.ok(errors.some((error) => error.includes("reason denies direct relevance")));
});

test("rejects completed investments from the leading-signal report", () => {
  const errors = validateRows([validRow({ ai_event_stage: "completed" })], "investment");
  assert.ok(errors.some((error) => error.includes("non-leading event stage completed")));
});

test("allows an unsupported row to remain for dashboard review", () => {
  const row = validRow({
    ai_signal_supported: false,
    ai_target_technology_supported: false,
    ai_summary_quality: "needs_review",
    ai_event_stage: "unclear",
  });
  assert.deepEqual(validateRows([row], "investment"), []);
});


test("precursor stages are restricted to enabling activities and unknown stages fail closed", () => {
  for (const no of [1,3,4,5]) assert.deepEqual(validateRows([validRow({ investment_signal_no: no, ai_event_stage: "precursor" })], "investment"), []);
  for (const stage of ["precursor", "not_applicable", "unknown", "committed"])
    assert.ok(validateRows([validRow({ ai_event_stage: stage })], "investment").length > 0);
});
