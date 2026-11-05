// Loads the ClubLocker California tournaments page in a headless browser,
// reads the tournament list, and writes tournaments.json for the website.
// If it can't find a list it leaves the old file alone and exits with an error
// so you get a failed-run email instead of a silently empty website.

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { findTournaments, cleanUp, datesFromText } from './extract.mjs';

const PAGE_URL = process.env.TEST_URL ||
  'https://clublocker.com/organizations/10000/tournaments?ngbId=10000&OrganizerType=1&Sanctioned=1&main=tournaments&Status=1&State=CA';
const OUT = process.env.OUT_FILE || 'tournaments.json';
const DEBUG = 'debug';

async function main(){
  await fs.mkdir(DEBUG, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || undefined,
    args: ['--no-sandbox']
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  const seen = [];
  page.on('response', async res => {
    try {
      // data the page loads in the background (not images, scripts, styles)
      const type = res.request().resourceType();
      const looksJson = (res.headers()['content-type'] || '').includes('json');
      if (type !== 'xhr' && type !== 'fetch' && !looksJson) return;
      const raw = (await res.text()).trim();
      if (raw.length > 5_000_000 || (raw[0] !== '{' && raw[0] !== '[')) return;
      seen.push({ url: res.url(), status: res.status(), body: JSON.parse(raw) });
    } catch { /* not JSON we can read */ }
  });

  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  for (let i = 0; i < 6; i++){                 // scroll so any "load more" lists fill in
    await page.mouse.wheel(0, 2500);
    await page.waitForTimeout(1200);
  }
  await page.waitForTimeout(1500);

  // 1) tournament lists in the data the page downloaded
  let records = [], sawList = false;
  const report = { pageUrl: PAGE_URL, jsonResponses: [] };
  for (const r of seen){
    const f = findTournaments(r.body);
    if (f.sawList){ sawList = true; records.push(...f.records); }
    report.jsonResponses.push({ url: r.url, status: r.status, tournamentLikeRecords: f.records.length });
  }

  // 2) fallback: read tournament links straight off the page
  if (!records.length){
    const rows = await page.evaluate(() => {
      const out = new Map();
      document.querySelectorAll('a[href*="/tournaments/"]').forEach(a => {
        const m = /\/tournaments\/(\d+)/.exec(a.getAttribute('href') || '');
        if (!m || out.has(m[1])) return;
        const box = a.closest('li, tr, article, [class*="card"], [class*="row"], [class*="item"]') || a.parentElement?.parentElement || a;
        out.set(m[1], { id: m[1], name: (a.innerText || '').trim().split('\n')[0], text: box.innerText || '' });
      });
      return [...out.values()];
    });
    for (const r of rows){
      const d = datesFromText(r.text);
      if (r.name && d){
        records.push({ name: r.name, start: d[0], end: d[1], venue: '', city: '', state: '', level: '',
                       url: `https://clublocker.com/tournaments/${r.id}` });
        sawList = true;
      }
    }
    report.domFallbackRows = rows.length;
  }

  const bodyText = await page.evaluate(() => document.body.innerText || '');
  await fs.writeFile(`${DEBUG}/page.txt`, bodyText.slice(0, 20000));
  await page.screenshot({ path: `${DEBUG}/page.png`, fullPage: true }).catch(() => {});
  await browser.close();

  const upcoming = cleanUp(records);
  report.recordsBeforeFilter = records.length;
  report.upcoming = upcoming.length;
  await fs.writeFile(`${DEBUG}/report.json`, JSON.stringify(report, null, 2));

  const noneMessage = /no (upcoming )?tournaments/i.test(bodyText);
  if (!sawList && !noneMessage){
    console.error('Could not find a tournament list on the page. See the "debug" files for what the page returned.');
    process.exit(1);
  }

  let previous = {};
  try { previous = JSON.parse(await fs.readFile(OUT, 'utf8')); } catch { /* first run */ }
  if (JSON.stringify(previous.tournaments || []) === JSON.stringify(upcoming)){
    console.log(`No changes (${upcoming.length} upcoming tournaments).`);
    return;
  }
  await fs.writeFile(OUT, JSON.stringify({
    updated: new Date().toISOString(),
    source: 'ClubLocker (US Squash), California, sanctioned',
    tournaments: upcoming
  }, null, 2) + '\n');
  console.log(`Wrote ${upcoming.length} upcoming tournaments to ${OUT}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href){
  main().catch(err => { console.error(err); process.exit(1); });
}
