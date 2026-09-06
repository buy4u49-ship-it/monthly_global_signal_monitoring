import assert from 'node:assert/strict';
import test from 'node:test';
import { usableMonthlySource } from '../scripts/collect_company_signals.mjs';

test('fallback requires dated monthly evidence after official detail enrichment', () => {
  const range = {fromMs: Date.parse('2026-08-01'), toMs: Date.parse('2026-09-01') - 1};
  const row = {published_at:'2026-08-20',source_type:'official',content_fetch_status:'fetched',content_text:'Actual article body'};
  assert.equal(usableMonthlySource(row, range), true);
  for (const changed of [{published_at:null},{published_at:'2026-07-31'},{content_fetch_status:'error'},{content_fetch_status:'skipped_non_html'},{content_text:''}])
    assert.equal(usableMonthlySource({...row,...changed}, range), false);
});
