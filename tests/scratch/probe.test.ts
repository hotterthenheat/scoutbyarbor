import { it } from 'vitest';
import { buildAlert, renderAlert, assertNoLeakedMetadata } from '../../src/render/alert.js';

const cases: Array<[string,string,string]> = [
  ['ECONOMIC ALERT', 'US CONSUMER CONFIDENCE: 102.6 VS 100.4 EXPECTED', ''],
  ['ECONOMIC ALERT', 'CONFERENCE BOARD CONSUMER CONFIDENCE INDEX 102.6', ''],
  ['MACRO ALERT', 'FED HOLDS RATES STEADY', 'Summary: the Federal Reserve left rates unchanged.'],
  ['MACRO ALERT', 'TRUMP SAYS DEAL REACHED', 'Source: officials briefed on the matter said talks concluded.'],
  ['MARKET ALERT', 'SENATE VOTES 98/100 TO ADVANCE BILL', ''],
  ['EQUITY ALERT', 'NVDA BEATS **BIG** ON REVENUE', 'Guidance raised.'],
  ['GEOPOLITICAL ALERT', 'REUTERS: US, IRAN REACH AGREEMENT', 'Talks concluded in Geneva.'],
  ['ECONOMIC ALERT', 'UMICH CONSUMER SENTIMENT FINAL 71.8; INFLATION EXPECTATIONS 3.2%', ''],
];

it('probe', () => {
  for (const [banner, headline, body] of cases) {
    const a = buildAlert({ banner, headline, timestampIso: '2026-05-24T17:14:00Z', body });
    const content = renderAlert(a);
    try { assertNoLeakedMetadata(content, ['@DeItaone', 'https://x.com/i/1']); console.log('OK    |', headline, '|', body); }
    catch (e) { console.log('BLOCK |', headline, '|', body, '=>', (e as Error).message); }
  }
  const a = buildAlert({ banner:'EQUITY ALERT', headline:'NVDA BEATS *BIG* ON REVENUE', timestampIso:'2026-05-24T17:14:00Z', body:'Rev $35.1B' });
  console.log(JSON.stringify(renderAlert(a)));
});
