import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { groupArticles, importReview, inPeriod, monthPeriod, sourceCandidates } from "../scripts/local_report.mjs";

const period = monthPeriod("2026-08");
const source = {
  target_no: 1, company: "Example", title: "Example plans a pilot",
  url: "https://example.com/pilot", published_at: "2026-08-10T00:00:00Z",
  target_technology: "target material", investment_signal_no: 2,
  content_text: "Example is considering a new pilot plant for its target material.",
};
const article = () => groupArticles([source], [], period)[0];
const decision = (overrides = {}) => ({
  candidate_id: "investment:2", entity_supported: true, target_technology_supported: true,
  indicator_supported: true, leading_indicator_supported: true, event_stage: "planned", quality: "pass",
  reason_ko: "타겟 소재의 생산시설 검토가 본문에 명시됨", evidence_quotes: [source.content_text],
  summary_ko: "타겟 소재 파일럿 시설 검토", summary_en: "Target-material pilot plant under consideration", ...overrides,
});
const review = (a, decisions = [decision()]) => ({ article_id: a.id, reviewer: "test", decisions });

test("month filtering matches UTC boundaries, leap years, and unknown dates", () => {
  assert.equal(monthPeriod("2024-02").to_date, "2024-02-29");
  assert.throws(() => monthPeriod("2026-13"));
  assert.equal(inPeriod({ published_at: "2026-09-01T08:59:59+09:00" }, period), true);
  assert.equal(inPeriod({ published_at: "2026-09-01T09:00:00+09:00" }, period), false);
  assert.equal(inPeriod({ published_at: "2026-08-01T00:00:00" }, period), true);
  assert.equal(inPeriod({ published_at: null }, period), false);
  assert.equal(inPeriod({ published_at: "invalid" }, period), false);
});

test("groups indicators for one company/article, preserves distinct companies and filters before review", () => {
  const groups = groupArticles([source, { ...source, investment_signal_no: 4 },
    { ...source, company: "Subsidiary", target_no: 2 }, { ...source, published_at: null }], [source], period);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].candidates.length, 3);
  assert.equal(groups[0].evidence.filter((text) => text === source.content_text).length, 1);
  assert.throws(() => groupArticles([source, source], [], period), /Duplicate candidate/);
});

test("review identity ignores old AI prose and crawl timestamps but changes with evidence and policy", () => {
  const original = article().id;
  assert.equal(groupArticles([{ ...source, ai_signal_supported: false, collected_at: "later" }], [], period)[0].id, original);
  assert.notEqual(groupArticles([{ ...source, content_text: "Different evidence" }], [], period)[0].id, original);
  assert.notEqual(groupArticles([source], [], period, "changed-policy")[0].id, original);
  assert.notEqual(groupArticles([{ ...source, target_technology: "different" }], [], period)[0].id, original);
});

test("rejects missing, duplicated, stale and ungrounded reviews", () => {
  const a = article();
  assert.throws(() => importReview(a, review(a, [])), /every candidate/);
  assert.throws(() => importReview(a, { ...review(a), article_id: "old" }), /stale/);
  assert.throws(() => importReview(a, review(a, [decision({ candidate_id: "unknown" })])), /unknown/);
  assert.throws(() => importReview(a, review(a, [decision({ evidence_quotes: ["Invented investment"] })])), /exact passages/);
  assert.throws(() => importReview(a, review(a, [decision({ evidence_quotes: [] })])), /needs an evidence quote/);
  assert.throws(() => importReview(a, review(a, [decision({ entity_supported: "true" })])), /missing boolean/);
  assert.throws(() => importReview(a, review(a, [decision({ event_stage: "not_applicable" })])), /invalid event_stage/);
  const multi = groupArticles([source, { ...source, investment_signal_no: 4 }], [], period)[0];
  assert.throws(() => importReview(multi, review(multi, [decision(), decision()])), /duplicate/);
});

test("only supported decisions need bilingual prose; rejection does not become a report row", () => {
  const a = article();
  assert.throws(() => importReview(a, review(a, [decision({ summary_en: "" })])), /missing ai_summary_en/);
  assert.throws(() => importReview(a, review(a, [decision({ reason_ko: "no direct evidence" })])), /denies direct relevance/);
  for (const overrides of [{ quality: "needs_review" }, { event_stage: "completed" }, { entity_supported: false }]) {
    const result = importReview(a, review(a, [decision({ ...overrides, summary_ko: "", summary_en: "" })]))[0];
    assert.equal(result.supported, false);
    assert.equal(result.row, null);
  }
  assert.equal(importReview(a, review(a))[0].row.ai_summary_source, "local_agent_review");
});

test("relevance exemption never bypasses entity or leading-event requirements", () => {
  const a = groupArticles([{ ...source, excluded_from_relevance: true }], [], period)[0];
  assert.equal(importReview(a, review(a, [decision({ target_technology_supported: false })]))[0].supported, true);
  assert.equal(importReview(a, review(a, [decision({ target_technology_supported: false, entity_supported: false })]))[0].supported, false);
  assert.equal(importReview(a, review(a, [decision({ event_stage: "committed" })]))[0].supported, false);
});

test("CLI prepares isolated files and refuses incomplete builds without changing source data", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "local-report-"));
  const dataDir = path.join(temp, "data"), outDir = path.join(temp, "runs");
  const cli = (args) => spawnSync(process.execPath, ["scripts/local_report.mjs", ...args], { encoding: "utf8" });
  try {
    await fs.mkdir(dataDir);
    const inputs = {
      "latest_collection_summary.json": period,
      "latest_company_signals.json": [{ ...source, company: "Australian Strategic Metals" }],
    };
    for (const [name, value] of Object.entries(inputs)) await fs.writeFile(path.join(dataDir, name), JSON.stringify(value));
    const args = ["prepare", "--data-dir", dataDir, "--out-dir", outDir, "--month", "2026-08"];
    const prepared = cli(args);
    assert.equal(prepared.status, 0, prepared.stderr);
    const runName = (await fs.readdir(outDir)).find((name) => name.startsWith("2026-08-"));
    const runDir = path.join(outDir, runName);
    const blocked = cli(["build", "--run-dir", runDir]);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /1 pending articles/);
    assert.equal((await fs.readdir(runDir)).some((name) => name.startsWith("report-")), false);
    assert.equal(cli([...args.slice(0, -1), "2026-09"]).status, 1);
    assert.equal(cli(args).status, 0);
    const snapshot = JSON.parse(await fs.readFile(path.join(runDir, "snapshot.json"), "utf8"));
    const preparedArticle = snapshot.articles[0];
    const reviewFile = path.join(outDir, "reviews", `${preparedArticle.id}.json`);
    const reviewed = JSON.stringify(review(preparedArticle, preparedArticle.candidates.map((candidate) => decision({
      candidate_id: candidate.id, indicator_supported: candidate.kind === "relevant",
      leading_indicator_supported: candidate.kind === "relevant", event_stage: candidate.kind === "relevant" ? "not_applicable" : "unclear",
      entity_supported: false,
    }))));
    await fs.writeFile(reviewFile, reviewed);
    assert.equal(cli(["status", "--run-dir", runDir]).status, 0);
    assert.equal(cli(args).status, 0);
    assert.equal(await fs.readFile(reviewFile, "utf8"), reviewed, "prepare must preserve completed reviews");
    const previous = path.join(runDir, "report-previous");
    await fs.mkdir(previous);
    await fs.writeFile(path.join(previous, "report_ko.pdf"), "previous report bytes");
    const failed = cli(["build", "--run-dir", runDir, "--python", path.join(temp, "missing-python")]);
    assert.equal(failed.status, 1);
    assert.equal(await fs.readFile(path.join(previous, "report_ko.pdf"), "utf8"), "previous report bytes");
    assert.deepEqual((await fs.readdir(runDir)).filter((name) => name.startsWith("report-")), ["report-previous"]);
    snapshot.signals = [];
    await fs.writeFile(path.join(runDir, "snapshot.json"), JSON.stringify(snapshot));
    const modified = cli(["build", "--run-dir", runDir]);
    assert.equal(modified.status, 1);
    assert.match(modified.stderr, /snapshot was modified/);
    for (const [name, value] of Object.entries(inputs)) assert.equal(await fs.readFile(path.join(dataDir, name), "utf8"), JSON.stringify(value));
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});


test("raw source review includes keyword misses and technology rejects for all five indicators", () => {
  const technology = { companies: [{ company: source.company, target_no: 1, target_technology: "target", excluded_from_relevance: false }] };
  const indicators = { indicators: [1,2,3,4,5].map((no) => ({no, label_ko: `S${no}`})) };
  const candidates = sourceCandidates([{ ...source, passed: false }], technology, indicators, period);
  assert.equal(candidates.investment.length, 5);
  assert.equal(candidates.relevant.length, 1);
  assert.equal(candidates.investment[4].investment_signal_no, 5);
  assert.equal(candidates.investment[0].technology_gate_decision, "agent_review");
  assert.throws(() => sourceCandidates([source], { companies: [] }, indicators, period), /Missing target/);
});

test("confirmed research precursor is accepted but cannot turn completed factories into signals", () => {
  const a = groupArticles([{ ...source, investment_signal_no: 4 }], [], period)[0];
  assert.equal(importReview(a, review(a, [decision({candidate_id: "investment:4", event_stage: "precursor"})]))[0].supported, true);
  assert.equal(importReview(article(), review(article(), [decision({event_stage: "precursor"})]))[0].supported, false);
});


test("technology-exempt business rows still require concrete activity", () => {
  const a = groupArticles([], [{...source, excluded_from_relevance:true}], period)[0];
  const result = importReview(a, review(a, [decision({candidate_id:"relevant", event_stage:"not_applicable", target_technology_supported:false, indicator_supported:false, evidence_quotes:[]})]));
  assert.equal(result[0].supported, false);
});
