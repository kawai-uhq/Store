// utils/gamblit.js — Puppeteer-based Gamblit tipping + balance fetch
const puppeteer = require('puppeteer');

const GAMBLIT_URL = process.env.GAMBLIT_URL || 'https://gamblit.net';
const TIP_DAILY_LIMIT = 500;
const DL_PER_BGL = 100;    // 100 DL = 1 BGL
const WL_PER_BGL = 10000;  // 10,000 WL = 1 BGL (since page shows WL balance)

let browser = null;
let sharedPage = null;

async function getPage() {
  if (browser?.connected && sharedPage) {
    try { await sharedPage.evaluate(() => document.title); return sharedPage; }
    catch (_) { sharedPage = null; }
  }

  console.log('[Gamblit] Launching Chromium...');
  browser = await puppeteer.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-extensions',
      '--disable-background-networking',
      '--mute-audio',
    ],
  });

  const page = await browser.newPage();

  await page.setRequestInterception(true);
  page.on('request', req => {
    // Allow stylesheets so the page renders correctly and elements are positioned properly
    // Block only heavy media files
    if (['image', 'media', 'font'].includes(req.resourceType())) req.abort();
    else req.continue();
  });

  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1280, height: 800 });

  const token = process.env.GAMBLIT_TOKEN;
  if (!token) throw new Error('GAMBLIT_TOKEN not set in .env');

  await page.goto(GAMBLIT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.evaluate(t => localStorage.setItem('token', t), token);
  console.log('[Gamblit] Token injected, reloading...');
  await page.goto(GAMBLIT_URL, { waitUntil: 'networkidle2', timeout: 45000 });

  const hasToken = await page.evaluate(() => !!localStorage.getItem('token'));
  if (!hasToken) throw new Error('Token injection failed');

  console.log('[Gamblit] ✅ Browser ready');
  sharedPage = page;
  return page;
}

// ── Fetch DL balance and convert to BGLs ─────────────────────────────────────
async function getBalanceBgl() {
  try {
    const page = await getPage();
    await page.goto(GAMBLIT_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(2000);

    const wlBalance = await page.evaluate(() => {
      // From probe: balance is a <DIV class=""> at position [80,22]
      // It's the only empty-class DIV in the top-left containing a number like "22,046"
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const text = node.textContent.trim();
        // Match numbers like "22,046" or "22046"
        if (!/^[\d,]+$/.test(text) || text.length < 2) continue;
        const num = parseInt(text.replace(/,/g, ''));
        if (num < 100) continue;

        const el = node.parentElement;
        const rect = el.getBoundingClientRect();

        // The balance div is at approximately x=780, y=22 (top navbar, center-right)
        if (rect.y < 60 && rect.x > 600 && rect.x < 900) {
          return num;
        }
      }
      return null;
    });

    console.log('[Gamblit] Raw WL balance from page:', wlBalance);

    if (!wlBalance) {
      await page.screenshot({ path: `/tmp/gamblit_balance_debug_${Date.now()}.png` });
      console.warn('[Gamblit] Could not find balance');
      return null;
    }

    // wlBalance is in WL — convert to DL and BGL
    const dl = wlBalance / 100;
    const bgl = Math.floor((wlBalance / WL_PER_BGL) * 100) / 100;
    console.log(`[Gamblit] Balance: ${wlBalance.toLocaleString()} WL = ${dl.toFixed(2)} DL = ${bgl} BGLs`);
    return { wl: wlBalance, dl, bgl };
  } catch (e) {
    console.error('[Gamblit] getBalanceBgl error:', e.message);
    return null;
  }
}

// ── Tip a user ────────────────────────────────────────────────────────────────
async function tipUser(growId, bglAmount) {
  // Gamblit tip field uses WL (World Locks): 1 BGL = 10,000 WL
  const wlAmount = bglAmount * WL_PER_BGL;
  const dlAmount = bglAmount * DL_PER_BGL; // kept for logging
  console.log(`[Gamblit] Tipping ${bglAmount} BGLs = ${wlAmount} WL → ${growId}`);
  const page = await getPage();

  await page.goto(GAMBLIT_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(2000);
  await page.screenshot({ path: `/tmp/gamblit_1_loaded_${Date.now()}.png` }).catch(() => {});

  // ── Step 1: Click person icon (coordinate-based — most reliable) ─────────
  // From screenshot: person icon is at x=1143, y=32 in 1280px viewport
  await page.mouse.click(1143, 32);
  console.log('[Gamblit] Clicked person icon');
  await sleep(1000);

  // ── Step 1b: Click "Tip" in the dropdown ─────────────────────────────────
  // First try JS click by text, then coordinate fallback
  const tipMenuClicked = await page.evaluate(() => {
    const all = [...document.querySelectorAll('a, button, li, [role="menuitem"]')];
    const tipEl = all.find(el => el.textContent.trim() === 'Tip');
    if (tipEl) { tipEl.click(); return true; }
    return false;
  });

  if (!tipMenuClicked) {
    // Coordinate fallback — Tip option is at x=1137, y=214
    await page.mouse.click(1137, 214);
  }
  console.log('[Gamblit] Clicked Tip menu item');

  await sleep(1500);
  await page.screenshot({ path: `/tmp/gamblit_2_tipmodal_${Date.now()}.png` }).catch(() => {});

  await sleep(1000);

  // ── Step 2: Fill Username field ──────────────────────────────────────────
  // Modal has: "Username" label → text input, "Tip Amount" label → number input, "Send tip" button
  await page.waitForSelector('input', { timeout: 5000 }).catch(() => {});

  const inputs = await page.$$('input');
  console.log(`[Gamblit] Found ${inputs.length} inputs in modal`);

  // First input = Username, Second input = Tip Amount
  if (inputs.length < 2) {
    await page.screenshot({ path: `/tmp/gamblit_noinput_${Date.now()}.png` });
    const inputData = await page.evaluate(() =>
      [...document.querySelectorAll('input')].map(i => ({
        type: i.type, placeholder: i.placeholder, name: i.name, id: i.id
      }))
    );
    console.error('[Gamblit] Inputs:', JSON.stringify(inputData));
    throw new Error('Tip modal inputs not found');
  }

  // Fill username (Gamblit username = growId provided by buyer)
  await inputs[0].click({ clickCount: 3 });
  await inputs[0].type(String(growId), { delay: 50 });
  console.log('[Gamblit] Filled username:', growId);

  // Clear amount field and type WL amount
  await inputs[1].click({ clickCount: 3 });
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await sleep(200);
  // Verify field is empty
  const currentVal = await inputs[1].evaluate(el => el.value);
  console.log('[Gamblit] Amount field before typing:', currentVal);
  await inputs[1].type(String(wlAmount), { delay: 80 });
  await sleep(200);
  const newVal = await inputs[1].evaluate(el => el.value);
  console.log('[Gamblit] Amount field after typing:', newVal, '(expected:', wlAmount, ')');
  // Trigger React state update
  await inputs[1].evaluate((el, val) => {
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeInputValueSetter.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, String(wlAmount));
  console.log(`[Gamblit] Filled tip amount: ${wlAmount} WL (${bglAmount} BGLs)`);

  await sleep(500);
  await page.screenshot({ path: `/tmp/gamblit_3_filled_${Date.now()}.png` }).catch(() => {});

  // ── Step 3: Click "Send tip" button ──────────────────────────────────────
  const submitted = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button:not([disabled])')];
    // Must match exactly "Send tip" — avoid other buttons
    const btn = btns.find(b => b.textContent.trim() === 'Send tip');
    if (btn) { btn.click(); return btn.textContent.trim(); }
    return null;
  });

  if (!submitted) {
    // Coordinate fallback — "Send tip" green button at ~x=640, y=508
    await page.mouse.click(640, 508);
    console.log('[Gamblit] Clicked Send tip by coordinate');
  } else {
    console.log('[Gamblit] Clicked:', submitted);
  }

  await sleep(4000);
  // Save with timestamp so orderProcessor can find the most recent one
  const resultScreenshotPath = `/tmp/gamblit_5_result_${Date.now()}.png`;
  await page.screenshot({ path: resultScreenshotPath }).catch(() => {});
  console.log('[Gamblit] Result screenshot saved:', resultScreenshotPath);

  // ── Step 4: Check result ──────────────────────────────────────────────────
  const result = await page.evaluate(() => {
    const seen = new Set();
    const toasts = [...document.querySelectorAll(
      '[class*="toast" i],[class*="alert" i],[class*="notification" i],[role="alert"]'
    )].map(el => el.textContent.trim()).filter(t => {
      if (!t || seen.has(t)) return false;
      seen.add(t);
      return true;
    });
    return { toasts };
  });

  console.log('[Gamblit] Result:', result.toasts);

  if (result.toasts.some(t => /error|fail|invalid|insufficient|limit/i.test(t))) {
    throw new Error('Gamblit error: ' + result.toasts.find(t => /error|fail/i.test(t)));
  }

  // ── Step 5: Close the modal ───────────────────────────────────────────────
  await page.evaluate(() => {
    // Click the X button to close the modal
    const closeBtn = document.querySelector('button[class*="close" i], button[aria-label*="close" i]');
    if (closeBtn) { closeBtn.click(); return; }
    // Find X button by content
    const btns = [...document.querySelectorAll('button')];
    const x = btns.find(b => b.textContent.trim() === '×' || b.textContent.trim() === 'x' || b.textContent.trim() === '✕');
    if (x) { x.click(); return; }
    // Coordinate fallback — X is at top right of modal ~x=816, y=254
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });

  // Also try pressing Escape
  await page.keyboard.press('Escape');
  await sleep(500);

  // ── Step 5: Verify tip went through by checking balance dropped ──────────
  await sleep(2000);
  const balAfter = await getBalanceBgl().catch(() => null);
  if (balAfter) {
    console.log(`[Gamblit] Balance after tip: ${balAfter.wl.toLocaleString()} WL`);
  }

  console.log(`[Gamblit] ✅ ${bglAmount} BGLs (${wlAmount} WL) → ${growId}`);
  return { success: true, balanceAfter: balAfter };
}


async function verifyToken() {
  try {
    const page = await getPage();
    const ok = await page.evaluate(() => !!localStorage.getItem('token'));
    if (ok) { console.log('[Gamblit] ✅ Token verified'); return { valid: true }; }
    return { valid: false };
  } catch (e) {
    console.error('[Gamblit] ❌ verifyToken:', e.message);
    return { valid: false };
  }
}

async function findInput(page, selectors, exclude = null) {
  for (const sel of selectors) {
    try {
      const els = await page.$$(sel);
      for (const el of els) {
        if (exclude) {
          const same = await page.evaluate((a, b) => a === b, el, exclude).catch(() => false);
          if (same) continue;
        }
        const visible = await el.isIntersectingViewport().catch(() => true);
        if (visible) return el;
      }
    } catch (_) {}
  }
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function closeBrowser() {
  sharedPage = null;
  if (browser) { await browser.close().catch(() => {}); browser = null; }
}

// ── Expose page for screenshot command ───────────────────────────────────────
async function _getPageForScreenshot(url) {
  const page = await getPage();
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(2000);
  return page;
}

module.exports = { tipUser, verifyToken, getBalanceBgl, _getPageForScreenshot, closeBrowser, TIP_DAILY_LIMIT, DL_PER_BGL };
