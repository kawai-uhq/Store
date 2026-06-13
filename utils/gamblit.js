// utils/gamblit.js — Puppeteer-based Gamblit tipping + balance fetch
//
// ⚠️ VERIFY THE TIP UNIT BEFORE GOING LIVE ⚠️
// WL_PER_BGL below assumes the tip field and the on-page balance are in WL
// (10,000 WL = 1 BGL). The header balance shows a *diamond* icon, which in
// Growtopia usually means DLs. If the field is actually DLs, every tip is 100x
// off. Do ONE tiny test tip (e.g. amount that equals 1 of the field's unit) and
// watch how the balance moves to confirm the unit before trusting this.

const puppeteer = require('puppeteer');

const GAMBLIT_URL = process.env.GAMBLIT_URL || 'https://gamblit.net';
const DL_PER_BGL = 100;
const WL_PER_BGL = 10000;

let browser = null;
let sharedPage = null;

// ── Single mutex over all page interaction ───────────────────────────────────
// Prevents the 10-min balance-sync cron from navigating the shared page while a
// tip is mid-flow (the previous version could break a tip this way).
let pageLock = Promise.resolve();
function withLock(fn) {
  const run = pageLock.then(() => fn());
  pageLock = run.then(() => {}, () => {});
  return run;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function getPage() {
  if (browser?.connected && sharedPage) {
    try { await sharedPage.evaluate(() => document.title); return sharedPage; }
    catch (_) { sharedPage = null; }
  }

  console.log('[Gamblit] Launching Chromium...');
  browser = await puppeteer.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--no-zygote','--single-process','--disable-extensions','--mute-audio'],
  });

  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (['image', 'media', 'font'].includes(req.resourceType())) req.abort();
    else req.continue();
  });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1280, height: 800 });

  const token = process.env.GAMBLIT_TOKEN;
  if (!token) throw new Error('GAMBLIT_TOKEN not set in .env');

  await page.goto(GAMBLIT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.evaluate((t) => localStorage.setItem('token', t), token);
  await page.goto(GAMBLIT_URL, { waitUntil: 'networkidle2', timeout: 45000 });

  if (!(await page.evaluate(() => !!localStorage.getItem('token')))) throw new Error('Token injection failed');
  console.log('[Gamblit] ✅ Browser ready');
  sharedPage = page;
  return page;
}

// Internal (no lock) — only call from inside withLock.
async function _readBalance() {
  const page = await getPage();
  await page.goto(GAMBLIT_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(2000);

  const wlBalance = await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent.trim();
      if (!/^[\d,]+$/.test(text) || text.length < 2) continue;
      const num = parseInt(text.replace(/,/g, ''));
      if (num < 100) continue;
      const rect = node.parentElement.getBoundingClientRect();
      if (rect.y < 60 && rect.x > 600 && rect.x < 900) return num;
    }
    return null;
  });

  if (!wlBalance) {
    await page.screenshot({ path: `/tmp/gamblit_balance_debug_${Date.now()}.png` }).catch(() => {});
    return null;
  }
  return { wl: wlBalance, dl: wlBalance / 100, bgl: Math.floor((wlBalance / WL_PER_BGL) * 100) / 100 };
}

async function getBalanceBgl() {
  return withLock(async () => {
    try { return await _readBalance(); }
    catch (e) { console.error('[Gamblit] getBalanceBgl error:', e.message); return null; }
  });
}

async function tipUser(growId, bglAmount) {
  return withLock(async () => {
    const wlAmount = bglAmount * WL_PER_BGL;
    console.log(`[Gamblit] Tipping ${bglAmount} BGLs = ${wlAmount} WL → ${growId}`);
    const page = await getPage();

    await page.goto(GAMBLIT_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(2000);

    // Open user menu (JS first, coordinate fallback)
    const menuClicked = await page.evaluate(() => {
      const els = [...document.querySelectorAll('button, a, [role="button"], img')]
        .filter((b) => { const r = b.getBoundingClientRect(); return r.right > 1080 && r.top < 64 && r.width > 0; });
      if (els.length) { els[els.length - 1].click(); return true; }
      return false;
    });
    if (!menuClicked) await page.mouse.click(1143, 32);
    await sleep(1200);

    // Click "Tip"
    const tipClicked = await page.evaluate(() => {
      const el = [...document.querySelectorAll('a, button, li, span, div, [role="menuitem"]')]
        .find((e) => (e.textContent || '').trim() === 'Tip');
      if (el) { el.click(); return true; }
      return false;
    });
    if (!tipClicked) await page.mouse.click(1137, 214);
    await sleep(1800);

    await page.waitForSelector('input', { timeout: 5000 }).catch(() => {});
    const inputs = await page.$$('input');
    if (inputs.length < 2) {
      await page.screenshot({ path: `/tmp/gamblit_noinput_${Date.now()}.png` }).catch(() => {});
      throw new Error('Tip modal inputs not found');
    }

    await inputs[0].click({ clickCount: 3 });
    await inputs[0].type(String(growId), { delay: 50 });

    await inputs[1].evaluate((el, val) => {
      const fk = Object.keys(el).find((k) => k.startsWith('__reactFiber'));
      const onChange = el[fk]?.memoizedProps?.onChange;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      if (onChange) onChange({ target: el, currentTarget: el, type: 'change' });
    }, String(wlAmount));
    await sleep(400);

    const submitted = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button:not([disabled])')].find((b) => b.textContent.trim() === 'Send tip');
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!submitted) { await page.mouse.click(640, 484); }

    await sleep(3000);
    const resultPath = `/tmp/gamblit_result_${Date.now()}.png`;
    await page.screenshot({ path: resultPath }).catch(() => {});

    const toasts = await page.evaluate(() => {
      const seen = new Set();
      return [...document.querySelectorAll('[class*="toast" i],[class*="alert" i],[class*="notification" i],[role="alert"]')]
        .map((el) => el.textContent.trim()).filter((t) => t && !seen.has(t) && seen.add(t));
    });
    console.log('[Gamblit] Result toasts:', toasts);
    if (toasts.some((t) => /error|fail|invalid|insufficient|limit/i.test(t))) {
      throw new Error('Gamblit error: ' + toasts.find((t) => /error|fail|invalid|insufficient|limit/i.test(t)));
    }

    await page.keyboard.press('Escape').catch(() => {});
    console.log(`[Gamblit] ✅ ${bglAmount} BGLs (${wlAmount} WL) → ${growId}`);
    return { success: true, screenshot: resultPath };
  });
}

async function verifyToken() {
  try {
    const page = await getPage();
    const ok = await page.evaluate(() => !!localStorage.getItem('token'));
    console.log(ok ? '[Gamblit] ✅ Token verified' : '[Gamblit] ❌ Token missing');
    return { valid: ok };
  } catch (e) {
    console.error('[Gamblit] ❌ verifyToken:', e.message);
    return { valid: false };
  }
}

async function _getPageForScreenshot(url) {
  return withLock(async () => {
    const page = await getPage();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(2000);
    return page;
  });
}

async function closeBrowser() {
  sharedPage = null;
  if (browser) { await browser.close().catch(() => {}); browser = null; }
}

module.exports = { tipUser, verifyToken, getBalanceBgl, _getPageForScreenshot, closeBrowser, DL_PER_BGL, WL_PER_BGL };
