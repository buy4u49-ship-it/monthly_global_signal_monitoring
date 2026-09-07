# Company Signal Collector

Collect public news, press releases, and IR material for 77 target companies, classify investment signals, verify report evidence with AI, and publish Korean/English PDF reports plus a dashboard.

## Files

- `data/target_companies.json`: canonical 77-company target list from PDF page 2.
- `data/target_companies.csv`: spreadsheet-friendly version of the same list.
- `data/company_technology_map.json`: 77-company target technology mapping from the reference PDF.
- `data/company_technology_map.csv`: spreadsheet-friendly version of the technology mapping.
- `config/company_sources.json`: official Newsroom/Press/IR source catalog by company.
- `config/technology_keywords.json`: broad Korean/English synonym keyword catalog for relevance filtering.
- `.github/workflows/collect-company-signals.yml`: manual GitHub Actions workflow for on-demand collection.
- `app/`: Vercel dashboard and API routes for the `크롤링 수행` button.
- `scripts/extract_pdf_companies.py`: validates PDF page 2 against the canonical list.
- `scripts/build_company_technology_map.py`: extracts and normalizes company-to-technology mapping from the reference PDF.
- `scripts/collect_company_signals.mjs`: collects signals from official feeds, Google News RSS, and GDELT without third-party packages.
- `scripts/filter_relevant_signals.mjs`: filters collected signals to target-technology-related items.
- `scripts/classify_investment_signals.mjs`: finds five investment-signal candidates with deterministic keyword rules.
- `scripts/summarize_signal_evidence.mjs`: summarizes evidence and performs the semantic support decision used by reports.
- `scripts/validate_report_inputs.mjs`: rejects incomplete or contradictory AI decisions before report publication.
- `scripts/build_pdf_report.py`: builds the Korean or English PDF after validation.
- `scripts/collect_company_signals.py`: Python equivalent; use it only when the local Python SSL stack supports outbound HTTPS.
- `outputs/`: generated JSON/CSV results.

See `docs/github_vercel_button_workflow.md` for the GitHub upload, Vercel deployment, and button-trigger workflow.
The implemented accuracy controls, verification evidence, known limitations, and Codex hook diagnosis are recorded in `docs/signal_accuracy_improvements_2026-09-03.md`.

## Commands

### Local monthly report without model API calls

Ask Codex in this project to create a monthly report using
[`docs/local_report_review.md`](docs/local_report_review.md). Codex reads the article
files and saves reviews directly; no chat-to-JSON copy/paste is needed. Included
subscription usage limits still apply. The scripts themselves never call a model API.

```bash
# Reuse the checked-in August 2026 collection (does not crawl or call a model).
npm run report:local -- prepare --month 2026-08

# For a new collection, add --collect. All output stays in a separate local directory.
npm run report:local -- prepare --month 2026-08 --collect

# Use the run_dir printed by prepare. Codex writes the pending article reviews.
npm run report:local -- status --run-dir RUN_DIR
npm run report:local -- build --run-dir RUN_DIR --python python3
```

Preparation filters the report month before review and groups candidates by target
company and article. Reviews are reused only for matching evidence and policy.
All candidates need decisions; only approved rows need bilingual report prose.
Build rejects missing, stale, contradictory, or ungrounded approvals and reuses
the existing report validator and Python PDF renderer. Install
`requirements-python.txt` in the selected Python environment before building.
Each successful build produces Korean/English PDFs and a complete decision log in
a new `outputs/local_reports/.../report-*` folder. Existing dashboard outputs and
published PDFs are not overwritten. A Codex task must perform the review step;
`prepare` alone does not generate AI decisions.

Validate that the PDF page 2 list matches `data/target_companies.json`:

```bash
python scripts/extract_pdf_companies.py --pdf "C:/Users/buy4u/Desktop/KOTRA/AX 과제/Invest_KOREA_기업 글로벌 시그널_2.pdf" --page 2 --expected data/target_companies.json --out-dir outputs
```

Run a full 77-company collection test with Node.js and no package install:

```bash
node --use-system-ca scripts/collect_company_signals.mjs --companies data/target_companies.json --source-config config/company_sources.json --out-dir outputs --sources official_feeds,official_pages,google_news --days 45 --max-per-source 3 --max-per-company 4 --fallback-mode missing --fallback-min-results 1 --rate-limit-seconds 0.5
```

Official RSS/Atom feeds and official Newsroom/Press/IR pages are read first. Google News is used only when a company has no official result in the run. GDELT is also implemented as `gdelt`, but its public endpoint can return rate-limit responses unless requests are spaced at roughly 5 seconds or more.

Build the company-to-technology mapping from the reference PDF:

```bash
python scripts/build_company_technology_map.py --pdf "C:/Users/buy4u/Downloads/전체 기업 정보_참고용_최종.pdf" --targets data/target_companies.json --keywords config/technology_keywords.json --out-json data/company_technology_map.json --out-csv data/company_technology_map.csv
```

Filter the latest collected signals to only target-technology-related candidates:

```bash
node scripts/filter_relevant_signals.mjs --signals outputs/latest_company_signals.json --technology-map data/company_technology_map.json --keyword-config config/technology_keywords.json --out-dir outputs --threshold 1
```

The relevance filter uses broad Korean/English synonyms and excludes these companies from relevance analysis by request: `Prodrive`, `JSR`, `Applied Materials`, `Amkor Technology`, `Heraeus`, `Toray`, `3M`, `Air Liquide`, `Air Products`.

Classify five investment-signal candidates:

```bash
node scripts/classify_investment_signals.mjs --signals outputs/latest_company_signals.json --technology-classification outputs/latest_signal_relevance_classification.json --indicator-config config/investment_signal_indicators.json --out-dir outputs --threshold 4 --require-technology-relevance true
```

Generate bilingual AI summaries and semantic support decisions for report evidence:

```bash
OPENAI_API_KEY=... node scripts/summarize_signal_evidence.mjs --investment-signals outputs/latest_investment_signals.json --relevant-signals outputs/latest_relevant_signals.json --out-dir outputs
```

The summarizer uses a two-step strategy: Luna model first, then Terra model only for summaries that look too short, too English-heavy, or low-confidence. It evaluates entity attribution, target-technology relevance, concrete indicator evidence, leading-indicator timing, and event stage separately. `ai_signal_supported` is true only when every required dimension is true. By default, it summarizes the report-facing rows only: captured investment-signal candidates and technology-relevant candidates for the global business status box. It does not summarize every collected item. Reusable decisions are stored in `outputs/ai_summary_cache.json`; a changed evidence fingerprint or prompt version forces reevaluation. Configure model names with `AI_SUMMARY_LUNA_MODEL` and `AI_SUMMARY_TERRA_MODEL`. In GitHub Actions, store the API key as the repository secret `OPENAI_API_KEY`; do not commit API keys. That secret currently holds the NVIDIA build key used by the article review step, so this OpenAI path cannot run against it.

The report path is fail-closed. If the API key is missing and a required decision is not already cached, or if any requested AI evaluation fails, the summarizer exits unsuccessfully without overwriting the last report inputs. The workflow then validates all decisions before building either PDF:

```bash
node scripts/validate_report_inputs.mjs
```

Manual workflow runs use the previous completed calendar month when `from_date` and `to_date` are blank. Supplying only one date, an invalid date, or a reversed range stops the run.

## Output Schema

Each collected row is normalized to:

- `target_no`
- `company`
- `title`
- `url`
- `source`
- `published_at`
- `collected_at`
- `collector`
- `query`
- `source_type`
- `source_priority`
- `official_source_url`

`latest_company_signals.json` and `latest_company_signals.csv` are overwritten on each run for easy dashboard/API consumption.

The relevance filter also writes:

- `latest_relevant_signals.json`
- `latest_relevant_signals.csv`
- `latest_signal_relevance_classification.json`
- `latest_relevance_summary.json`

Each relevant row includes `target_technology`, `target_technology_en`, `technology_group`, `matched_terms`, `relevance_score`, `relevance_decision`, and `relevance_reason`.

AI-evaluated report rows additionally include `ai_entity_supported`, `ai_target_technology_supported`, `ai_indicator_supported`, `ai_leading_indicator_supported`, `ai_event_stage`, `ai_signal_supported`, `ai_summary_quality`, bilingual summaries, and a decision reason. Older cached rows that lack these fields are invalid report inputs and must be regenerated.

## Vercel

This repository now contains a minimal Next.js app, so Vercel should detect it as a Next.js project. If Vercel previously detected the repository as Python, redeploy after committing the new `package.json`, `app/`, and removed root `requirements.txt`.


### Signal review policy (September 2026 correction)

Local preparation now includes **every dated source article in the requested month**, even if the technology or indicator keyword filters rejected it. Each article is checked against all five indicators and the business-activity criteria. This increases review coverage; it does not approve a keyword match automatically.

`ai_event_stage=precursor` denotes a verified enabling activity under indicators 1, 3, 4 or 5 (supply-chain action, investment financing, specific R&D collaboration or strategic personnel activity). Its announcement may be complete while a final investment remains unconfirmed. Final committed/completed investment projects remain excluded, and production expansion (indicator 2) cannot use `precursor`. Entity and technology requirements remain in force. The investment API prompt version is bumped to invalidate old decisions; local policy fingerprints also change.

A local build writes `coverage.json` alongside its PDFs. Missing monthly sources and `needs_review` evidence are distinguished from reviewed negative results in the matrix counts. Google News fallback now checks usable monthly evidence **after** official detail/date enrichment. Live collection success still depends on the source sites.

### GitHub Actions로 월간 보고서 실행

`collect-company-signals`는 저장소 시크릿 `OPENAI_API_KEY`(내용은 NVIDIA build 키다)로 기사별 통합 분석과 한·영 PDF 생성을 수행한다. 판정은 NVIDIA build 의 OpenAI 호환 엔드포인트로 보내며 모델은 `NVIDIA_MODEL`로 바꾼다. 한 번에 최대 400건을 처리하고 한도에 도달하면 진행분을 저장한 뒤 중단하며, 같은 기간으로 재실행하면 이어간다.
