#!/usr/bin/env node
// Local product path: collect/prepare -> agent-authored reviews -> existing PDF renderer.
// This script never calls a model API or changes outputs/latest_*.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateRows, investmentStageSupported } from "./validate_report_inputs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const POLICY_VERSION = "local-report-v2";
const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
const read = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const write = async (file, value) => fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);

export function monthPeriod(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || "")) throw new Error("Use --month YYYY-MM");
  const start = `${month}-01`;
  const next = new Date(`${start}T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return { from_date: start, to_date: new Date(next.getTime() - 86400000).toISOString().slice(0, 10) };
}

export function inPeriod(row, period) {
  if (!row.published_at) return false;
  // The PDF renderer interprets timestamps without an offset as UTC.
  let date = String(row.published_at).trim();
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(date)) date += "Z";
  const time = Date.parse(date);
  return Number.isFinite(time) && time >= Date.parse(`${period.from_date}T00:00:00Z`) &&
    time < Date.parse(`${period.to_date}T00:00:00Z`) + 86400000;
}

function withoutAI(row) {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith("ai_")));
}

export function groupArticles(investment, relevant, period, policy = POLICY_VERSION) {
  const groups = new Map();
  for (const [kind, rows] of [["investment", investment], ["relevant", relevant]]) {
    for (const original of rows) {
      if (!inPeriod(original, period)) continue;
      const row = withoutAI(original);
      const key = JSON.stringify([row.target_no, row.company, row.url || row.title]);
      if (!groups.has(key)) groups.set(key, {
        company: row.company, target_no: row.target_no, url: row.url, title: row.title,
        published_at: row.published_at, source: row.source, source_type: row.source_type,
        evidence: [], candidates: [],
      });
      const article = groups.get(key);
      for (const text of [row.title, row.content_text, row.content_excerpt,
        ...(row.evidence_snippets || []), ...(row.technology_evidence_snippets || [])]) {
        if (clean(text) && !article.evidence.includes(clean(text))) article.evidence.push(clean(text));
      }
      const candidate = {
        id: kind === "investment" ? `investment:${row.investment_signal_no}` : "relevant",
        kind,
        target_technology: row.target_technology || "",
        relevance_exempt: row.excluded_from_relevance === true || row.technology_gate_decision === "relevance_exempt",
        indicator: row.investment_signal_label || "품목 연계 사업동향",
        description: row.investment_signal_description || "타겟 품목·기술과 직접 연계된 사업 활동",
      };
      if (article.candidates.some((item) => item.id === candidate.id)) {
        throw new Error(`Duplicate candidate: ${row.company} ${row.url} ${candidate.id}`);
      }
      article.candidates.push({ ...candidate, row });
    }
  }
  return [...groups.values()].map((article) => {
    article.evidence.sort();
    article.candidates.sort((a, b) => a.id.localeCompare(b.id));
    const material = { ...article, policy, candidates: article.candidates.map(({ row, ...item }) => item) };
    return { ...material, id: hash(material), candidates: article.candidates };
  });
}

// Every in-month source reaches the agent, including keyword/technology filter misses.
export function sourceCandidates(signals, technology, indicators, period) {
  const investment = [], relevant = [], seen = new Set();
  for (const signal of signals) {
    if (!inPeriod(signal, period)) continue;
    const key = JSON.stringify([signal.target_no, signal.company, signal.url || signal.title]);
    if (seen.has(key)) throw new Error(`Duplicate source article: ${signal.company} ${signal.url}`);
    seen.add(key);
    const tech = technology.companies.find((item) => item.company === signal.company && item.target_no === signal.target_no);
    if (!tech) throw new Error(`Missing target technology: ${signal.company}`);
    const row = { ...withoutAI(signal), ...tech, company: signal.company,
      technology_gate_decision: tech.excluded_from_relevance ? "relevance_exempt" : "agent_review",
      candidate_origin: "all_month_sources" };
    relevant.push(row);
    for (const indicator of indicators.indicators) investment.push({ ...row,
      investment_signal_no: indicator.no, investment_signal_id: indicator.id,
      investment_signal_label: indicator.label_ko, investment_signal_label_en: indicator.label_en,
      investment_signal_description: indicator.description_ko,
    });
  }
  return { investment, relevant };
}

const BOOLEANS = ["entity_supported", "target_technology_supported", "indicator_supported", "leading_indicator_supported"];

// Checks the review import boundary, then delegates report-row consistency to the existing validator.
// A quote match proves provenance only, not the truth of a model's interpretation.
export function importReview(article, review) {
  if (review.article_id !== article.id) throw new Error(`${article.company}: stale or mismatched article_id`);
  if (!clean(review.reviewer)) throw new Error(`${article.company}: reviewer is required`);
  if (!Array.isArray(review.decisions) || review.decisions.length !== article.candidates.length) {
    throw new Error(`${article.company}: review must cover every candidate exactly once`);
  }
  const seen = new Set();
  const evidence = article.evidence.map(clean);
  return review.decisions.map((decision) => {
    const candidate = article.candidates.find((item) => item.id === decision.candidate_id);
    if (!candidate || seen.has(decision.candidate_id)) throw new Error(`${article.company}: unknown or duplicate candidate_id`);
    seen.add(decision.candidate_id);
    const context = `${article.company} ${candidate.id}`;
    for (const field of BOOLEANS) {
      if (typeof decision[field] !== "boolean") throw new Error(`${context}: missing boolean ${field}`);
    }
    const stages = candidate.kind === "relevant" ? ["not_applicable"] : ["exploratory", "planned", "precursor", "committed", "completed", "unclear"];
    if (!stages.includes(decision.event_stage)) throw new Error(`${context}: invalid event_stage`);
    if (!["pass", "needs_review"].includes(decision.quality)) throw new Error(`${context}: invalid quality`);
    if (!clean(decision.reason_ko)) throw new Error(`${context}: reason_ko is required`);
    if (candidate.kind === "relevant" && !decision.leading_indicator_supported) {
      throw new Error(`${context}: business rows use true for the non-applicable leading indicator field`);
    }
    const supported = decision.entity_supported && (candidate.relevance_exempt || decision.target_technology_supported) &&
      decision.indicator_supported && decision.leading_indicator_supported && decision.quality === "pass" &&
      (candidate.kind === "relevant" || investmentStageSupported(decision.event_stage, candidate.row.investment_signal_no));
    const quotes = decision.evidence_quotes;
    if (!Array.isArray(quotes) || quotes.some((quote) => !clean(quote) || !evidence.some((text) => text.includes(clean(quote))))) {
      throw new Error(`${context}: evidence_quotes must be exact passages from this article`);
    }
    if (supported && !quotes.length) throw new Error(`${context}: approved candidate needs an evidence quote`);
    let row = null;
    if (supported) {
      row = {
        ...candidate.row,
        ai_signal_supported: true,
        ...Object.fromEntries(BOOLEANS.map((field) => [`ai_${field}`, decision[field]])),
        ai_event_stage: decision.event_stage, ai_summary_quality: decision.quality,
        ai_summary_reason: clean(decision.reason_ko),
        ai_summary_ko: clean(decision.summary_ko), ai_summary_en: clean(decision.summary_en),
        ai_summary_source: "local_agent_review", ai_summary_reviewer: review.reviewer,
        ai_summary_cache_key: article.id, ai_evidence_quotes: quotes,
      };
      const errors = validateRows([row], candidate.kind);
      if (errors.length) throw new Error(errors.join("\n"));
    }
    return { candidate_id: candidate.id, kind: candidate.kind, supported, row, reason_ko: decision.reason_ko };
  });
}

function execute(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`);
}

async function collect(month, outDir) {
  const period = monthPeriod(month);
  const dataDir = await fs.mkdtemp(path.join(outDir, "collection-"));
  execute(process.execPath, ["scripts/collect_company_signals.mjs", "--companies", "data/target_companies.json",
    "--source-config", "config/company_sources.json", "--out-dir", dataDir,
    "--sources", "official_feeds,official_pages,google_news", "--from-date", period.from_date, "--to-date", period.to_date,
    "--max-per-source", "6", "--max-per-company", "10", "--max-detail-per-company", "10",
    "--fallback-mode", "missing", "--fallback-min-results", "1", "--rate-limit-seconds", "0.5", "--company-concurrency", "4"]);
  return dataDir;
}

async function prepare(args) {
  const outDir = path.resolve(args.outDir || "outputs/local_reports");
  await fs.mkdir(outDir, { recursive: true });
  const dataDir = args.collect ? await collect(args.month, outDir) : path.resolve(args.dataDir || "outputs");
  const [summary, signals, targets, technology, indicators, policyText] = await Promise.all([
    read(path.join(dataDir, "latest_collection_summary.json")), read(path.join(dataDir, "latest_company_signals.json")),
    read(path.join(ROOT, "data/target_companies.json")), read(path.join(ROOT, "data/company_technology_map.json")),
    read(path.join(ROOT, "config/investment_signal_indicators.json")), fs.readFile(path.join(ROOT, "docs/local_report_review.md"), "utf8"),
  ]);
  const month = args.month || summary.from_date?.slice(0, 7);
  const period = monthPeriod(month);
  if (summary.from_date !== period.from_date || summary.to_date !== period.to_date) {
    throw new Error(`Collection period does not cover exactly ${month}. Use prepare --month ${month} --collect for fresh data.`);
  }
  const policy = `${POLICY_VERSION}:${hash([policyText, indicators, technology])}`;
  const candidates = sourceCandidates(signals, technology, indicators, period);
  const articles = groupArticles(candidates.investment, candidates.relevant, period, policy);
  const snapshot = { policy, period, summary, signals: signals.map(withoutAI), articles, targets, technology, indicators };
  const runDir = path.join(outDir, `${month}-${hash(snapshot)}`);
  await fs.mkdir(path.join(runDir, "articles"), { recursive: true });
  await fs.mkdir(path.join(outDir, "reviews"), { recursive: true });
  // Immutable snapshot: a repeated prepare may repair identical article files but cannot replace a different run.
  await fs.writeFile(path.join(runDir, "snapshot.json"), `${JSON.stringify(snapshot, null, 2)}\n`, { flag: "wx" })
    .catch(async (error) => {
      if (error.code !== "EEXIST") throw error;
      await loadSnapshot(runDir);
    });
  for (const article of articles) {
    await write(path.join(runDir, "articles", `${article.id}.json`), {
      ...article, candidates: article.candidates.map(({ row, ...candidate }) => candidate),
    });
  }
  await fs.writeFile(path.join(runDir, "REVIEW.md"), policyText);
  console.log(JSON.stringify({ run_dir: runDir, review_dir: path.join(outDir, "reviews"),
    collection_rows: signals.length, excluded_from_month: signals.length - articles.length,
    candidate_rows: articles.reduce((n, article) => n + article.candidates.length, 0), articles: articles.length }, null, 2));
  await status(runDir);
}

async function loadSnapshot(runDir) {
  const snapshot = await read(path.join(runDir, "snapshot.json"));
  const expected = `${snapshot.period.from_date.slice(0, 7)}-${hash(snapshot)}`;
  if (path.basename(runDir) !== expected) {
    throw new Error("Prepared snapshot was modified. Prepare the source again with a different --out-dir.");
  }
  return snapshot;
}

async function loadReviews(runDir) {
  const snapshot = await loadSnapshot(runDir);
  const pending = [], invalid = [], results = [], reviews = [];
  for (const article of snapshot.articles) {
    const file = path.join(path.dirname(runDir), "reviews", `${article.id}.json`);
    try {
      const review = await read(file);
      results.push(...importReview(article, review).map((result) => ({ ...result, article_id: article.id, company: article.company })));
      reviews.push(review);
    } catch (error) {
      if (error.code === "ENOENT") pending.push({ company: article.company, article_id: article.id, file });
      else invalid.push({ company: article.company, article_id: article.id, error: error.message });
    }
  }
  return { snapshot, pending, invalid, results, reviews };
}

async function status(runDir) {
  const { snapshot, pending, invalid, results } = await loadReviews(runDir);
  console.log(JSON.stringify({ articles: snapshot.articles.length, reviewed_articles: snapshot.articles.length - pending.length - invalid.length,
    approved_candidates: results.filter((row) => row.supported).length, pending, invalid }, null, 2));
  return pending.length === 0 && invalid.length === 0;
}

async function build(args) {
  const runDir = path.resolve(args.runDir);
  const { snapshot, pending, invalid, results, reviews } = await loadReviews(runDir);
  if (pending.length || invalid.length) {
    throw new Error(`Report blocked: ${pending.length} pending articles, ${invalid.length} invalid reviews. Run status --run-dir ${runDir}`);
  }
  const investment = results.filter((item) => item.supported && item.kind === "investment").map((item) => item.row);
  const relevant = results.filter((item) => item.supported && item.kind === "relevant").map((item) => item.row);
  const errors = [...validateRows(investment, "investment"), ...validateRows(relevant, "relevant")];
  if (errors.length) throw new Error(errors.join("\n"));
  // A failed build never overwrites an earlier PDF, either here or in public/reports.
  const buildDir = await fs.mkdtemp(path.join(runDir, "report-"));
  try {
    const reviewByArticle = new Map(reviews.map((review) => [review.article_id, review]));
    const coverage = snapshot.targets.map((target) => {
      const articles = snapshot.articles.filter((article) => article.company === target.company);
      const incomplete = articles.filter((article) => reviewByArticle.get(article.id).decisions.some((d) => d.quality === "needs_review"));
      return { company: target.company, monthly_articles: articles.length,
        needs_review_articles: incomplete.length,
        status: !articles.length ? "no_monthly_sources" : incomplete.length ? "incomplete_evidence" : "reviewed",
        follow_up: incomplete.map((article) => ({ url: article.url, title: article.title })) };
    });
    const files = {
      "signals.json": snapshot.signals, "summary.json": { ...snapshot.summary, review_coverage: coverage },
      "coverage.json": coverage,
      "investment.json": investment, "relevant.json": relevant,
      "investment-summary.json": { investment_signal_count: investment.length },
      "targets.json": snapshot.targets, "technology.json": snapshot.technology, "indicators.json": snapshot.indicators,
      "reviews.json": reviews,
      "decisions.json": results.map(({ row, ...item }) => item),
    };
    for (const [name, value] of Object.entries(files)) await write(path.join(buildDir, name), value);
    for (const lang of ["ko", "en"]) {
      execute(args.python || process.env.PYTHON || "python3", [path.join(ROOT, "scripts/build_pdf_report.py"),
        "--signals", path.join(buildDir, "signals.json"), "--summary", path.join(buildDir, "summary.json"),
        "--relevant", path.join(buildDir, "relevant.json"), "--investment-signals", path.join(buildDir, "investment.json"),
        "--investment-summary", path.join(buildDir, "investment-summary.json"),
        "--targets", path.join(buildDir, "targets.json"), "--technology-map", path.join(buildDir, "technology.json"),
        "--indicator-config", path.join(buildDir, "indicators.json"), "--font", path.join(ROOT, "assets/fonts/NOTOSANSKR-VF.TTF"),
        "--issue-number", args.issueNumber || "2", "--lang", lang, "--out", path.join(buildDir, `report_${lang}.pdf`)]);
    }
    console.log(JSON.stringify({ status: "completed", report_dir: buildDir, reviewed_articles: reviews.length,
      reviewed_candidates: results.length, approved_investment: investment.length, approved_business: relevant.length,
      incomplete_companies: coverage.filter((item) => item.status !== "reviewed").length,
      rejected_candidates: results.filter((item) => !item.supported).length }, null, 2));
  } catch (error) {
    await fs.rm(buildDir, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const args = {};
  const options = new Set(["month", "data-dir", "out-dir", "run-dir", "python", "issue-number"]);
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, "");
    if (argv[i] === "--collect") { args.collect = true; continue; }
    if (!argv[i].startsWith("--") || !options.has(key) || !argv[i + 1] || argv[i + 1].startsWith("--")) {
      throw new Error(`Invalid option: ${argv[i]}`);
    }
    args[key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = argv[++i];
  }
  if (command === "prepare") await prepare(args);
  else if (command === "status" && args.runDir) { if (!await status(path.resolve(args.runDir))) process.exitCode = 1; }
  else if (command === "build" && args.runDir) await build(args);
  else throw new Error("Usage: local_report.mjs prepare [--month YYYY-MM] [--collect] | status --run-dir PATH | build --run-dir PATH [--python PATH]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
