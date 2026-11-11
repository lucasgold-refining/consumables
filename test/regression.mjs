/**
 * Synthetic regression tests for the consumables PWA.
 * Does not read data/import files or any real workshop records.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ART = '/opt/cursor/artifacts';
const KEY = 'refining-consumables-v1';
const failures = [];
let passed = 0;

function assert(cond, msg) {
  if (!cond) {
    failures.push(msg);
    console.error('FAIL', msg);
  } else {
    passed++;
    console.log('PASS', msg);
  }
}
function near(a, b, msg) {
  const ok = Math.abs(Number(a) - Number(b)) < 1e-6;
  assert(ok, ok ? msg : `${msg} (${a} vs ${b})`);
}

const SIZES = [
  ['s1', '#1', 80], ['s2', '#2', 90], ['s3', '#3', 130], ['s4', '#4', 150],
  ['s5', '#5', 200], ['smed', 'Medium', 300], ['s6', 'Jumbo', 330], ['s7', 'XL', 450]
];
function items({ price = null } = {}) {
  return [
    { id: 'nitric', name: 'Nitric acid', unit: 'gallons', decimals: true, threshold: 0, sizes: [], packSize: 7, packName: 'containers', price },
    {
      id: 'crucible', name: 'Crucibles', unit: 'pcs', decimals: false, threshold: 0,
      sizes: SIZES.map(([id, name, p]) => ({ id, name, threshold: 2, archived: false, price: p }))
    },
    { id: 'borax', name: 'Borax', unit: 'kg', decimals: true, threshold: 0, sizes: [], price: null }
  ];
}
function legacyState({ price = null } = {}) {
  return {
    version: 2,
    items: items({ price }),
    entries: [
      { id: 'n-in', type: 'in', itemId: 'nitric', qty: 99, date: '2025-12-01', note: 'hidden stock-in', created: 1 },
      { id: 'n1', type: 'use', itemId: 'nitric', qty: 14, date: '2026-01-02', note: 'synth nitric', batch: 'N-1', grams: null, created: 2 },
      { id: 'n2', type: 'use', itemId: 'nitric', qty: 3.5, date: '2026-01-03', note: '', batch: '', grams: 10, created: 3 },
      { id: 'c-in', type: 'in', itemId: 'crucible', sizeId: 's1', qty: 5, date: '2025-12-01', created: 4 },
      { id: 'c1', type: 'use', itemId: 'crucible', sizeId: 's1', qty: 2, date: '2026-01-04', note: '', batch: 'C-1', grams: null, unitPrice: 80, created: 5 },
      { id: 'b1', type: 'use', itemId: 'borax', qty: 1.5, date: '2026-01-05', note: 'synth borax', created: 6 }
    ],
    paid: [{
      id: 'oldpaid', from: '2025-11-01', to: '2025-11-30', paidOn: '2025-12-01', paidAt: 1, count: 1,
      items: [{ name: 'Nitric acid', unit: 'gallons', decimals: true, used: 7, cost: 0, priced: false, packSize: 7, packName: 'containers' }],
      total: 0
    }],
    silver: [
      { id: 's-in', type: 'in', kg: 10, date: '2026-01-01', note: 'opening', created: 1 },
      { id: 's-use', type: 'use', kg: 4, date: '2026-01-02', note: 'old use', batch: 'B1', created: 2 },
      { id: 's-set', type: 'set', kg: 9.5, date: '2026-01-10', note: 'count', created: 3 },
      { id: 's-use2', type: 'use', kg: 1.25, date: '2026-01-11', note: '', created: 4 }
    ],
    mig: { prices: true, medium: true, stampUse: true, container: true }
  };
}

function startServer() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    let rel = decodeURIComponent(u.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('missing'); }
      res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(data);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function boot(page, base, state) {
  await page.goto(base + '/index.html?nosw=1', { waitUntil: 'domcontentloaded' });
  await page.evaluate((key, s) => {
    localStorage.clear();
    if (s) localStorage.setItem(key, JSON.stringify(s));
  }, KEY, state || null);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof silverBalances === 'function' && document.querySelector('#app') && document.querySelector('#app').childElementCount > 0);
}

async function readState(page) {
  return page.evaluate(key => {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  }, KEY);
}
async function bals(page) {
  return page.evaluate(() => silverBalances());
}
async function clickSel(page, sel) {
  await page.waitForSelector(sel);
  await page.evaluate(s => document.querySelector(s).click(), sel);
}

async function silverOp(page, opts) {
  const confirm = opts.confirm !== false;
  let type = opts.type, form = opts.form, from = opts.from, to = opts.to;
  if (type === 'use') { type = 'move'; from = opts.form || 'regular'; to = 'solution'; }
  else if (type === 'recover') { type = 'move'; from = 'solution'; to = opts.form || 'regular'; }
  await page.evaluate(ok => { window.confirm = () => ok; }, confirm);
  await page.evaluate(() => go('silver'));
  await page.evaluate(t => startSilver(t), type);
  await page.waitForSelector('#silverSave');
  if (type === 'move') {
    if (from) {
      await page.evaluate(f => document.querySelector(`[data-from="${f}"]`).click(), from);
      await page.waitForSelector('#silverSave');
    }
    if (to) {
      await page.evaluate(t => document.querySelector(`[data-to="${t}"]:not([disabled])`).click(), to);
      await page.waitForSelector('#silverSave');
    }
  } else if (form) {
    await page.evaluate(f => document.querySelector(`[data-sf="${f}"]`).click(), form);
    await page.waitForSelector('#silverSave');
  }
  await page.evaluate(v => {
    const el = document.querySelector('#skg');
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, String(opts.kg));
  if (opts.note != null) await page.evaluate(v => { document.querySelector('#snote').value = v; }, opts.note);
  if (opts.batch != null) await page.evaluate(v => { const el = document.querySelector('#sbatch'); if (el) el.value = v; }, opts.batch);
  await clickSel(page, '#silverSave');
  if (opts.expectOpen) await page.waitForSelector('#silverForm');
  else await page.waitForFunction(() => !document.querySelector('#silverForm'));
}

async function editSilverKg(page, id, kg) {
  await page.evaluate(() => { window.confirm = () => true; });
  await page.evaluate(() => go('silver'));
  await page.evaluate(i => editSilver(i), id);
  await page.waitForSelector('#skg');
  await page.evaluate(v => {
    const el = document.querySelector('#skg');
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, String(kg));
  await clickSel(page, '#silverSave');
  await page.waitForFunction(() => !document.querySelector('#silverForm'));
}

function findSilver(st, q) {
  return st.silver.find(e => Object.entries(q).every(([k, v]) => e[k] === v));
}

async function overflow(page, label) {
  const info = await page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    const bad = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 && r.height < 1) continue;
      if (r.right > w + 1.5 || r.left < -1.5) {
        bad.push({ tag: el.tagName, id: el.id || '', cls: String(el.className || '').slice(0, 70), left: Math.round(r.left), right: Math.round(r.right) });
        if (bad.length >= 8) break;
      }
    }
    return { scroll: document.documentElement.scrollWidth, client: w, bad };
  });
  const ok = info.scroll <= info.client + 1 && info.bad.length === 0;
  assert(ok, ok ? `layout fits ${label}` : `layout fits ${label} scroll ${info.scroll}/${info.client} ${JSON.stringify(info.bad)}`);
}

async function shot(page, name) {
  await page.evaluate(() => {
    const t = document.querySelector('#toast');
    if (t) { t.style.transition = 'none'; t.classList.remove('show'); t.style.opacity = '0'; }
  });
  fs.mkdirSync(ART, { recursive: true });
  const file = path.join(ART, name + '.png');
  await page.screenshot({ path: file });
  console.log('SHOT', file);
  return file;
}

async function main() {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert(sw.includes("const CACHE = 'consumables-v9'"), 'service worker cache is consumables-v9');
  assert(!sw.includes('consumables-v8'), 'service worker no longer uses the v8 cache name');

  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/usr/local/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  await page.setViewport({ width: 412, height: 915, deviceScaleFactor: 3.5, isMobile: true, hasTouch: true });
  await page.setUserAgent('Mozilla/5.0 (Linux; Android 15; SM-S938B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36');
  await page.setCacheEnabled(false);

  // ----- fresh install -----
  await boot(page, base, null);
  const freshPrice = await page.evaluate(() => item('nitric').price);
  const freshPack = await page.evaluate(() => ({ pack: item('nitric').packSize, name: item('nitric').packName, unit: item('nitric').unit }));
  const freshBal = await bals(page);
  assert(freshPrice === null, 'nitric price per gallon defaults to blank');
  assert(freshPack.pack === 7 && freshPack.name === 'containers' && freshPack.unit === 'gallons', 'nitric stays gallons with 7-gallon containers');
  near(freshBal.regular, 0, 'fresh regular silver is 0');
  near(freshBal.flaked, 0, 'fresh flaked silver is 0');
  near(freshBal.solution, 0, 'fresh in-solution silver is 0');
  near(freshBal.onHand, 0, 'fresh on-hand silver is 0');
  await page.evaluate(() => { updItem('nitric', 'price', 12); updItem('nitric', 'price', null); });
  assert(await page.evaluate(() => item('nitric').price) === null, 'clearing nitric price stores blank, not zero');
  await page.evaluate(() => { window.confirm = () => true; startAdd(); });
  await page.waitForSelector('#itemChips');
  await page.evaluate(() => document.querySelector('[data-i="crucible"]').click());
  await page.waitForSelector('[data-s="s1"]');
  await page.evaluate(() => document.querySelector('[data-s="s1"]').click());
  await page.waitForSelector('#qty');
  await page.evaluate(() => { document.querySelector('#qty').value = '1.5'; document.querySelector('#saveBtn').click(); });
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('whole number'));
  const rejected = await page.evaluate(() => {
    const raw = localStorage.getItem('refining-consumables-v1');
    return !raw || JSON.parse(raw).entries.length === 0;
  });
  assert(rejected, 'decimal crucible entry was not saved');

  // ----- migration -----
  await boot(page, base, legacyState());
  let st = await readState(page);
  assert(st.version === 3, 'migrated state version is 3');
  assert(st.mig.silverForms === true, 'silver form migration flag is set');
  assert(st.silver.length === 4, 'historical silver entries are kept');
  assert(st.silver.every(e => e.legacy === true && e.form === 'regular'), 'old silver lines are legacy regular, not rewritten as recoveries');
  assert(st.silverMigration && st.silverMigration.note.includes('were not added to in solution'), 'migration note documents that history was not moved into solution');
  near(st.silverMigration.regularKg, 8.25, 'migration records previous balance as regular kg');
  near(st.silverMigration.flakedKg, 0, 'migration records flaked as 0');
  near(st.silverMigration.solutionKg, 0, 'migration records solution as 0');
  let b = await bals(page);
  near(b.regular, 8.25, 'migrated on-hand balance is regular silver');
  near(b.flaked, 0, 'migration does not invent flaked silver');
  near(b.solution, 0, 'historical use does not create silver in solution');
  near(b.onHand, 8.25, 'total on hand matches the old balance');
  assert(st.entries.length === 6, 'consumable entries survive silver migration');
  assert(st.paid.length === 1 && st.paid[0].id === 'oldpaid', 'existing paid archive survives migration');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof silverBalances === 'function');
  b = await bals(page);
  st = await readState(page);
  near(b.solution, 0, 'reload does not recreate solution from history');
  assert(st.silver.filter(e => e.legacy).length === 4, 'reload does not drop the legacy marks');
  await page.evaluate(() => go('silver'));
  await page.waitForSelector('#silverMigNote');
  const migText = await page.$eval('#silverMigNote', el => el.innerText);
  assert(migText.includes('were not added to in solution'), 'silver screen explains the migration');
  const histText = await page.evaluate(() => document.querySelector('#app').innerText);
  assert(histText.includes('not moved into solution'), 'legacy use rows say they were not moved into solution');

  await page.evaluate(() => go('dash'));
  const dashPay = await page.evaluate(() => {
    const labels = [...document.querySelectorAll('button')].map(b => b.textContent.replace(/\s+/g, ' ').trim());
    const list = document.querySelector('#currentList');
    return {
      nitric: labels.filter(t => t.includes('Pay nitric only')).length,
      whole: labels.filter(t => t.includes('Pay whole list')).length,
      oldNitric: labels.some(t => t.includes('Paid nitric')),
      oldWhole: labels.some(t => t.includes('Paid – start new list')),
      card: !!document.querySelector('#payNitric-card'),
      listNitric: !!document.querySelector('#payNitric-list'),
      listText: list ? list.innerText : ''
    };
  });
  assert(dashPay.nitric === 1 && dashPay.card && !dashPay.listNitric, 'dashboard has one nitric pay action, on the nitric card');
  assert(!/Pay nitric/i.test(dashPay.listText), 'current list does not repeat the nitric pay action');
  assert(dashPay.whole === 1 && dashPay.listText.includes('Pay whole list'), 'current list keeps one whole-list payment');
  assert(!dashPay.oldNitric && !dashPay.oldWhole, 'dashboard no longer uses the long duplicate pay labels');
  await page.evaluate(() => go('hist'));
  const histPay = await page.evaluate(() => {
    const labels = [...document.querySelectorAll('#settle-hist button')].map(b => b.textContent.replace(/\s+/g, ' ').trim());
    return { nitric: labels.filter(t => t.includes('Pay nitric only')).length, whole: labels.filter(t => t.includes('Pay whole list')).length };
  });
  assert(histPay.nitric === 1 && histPay.whole === 1, 'history has one nitric action and one whole-list action');
  await page.evaluate(() => go('set'));
  const setPay = await page.evaluate(() => {
    const root = document.querySelector('#paySettings');
    const labels = [...root.querySelectorAll('button')].map(b => b.textContent.replace(/\s+/g, ' ').trim());
    return { cards: document.querySelectorAll('#paySettings').length, nitric: labels.filter(t => t.includes('Pay nitric only')).length, whole: labels.filter(t => t.includes('Pay whole list')).length, text: root.innerText };
  });
  assert(setPay.cards === 1 && setPay.nitric === 1 && setPay.whole === 1, 'settings keeps both payments in one card');
  assert(setPay.text.includes('Silver is not changed') && setPay.text.includes('before anything is cleared'), 'settings payment card keeps the safety note');
  await page.evaluate(() => go('dash'));

  // legacy edit / delete must not create solution
  await editSilverKg(page, 's-use2', 2);
  b = await bals(page);
  near(b.regular, 7.5, 'editing a historical use updates regular on hand');
  near(b.solution, 0, 'editing a historical use still does not create solution');
  near(b.flaked, 0, 'editing a historical use does not create flaked silver');
  await page.evaluate(() => { window.confirm = () => true; delSilver('s-use2'); });
  b = await bals(page);
  near(b.regular, 9.5, 'deleting a historical use restores regular on hand');
  near(b.solution, 0, 'deleting a historical use does not change solution');
  st = await readState(page);
  assert(st.silver.some(e => e.id === 's-use' && e.legacy), 'the other historical use is still preserved');

  // ----- silver cycle on a clean book -----
  await boot(page, base, { version: 3, items: items(), entries: [], paid: [], silver: [], mig: { prices: true, medium: true, stampUse: true, container: true, silverForms: true } });
  await page.evaluate(() => go('silver'));
  const actions = await page.evaluate(() => [...document.querySelectorAll('.actgrid button')].map(b => b.textContent.replace(/\s+/g, ' ').trim()));
  assert(actions.length === 3 && actions.some(t => t.includes('Move silver')) && actions.some(t => t.includes('Add')) && actions.some(t => t.includes('Set balance')), 'silver tab actions are Move, Add, and Set balance');
  assert(!actions.some(t => /Use silver|Recover silver/.test(t)), 'use and recover are not separate buttons');
  const help = await page.evaluate(() => { startSilver('move'); return document.querySelector('#silverForm').innerText; });
  assert(help.includes('not written off') && help.includes('Regular') && help.includes('Flaked') && help.includes('In solution'), 'move form covers solution and both on-hand forms');
  const sameBlocked = await page.evaluate(() => document.querySelector('[data-to="regular"]').disabled);
  assert(sameBlocked, 'move cannot select the same state for from and to');
  await page.evaluate(() => closeSilver());

  await silverOp(page, { type: 'in', form: 'regular', kg: 5, note: 'synth add' });
  await silverOp(page, { type: 'in', form: 'flaked', kg: 2, note: 'synth flake' });
  await silverOp(page, { type: 'use', form: 'regular', kg: 2, batch: 'SYN-1' });
  await silverOp(page, { type: 'use', form: 'flaked', kg: 0.5 });
  b = await bals(page);
  near(b.regular, 3, 'using regular silver reduces regular on hand');
  near(b.flaked, 1.5, 'using flaked silver reduces flaked on hand');
  near(b.solution, 2.5, 'used silver from both forms waits in solution');
  near(b.onHand, 4.5, 'total on hand is regular plus flaked only');
  near(b.all, 7, 'moving silver between states does not change all silver');
  await silverOp(page, { type: 'recover', form: 'regular', kg: 0.4, note: 'partial' });
  b = await bals(page);
  near(b.regular, 3.4, 'partial recovery returns the actual kg to regular');
  near(b.flaked, 1.5, 'recovery into regular leaves flaked unchanged');
  near(b.solution, 2.1, 'partial recovery leaves the rest in solution');
  await silverOp(page, { type: 'recover', form: 'flaked', kg: 1 });
  b = await bals(page);
  near(b.flaked, 2.5, 'recovery can return silver as flaked');
  near(b.solution, 1.1, 'second partial recovery still keeps a remainder');
  near(b.regular, 3.4, 'flaked recovery does not change regular');
  st = await readState(page);
  const useId = findSilver(st, { type: 'move', from: 'regular', to: 'solution', kg: 2 }).id;
  await editSilverKg(page, useId, 1.5);
  b = await bals(page);
  near(b.regular, 3.9, 'editing a use recomputes regular on hand');
  near(b.solution, 0.6, 'editing a use recomputes solution from the edited kg');
  near(b.flaked, 2.5, 'editing a regular use leaves flaked recovery in place');
  st = await readState(page);
  const editedMove = st.silver.find(e => e.id === useId);
  assert(editedMove && editedMove.type === 'move' && editedMove.from === 'regular' && editedMove.to === 'solution' && editedMove.kg === 1.5, 'editing a move keeps its direction');
  const movedLine = await page.evaluate(() => document.querySelector('#app').innerText);
  assert(movedLine.includes('Moved') && movedLine.includes('Regular') && movedLine.includes('In solution'), 'history shows a move as one line');
  const recId = findSilver(st, { type: 'move', from: 'solution', to: 'regular', kg: 0.4 }).id;
  await page.evaluate(() => { window.confirm = () => true; });
  await page.evaluate(id => { go('silver'); delSilver(id); }, recId);
  b = await bals(page);
  near(b.regular, 3.5, 'deleting a recovery removes it from regular on hand');
  near(b.solution, 1, 'deleting a recovery puts that kg back in solution');
  near(b.flaked, 2.5, 'deleting a regular recovery leaves flaked unchanged');
  await silverOp(page, { type: 'set', form: 'flaked', kg: 0.25, note: 'scale' });
  b = await bals(page);
  near(b.flaked, 0.25, 'set balance changes only flaked silver');
  near(b.regular, 3.5, 'setting flaked does not change regular');
  near(b.solution, 1, 'setting flaked does not erase solution');
  await silverOp(page, { type: 'set', form: 'solution', kg: 1, note: 'same count' });
  b = await bals(page);
  near(b.solution, 1, 'setting solution to the same count keeps it');
  near(b.onHand, 3.75, 'on-hand total stays regular plus flaked');
  const beforeNeg = await bals(page);
  await silverOp(page, { type: 'use', form: 'flaked', kg: 5, confirm: false, expectOpen: true });
  b = await bals(page);
  near(b.flaked, beforeNeg.flaked, 'cancelling a below-zero use does not save');
  near(b.solution, beforeNeg.solution, 'cancelling a below-zero use does not move solution');
  await silverOp(page, { type: 'recover', form: 'regular', kg: 9, confirm: false, expectOpen: true });
  b = await bals(page);
  near(b.solution, beforeNeg.solution, 'cancelling an over-recovery does not drop solution');
  await silverOp(page, { type: 'use', form: 'regular', kg: 0, expectOpen: true });
  b = await bals(page);
  near(b.regular, beforeNeg.regular, 'zero kilograms is rejected');
  await page.evaluate(() => closeSilver());
  await silverOp(page, { type: 'recover', form: 'flaked', kg: 0.25 });
  b = await bals(page);
  near(b.solution, 0.75, 'a further partial recovery keeps the remaining solution');
  near(b.flaked, 0.5, 'that recovery increases flaked by the actual kg');
  near(b.regular, 3.5, 'that recovery does not change regular');
  const csv = await page.evaluate(() => buildExport().csv);
  assert(csv.includes('Silver moved') && csv.includes('Flaked') && csv.includes('In solution') && csv.includes('Regular → In solution') && csv.includes('historical use not added to in solution') === false, 'csv lists silver moves and forms');
  assert(!csv.includes('Week') && !csv.includes('Month'), 'csv does not add week or month stock columns');
  st = await readState(page);
  const roundTrip = JSON.parse(JSON.stringify({ version: st.version, items: st.items, entries: st.entries, paid: st.paid, silver: st.silver, mig: st.mig, silverMigration: st.silverMigration }));
  await boot(page, base, null);
  const restored = await page.evaluate(d => { window.confirm = () => true; return applyBackup(d); }, roundTrip);
  assert(restored === true, 'backup restore accepts the new silver book');
  b = await bals(page);
  near(b.regular, 3.5, 'restored regular balance matches');
  near(b.flaked, 0.5, 'restored flaked balance matches');
  near(b.solution, 0.75, 'restored solution balance matches');
  st = await readState(page);
  assert(st.silver.some(e => e.type === 'move' && e.from === 'solution' && e.to === 'flaked' && !e.legacy), 'restored move stays a move and is not marked legacy');
  const caller = JSON.parse(JSON.stringify(roundTrip));
  await page.evaluate(d => { window.confirm = () => false; return applyBackup(d); }, caller);
  const afterCancel = await bals(page);
  near(afterCancel.solution, 0.75, 'cancelling restore leaves balances as they were');
  assert(caller.mig.silverForms === true && caller.silver.some(e => e.type === 'move' && !e.legacy), 'restore does not rewrite the backup object');
  const omitSilver = { version: 1, items: items(), entries: [{ id: 'x', type: 'use', itemId: 'borax', qty: 1, date: '2026-03-01', created: 1 }] };
  assert(await page.evaluate(d => { window.confirm = () => true; return applyBackup(d); }, omitSilver) === true, 'older backup without silver restores');
  b = await bals(page);
  near(b.solution, 0.75, 'backup without silver does not rebuild solution from history');
  near(b.flaked, 0.5, 'backup without silver keeps flaked silver');
  near(b.regular, 3.5, 'backup without silver keeps regular silver');
  st = await readState(page);
  assert(st.silver.some(e => e.type === 'move' && !e.legacy), 'kept silver moves stay current entries');
  assert(st.entries.length === 1 && st.entries[0].id === 'x', 'that backup still replaces consumable entries');

  // old backup with a single silver balance, and a backup that omits silver
  const oldSilverBackup = {
    version: 2,
    items: items(),
    entries: [{ id: 'keep', type: 'use', itemId: 'borax', qty: 1, date: '2026-02-01', created: 1 }],
    paid: [],
    silver: [
      { id: 'old-in', type: 'in', kg: 3, date: '2026-02-01', created: 1 },
      { id: 'old-use', type: 'use', kg: 0.5, date: '2026-02-02', created: 2 }
    ],
    mig: { prices: true, medium: true, stampUse: true, container: true }
  };
  const phoneBefore = await readState(page);
  assert(await page.evaluate(d => { window.confirm = () => true; return applyBackup(d); }, oldSilverBackup) === true, 'old silver backup restores');
  b = await bals(page);
  near(b.regular, 2.5, 'old backup balance migrates onto regular on hand');
  near(b.flaked, 0, 'old backup does not create flaked silver');
  near(b.solution, 0, 'old use in a backup is not copied into solution');
  st = await readState(page);
  assert(st.silver.every(e => e.legacy === true), 'restored pre-v7 silver lines are marked legacy');
  const noSilver = { version: 1, items: items(), entries: [] };
  assert(await page.evaluate(d => { window.confirm = () => true; return applyBackup(d); }, noSilver) === true, 'backup without silver restores items');
  st = await readState(page);
  near((await bals(page)).regular, 2.5, 'a backup with no silver key keeps the silver already on the phone');
  assert(st.entries.length === 0, 'backup entries replace the current consumable list');
  assert(JSON.stringify(phoneBefore.silver.map(e => e.id).sort()) !== JSON.stringify(st.silver.map(e => e.id).sort()) || st.silver.length === 2, 'kept silver is the migrated old book');
  let threw = false;
  try { await page.evaluate(() => applyBackup({ items: [] })); } catch (e) { threw = true; }
  assert(threw, 'a backup without entries is rejected');

  // ----- payments: mixed, unpriced, cancel, nitric then full -----
  await boot(page, base, legacyState());
  const silverBefore = JSON.stringify((await readState(page)).silver);
  const itemsBefore = JSON.stringify((await readState(page)).items);
  const paidBefore = JSON.stringify((await readState(page)).paid);
  b = await bals(page);
  await page.evaluate(() => openPaidNitric());
  await page.waitForSelector('#paidModal');
  let modal = await page.$eval('#paidModal', el => el.innerText);
  assert(modal.includes('nitric only'), 'nitric pay sheet is labelled nitric only');
  assert(modal.includes('No price per gallon'), 'unpriced nitric is explained on the sheet');
  assert(modal.includes('containers'), 'nitric summary still shows containers');
  assert(!modal.includes('Borax') && !modal.includes('#1'), 'nitric sheet does not list crucibles or other items');
  await clickSel(page, '#paidCancel');
  await page.waitForFunction(() => !document.querySelector('#paidModal'));
  assert(JSON.stringify((await readState(page)).entries.map(e => e.id)) === JSON.stringify(legacyState().entries.map(e => e.id)), 'cancelling nitric pay changes nothing');
  await page.evaluate(() => openPaid());
  await page.waitForSelector('#paidModal');
  modal = await page.$eval('#paidModal', el => el.innerText);
  assert(modal.includes('Nitric acid') && modal.includes('Crucibles') && modal.includes('Borax'), 'full pay sheet lists every current item');
  await page.evaluate(() => { document.querySelector('#paidModal').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await page.waitForFunction(() => !document.querySelector('#paidModal'));
  assert(JSON.stringify((await readState(page)).paid) === paidBefore, 'dismissing the full pay sheet does not archive');

  await page.evaluate(() => openPaidNitric());
  await page.waitForSelector('#paidOK');
  await clickSel(page, '#paidOK');
  await page.waitForFunction(() => !document.querySelector('#paidModal'));
  st = await readState(page);
  const nitPaid = st.paid.find(a => a.scope === 'nitric');
  assert(nitPaid && nitPaid.count === 2, 'nitric pay archives the two nitric use lines');
  assert(nitPaid.items.length === 1 && nitPaid.items[0].name === 'Nitric acid', 'nitric archive contains only nitric');
  near(nitPaid.items[0].used, 17.5, 'nitric archive keeps 17.5 gallons');
  assert(nitPaid.items[0].packSize === 7 && nitPaid.items[0].packName === 'containers', 'nitric archive keeps the 7-gallon container summary');
  assert(nitPaid.items[0].priced === false && nitPaid.total === 0, 'unpriced nitric is archived with no cost');
  assert(nitPaid.entryIds.includes('n1') && nitPaid.entryIds.includes('n2') && !nitPaid.entryIds.includes('n-in'), 'nitric archive ids are the use lines');
  assert(st.paid.some(a => a.id === 'oldpaid'), 'older paid periods stay in the archive');
  assert(st.paid.filter(a => (a.entryIds || []).includes('n1')).length === 1, 'nitric use is archived once');
  const idsAfterNitric = st.entries.map(e => e.id).sort();
  assert(JSON.stringify(idsAfterNitric) === JSON.stringify(['b1', 'c-in', 'c1']), 'nitric pay removes nitric lines only, including hidden stock-in');
  assert(JSON.stringify(st.silver) === silverBefore, 'nitric pay does not change silver history');
  assert(JSON.stringify(st.items) === itemsBefore, 'nitric pay does not change items, prices or containers');
  b = await bals(page);
  near(b.regular, 8.25, 'nitric pay leaves regular silver');
  near(b.flaked, 0, 'nitric pay leaves flaked silver');
  near(b.solution, 0, 'nitric pay leaves silver in solution');
  await page.evaluate(() => go('set'));
  assert(await page.$eval('#payNitric-set', el => el.disabled), 'nitric pay button disables when nothing is left');
  assert(await page.$eval('#payAll-set', el => el.disabled) === false, 'full pay stays available for the remaining items');
  const paidCount = st.paid.length;
  await page.evaluate(() => openPaidNitric());
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('No nitric'));
  assert((await readState(page)).paid.length === paidCount, 'paying nitric again does not create a second archive');

  await page.evaluate(() => { go('dash'); openPaid(); });
  await page.waitForSelector('#paidModal');
  modal = await page.$eval('#paidModal', el => el.innerText);
  assert(!modal.includes('Nitric acid'), 'full pay after nitric pay does not list nitric again');
  assert(modal.includes('Crucibles') && modal.includes('Borax'), 'full pay still lists the remaining items');
  await clickSel(page, '#paidOK');
  await page.waitForFunction(() => !document.querySelector('#paidModal'));
  st = await readState(page);
  const full = st.paid.find(a => a.scope === 'all');
  assert(full && !full.entryIds.includes('n1') && !full.entryIds.includes('n2'), 'full archive does not contain the nitric lines again');
  assert(full.entryIds.includes('c1') && full.entryIds.includes('b1'), 'full archive contains crucible and borax uses');
  const cr = full.items.find(i => i.name === 'Crucibles');
  const bx = full.items.find(i => i.name === 'Borax');
  assert(cr && cr.sizes.some(z => z.name === '#1' && z.qty === 2 && z.cost === 160), 'crucible cost stays on the full archive');
  assert(bx && bx.priced === false && bx.used === 1.5, 'unpriced borax is archived without a cost');
  assert(!full.items.some(i => i.name === 'Nitric acid'), 'full archive items omit nitric');
  assert(st.entries.length === 0, 'full pay clears the remaining list');
  assert(JSON.stringify(st.silver) === silverBefore, 'full pay does not change silver history');
  near((await bals(page)).onHand, 8.25, 'full pay does not change silver balances');
  near((await bals(page)).solution, 0, 'full pay does not change solution');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof silverBalances === 'function');
  st = await readState(page);
  assert(st.paid.filter(a => a.scope === 'nitric').length === 1 && st.paid.filter(a => a.scope === 'all').length === 1, 'both archives persist after reload');
  near((await bals(page)).regular, 8.25, 'silver balance persists after reload');
  await page.evaluate(() => go('hist'));
  const paidTxt = await page.$eval('#paidList', el => el.innerText);
  assert(paidTxt.includes('Nitric only') && paidTxt.includes('Full list'), 'paid history labels nitric and full archives');
  await page.evaluate(() => go('set'));
  assert((await page.$eval('#app', el => el.innerText)).includes('v9'), 'settings shows release v9');

  // full pay first, then nitric must not archive again
  await boot(page, base, legacyState());
  await page.evaluate(() => { window.confirm = () => true; });
  await page.evaluate(() => openPaid());
  await page.waitForSelector('#paidOK');
  await clickSel(page, '#paidOK');
  await page.waitForFunction(() => !document.querySelector('#paidModal'));
  st = await readState(page);
  assert(st.paid.filter(a => (a.entryIds || []).includes('n1')).length === 1, 'nitric is in the full archive once');
  assert(st.entries.length === 0, 'full pay clears nitric and crucibles together');
  const nArchives = st.paid.length;
  await page.evaluate(() => openPaidNitric());
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('No nitric'));
  assert((await readState(page)).paid.length === nArchives, 'nitric pay after a full pay does not archive again');

  // priced nitric
  await boot(page, base, legacyState({ price: 100 }));
  const priced = await page.evaluate(() => periodSummary(e => e.itemId === 'nitric'));
  near(priced.total, 1750, 'priced nitric total is gallons times price per gallon');
  near(priced.items[0].used, 17.5, 'priced summary is still in gallons');
  assert(priced.items[0].packSize === 7, 'priced summary still carries container size');
  await page.evaluate(() => confirmPaidNitric());
  st = await readState(page);
  const pricedArc = st.paid.find(a => a.scope === 'nitric');
  near(pricedArc.total, 1750, 'priced nitric archive stores the cost');
  assert(pricedArc.items[0].price === 100 && pricedArc.items[0].priced === true, 'archive records the price per gallon');
  assert(st.entries.some(e => e.id === 'c1') && !st.entries.some(e => e.itemId === 'nitric'), 'priced nitric pay still leaves crucibles');

  // already-archived ids are not archived a second time if they reappear
  await page.evaluate(() => {
    const st = JSON.parse(localStorage.getItem('refining-consumables-v1'));
    st.entries.push({ id: 'n1', type: 'use', itemId: 'nitric', qty: 14, date: '2026-01-02', note: '', created: 2 });
    localStorage.setItem('refining-consumables-v1', JSON.stringify(st));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof periodSummary === 'function');
  const again = await page.evaluate(() => periodSummary().entryIds);
  assert(!again.includes('n1'), 'a nitric line already in an archive is left out of the next summary');
  await page.evaluate(() => confirmPaid());
  st = await readState(page);
  assert(st.paid.filter(a => (a.entryIds || []).includes('n1')).length === 1, 'confirming the full list still archives that nitric line only once');

  // entry edit keeps other items
  await boot(page, base, legacyState());
  await page.evaluate(() => { window.confirm = () => true; editEntry('n1'); });
  await page.waitForSelector('#qty');
  await page.evaluate(() => { document.querySelector('#qty').value = '7'; document.querySelector('#saveBtn').click(); });
  await page.waitForFunction(() => !document.querySelector('#qty'));
  st = await readState(page);
  assert(st.entries.find(e => e.id === 'n1').qty === 7, 'nitric quantity can be edited');
  assert(st.entries.find(e => e.id === 'c1').qty === 2, 'editing nitric leaves the crucible entry');
  await page.evaluate(() => { window.confirm = () => true; delEntry('b1'); });
  st = await readState(page);
  assert(!st.entries.some(e => e.id === 'b1'), 'an entry can be deleted');
  assert(st.entries.some(e => e.id === 'n1') && st.entries.some(e => e.id === 'c1'), 'deleting borax leaves nitric and crucibles');

  // ----- phone layout and screenshots -----
  await boot(page, base, legacyState());
  await page.evaluate(() => { document.documentElement.style.fontSize = '16px'; });
  await shot(page, 'phone-dashboard-default');
  await overflow(page, 'dashboard default font');
  await page.evaluate(() => { go('hist'); const el = document.querySelector('#settle-hist'); if (el) el.scrollIntoView({ block: 'start' }); });
  await shot(page, 'phone-history');
  await overflow(page, 'history default font');
  await page.evaluate(() => { go('set'); const el = document.querySelector('#paySettings'); if (el) el.scrollIntoView({ block: 'start' }); });
  await shot(page, 'phone-settings');
  await overflow(page, 'settings default font');
  await page.evaluate(() => startAdd());
  await page.waitForSelector('#itemChips');
  await shot(page, 'phone-add');
  await overflow(page, 'add default font');
  await page.evaluate(() => go('dash'));
  await page.evaluate(() => openPaidNitric());
  await page.waitForSelector('#paidModal');
  const nitricDlg = await page.$eval('#paidModal', el => el.innerText);
  assert(nitricDlg.includes('Pay nitric only') && nitricDlg.includes('Clears only these nitric entries'), 'nitric dialog keeps a distinct label and the safety detail');
  await shot(page, 'phone-nitric-pay-sheet');
  await overflow(page, 'nitric sheet default font');
  await clickSel(page, '#paidCancel');
  await page.evaluate(() => openPaid());
  await page.waitForSelector('#paidModal');
  const wholeDlg = await page.$eval('#paidModal', el => el.innerText);
  assert(wholeDlg.includes('Pay the whole list') && wholeDlg.includes('Silver is not affected'), 'whole-list dialog stays distinct and names silver');
  await shot(page, 'phone-whole-pay-sheet');
  await overflow(page, 'whole-list sheet default font');
  await clickSel(page, '#paidCancel');
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await page.evaluate(() => go('dash'));
  await overflow(page, 'dashboard wide screen');
  const wide = await page.evaluate(() => {
    const main = document.querySelector('main').getBoundingClientRect();
    return main.width <= 640.5 && main.left >= 0;
  });
  assert(wide, 'wide screens keep the column centered and capped');
  await page.setViewport({ width: 412, height: 915, deviceScaleFactor: 3.5, isMobile: true, hasTouch: true });
  await page.evaluate(() => go('silver'));
  await silverOp(page, { type: 'in', form: 'regular', kg: 1.5, note: 'synth' });
  await silverOp(page, { type: 'in', form: 'flaked', kg: 0.75, note: 'synth flake' });
  await silverOp(page, { type: 'use', form: 'regular', kg: 0.5, batch: 'SYN' });
  await silverOp(page, { type: 'recover', form: 'flaked', kg: 0.2, note: 'partial synth' });
  b = await bals(page);
  near(b.regular, 9.25, 'screenshot book regular balance');
  near(b.flaked, 0.95, 'screenshot book flaked balance');
  near(b.solution, 0.3, 'screenshot book keeps unrecovered solution');
  near(b.onHand, 10.2, 'screenshot book total on hand');
  near(b.all, 10.5, 'screenshot book all silver includes solution');
  await page.evaluate(() => go('silver'));
  const head = await page.evaluate(() => ({
    hero: document.querySelector('.silverhero').innerText,
    bal: document.querySelector('#silverBal').innerText,
    on: document.querySelector('#balOnHand').innerText
  }));
  assert(head.hero.includes('All silver') && head.bal.includes('10.500'), 'silver headline shows all silver');
  assert(head.on.includes('On hand') && head.on.includes('10.200'), 'on-hand subtotal stays visible');
  await page.evaluate(() => go('silver'));
  await shot(page, 'phone-silver-balances');
  await overflow(page, 'silver default font');
  await page.evaluate(() => { const n = document.querySelector('#silverMigNote'); if (n) n.scrollIntoView({ block: 'center' }); });
  await shot(page, 'phone-silver-history');
  await page.evaluate(() => { document.documentElement.style.fontSize = '20.8px'; go('dash'); });
  await page.waitForSelector('#payNitric-card');
  const largeDash = await page.evaluate(() => document.querySelectorAll('#payNitric-card').length === 1 && !document.querySelector('#payNitric-list'));
  assert(largeDash, 'large font still shows a single nitric pay button on the nitric card');
  await shot(page, 'phone-dashboard-large-font');
  await overflow(page, 'dashboard large font');
  await page.evaluate(() => go('silver'));
  await shot(page, 'phone-silver-large-font');
  await overflow(page, 'silver large font');
  await page.evaluate(() => startSilver('move'));
  await page.waitForSelector('#silverForm');
  await overflow(page, 'silver recover form large font');
  await page.evaluate(() => closeSilver());
  await page.evaluate(() => go('hist'));
  await overflow(page, 'history large font');
  await page.evaluate(() => go('set'));
  await overflow(page, 'settings large font');
  await page.evaluate(() => startAdd());
  await page.waitForSelector('#itemChips');
  await overflow(page, 'add large font');
  await page.evaluate(() => { go('dash'); openPaidNitric(); });
  await page.waitForSelector('#paidModal');
  await overflow(page, 'nitric sheet large font');
  await clickSel(page, '#paidCancel');
  await page.evaluate(() => openPaid());
  await page.waitForSelector('#paidModal');
  await overflow(page, 'whole-list sheet large font');
  await clickSel(page, '#paidCancel');

  await browser.close();
  server.close();
  const summary = { passed, failed: failures.length, failures };
  fs.mkdirSync(ART, { recursive: true });
  fs.writeFileSync(path.join(ART, 'test-results.json'), JSON.stringify(summary, null, 2));
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.error(' - ' + f);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
