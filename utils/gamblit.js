// utils/gamblit.js — Puppeteer-based Gamblit tipping + balance fetch
//
// UNITS: the tip field and the header balance are both in WL (10,000 WL = 1 BGL,
// 100 WL = 1 DL). An earlier test where "100" tipped only 1 was the amount-fill
// failing to commit (the field defaults to 1) — NOT a unit mismatch. The amount
// is now typed like a human and VERIFIED before sending, so it can't silently
// send the default again.

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
  // Load ALL resources (images, media, fonts). Blocking them left the React UI
  // partially rendered and misplaced the tip controls.
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

  const headerNum = await page.evaluate(() => {
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

  if (!headerNum) {
    await page.screenshot({ path: `/tmp/gamblit_balance_debug_${Date.now()}.png` }).catch(() => {});
    return null;
  }
  // Header balance is in WL (the gold icon). Tips are also entered in WL.
  const wl = headerNum;
  return { wl, dl: wl / 100, bgl: Math.floor((wl / WL_PER_BGL) * 100) / 100 };
}

async function getBalanceBgl() {
  return withLock(async () => {
    try { return await _readBalance(); }
    catch (e) { console.error('[Gamblit] getBalanceBgl error:', e.message); return null; }
  });
}

// Public: tip a BGL amount (converts BGL -> WL using WL_PER_BGL).
async function tipUser(growId, bglAmount) {
  return withLock(() => _tipFlow(growId, String(bglAmount * WL_PER_BGL),
    `${bglAmount} BGLs = ${bglAmount * WL_PER_BGL} WL`));
}

// Public: tip a RAW amount in whatever unit the field expects (no conversion).
// Use this to verify the unit — tip a small known number and watch the balance.
async function tipRaw(growId, rawAmount) {
  return withLock(() => _tipFlow(growId, String(rawAmount), `${rawAmount} (raw)`));
}

// Internal UI flow — call only inside withLock.
async function _tipFlow(growId, amountStr, label) {
  {
    console.log(`[Gamblit] Tipping ${label} → ${growId}`);
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

    // The amount field is a CurrencyInput that only COMMITS on blur (confirmed via
    // probe — onChange alone left the modal's amount state at its default 1).
    // Set value -> fire its real onChange -> fire its real onBlur, then verify
    // against React state (digits only, since CurrencyInput may format the value).
    const amountInput = inputs[1];
    await amountInput.evaluate((el, val) => {
      const pk = Object.keys(el).find((k) => k.startsWith('__reactProps'));
      const props = pk ? el[pk] : null;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, val);
      const ev = (type) => ({ target: el, currentTarget: el, type, bubbles: true, preventDefault() {}, stopPropagation() {} });
      if (props && typeof props.onChange === 'function') props.onChange(ev('change'));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      if (props && typeof props.onBlur === 'function') props.onBlur(ev('blur'));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    }, amountStr);
    await sleep(400);

    const committed = await amountInput.evaluate((el) => {
      const pk = Object.keys(el).find((k) => k.startsWith('__reactProps'));
      return pk ? String(el[pk].value) : String(el.value);
    });
    const want = amountStr.replace(/\D/g, '');
    const got = (committed || '').replace(/\D/g, '');
    console.log(`[Gamblit] amount React state = "${committed}" (want "${amountStr}")`);
    if (got !== want) {
      throw new Error(`Amount state is "${committed}", expected "${amountStr}" — aborting before send`);
    }

    // Send tip is disabled until amount + username are valid — wait for it to enable
    let submitted = false;
    for (let i = 0; i < 8; i++) {
      submitted = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Send tip');
        if (btn && !btn.disabled) { btn.click(); return true; }
        return false;
      });
      if (submitted) break;
      await sleep(400);
    }
    if (!submitted) throw new Error('Send tip stayed disabled — amount/username not accepted');

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
    console.log(`[Gamblit] ✅ Tipped ${label} → ${growId}`);
    return { success: true, screenshot: resultPath };
  }
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

module.exports = { tipUser, tipRaw, verifyToken, getBalanceBgl, _getPageForScreenshot, closeBrowser, DL_PER_BGL, WL_PER_BGL };
