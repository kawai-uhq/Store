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
      // The balance shows as "71,473" (WLs) next to the lock icon in the header
      // Find the largest comma-formatted number in the header area
      const header = document.querySelector('header, nav, [class*="header" i], [class*="nav" i], [class*="topbar" i]');
      const searchArea = header || document.body;

      // Match numbers like "71,473" or "71473" 
      const allEls = [...searchArea.querySelectorAll('*')];
      const candidates = [];
      for (const el of allEls) {
        if (el.children.length > 2) continue;
        const text = (el.textContent?.trim() || '').replace(/,/g, '');
        if (/^\d+(\.\d+)?$/.test(text)) {
          const num = parseFloat(text);
          if (num >= 1) candidates.push(num);
        }
      }
      // The WL balance is usually the largest number shown in header
      return candidates.length ? Math.max(...candidates) : null;
    });

    if (wlBalance === null) {
      console.warn('[Gamblit] Could not find balance on page');
      return null;
    }

    // Convert WLs to BGLs: 71,473 WL ÷ 10,000 = 7.1473 BGL → 7.14 BGL
    const bglBalance = Math.floor((wlBalance / WL_PER_BGL) * 100) / 100;
    console.log(`[Gamblit] Balance: ${wlBalance.toLocaleString()} WL = ${bglBalance} BGLs`);
    return { wl: wlBalance, dl: wlBalance / 100, bgl: bglBalance };
  } catch (e) {
    console.error('[Gamblit] getBalanceBgl error:', e.message);
    return null;
  }
}

// ── Tip a user ────────────────────────────────────────────────────────────────
async function tipUser(growId, bglAmount) {
  // Convert BGLs to DLs for the tip (Gamblit tips in DLs)
  const dlAmount = bglAmount * DL_PER_BGL;
  console.log(`[Gamblit] Tipping ${bglAmount} BGLs (${dlAmount} DL) → ${growId}`);
  const page = await getPage();

  await page.goto(GAMBLIT_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(2000);
  await page.screenshot({ path: `/tmp/gamblit_1_loaded_${Date.now()}.png` }).catch(() => {});

  // ── Step 1: Click the person/user icon in top-right navbar ──────────────
  // From screenshot: navbar top-right has 👤 person, 🏆 trophy, 🎁 gift, 💬 chat
  // Person icon is the first icon in the top-right group, at approximately x=1143, y=32
  const userIconClicked = await page.evaluate(() => {
    // The navbar icons are in the top right — find all nav icon links/buttons
    const topRight = document.querySelector('header, nav, [class*="header"], [class*="navbar"], [class*="topbar"]');

    if (topRight) {
      // Get all clickable elements in the header
      const headerBtns = [...topRight.querySelectorAll('a, button, [role="button"]')];
      // Filter out the logo, balance area, + button — we want the icon group on the far right
      // The person icon is the first one after the + button
      const plusIdx = headerBtns.findIndex(el => el.textContent.trim() === '+');
      if (plusIdx !== -1) {
        const personBtn = headerBtns[plusIdx + 1];
        if (personBtn) {
          personBtn.click();
          return 'person-btn: ' + personBtn.outerHTML.slice(0, 100);
        }
      }
      // Fallback: click the first icon after the balance display
      const afterBalance = headerBtns.filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.x > 900 && rect.y < 60; // top-right area
      });
      if (afterBalance.length) {
        afterBalance[0].click();
        return 'top-right-first: ' + afterBalance[0].outerHTML.slice(0, 100);
      }
    }
    return 'no-match';
  });

  console.log('[Gamblit] Person icon click:', userIconClicked);

  // Coordinate-based click as fallback — person icon is at ~x=1143, y=32 in 1280px wide viewport
  if (!userIconClicked || userIconClicked === 'no-match') {
    console.log('[Gamblit] Using coordinate click at (1143, 32)');
    await page.mouse.click(1143, 32);
  }

  console.log('[Gamblit] User icon click:', userIconClicked ?? 'not found');
  await sleep(2000);
  await page.screenshot({ path: `/tmp/gamblit_2_afterclick_${Date.now()}.png` }).catch(() => {});

  // ── Step 2: Find tip form inputs ──────────────────────────────────────────
  const growInput = await findInput(page, [
    'input[placeholder*="Grow" i]',
    'input[placeholder*="grow_id" i]',
    'input[placeholder*="username" i]',
    'input[placeholder*="recipient" i]',
    'input[placeholder*="player" i]',
    'input[name*="grow" i]',
    'input[name*="user" i]',
    'input[type="text"]',
  ]);

  if (!growInput) {
    // Try navigating to /tip or /wallet directly
    console.log('[Gamblit] No input found after icon click, trying direct navigation...');
    for (const path of ['/tip', '/wallet', '/send', '/transfer']) {
      try {
        await page.goto(GAMBLIT_URL + path, { waitUntil: 'networkidle2', timeout: 10000 });
        await sleep(1500);
        const inp = await findInput(page, ['input[placeholder*="grow" i]', 'input[type="text"]']);
        if (inp) { console.log('[Gamblit] Found form at', path); break; }
      } catch (_) {}
    }
    await page.screenshot({ path: `/tmp/gamblit_3_navigation_${Date.now()}.png` }).catch(() => {});
  }

  const finalGrowInput = growInput || await findInput(page, [
    'input[placeholder*="Grow" i]', 'input[placeholder*="username" i]',
    'input[name*="grow" i]', 'input[type="text"]',
  ]);

  if (!finalGrowInput) {
    await page.screenshot({ path: `/tmp/gamblit_noinput_${Date.now()}.png` });
    const inputs = await page.evaluate(() =>
      [...document.querySelectorAll('input')].map(i => ({
        type: i.type, placeholder: i.placeholder, name: i.name, id: i.id
      }))
    );
    console.error('[Gamblit] All inputs:', JSON.stringify(inputs));
    throw new Error('Could not find Grow ID input');
  }

  await finalGrowInput.click({ clickCount: 3 });
  await finalGrowInput.type(String(growId), { delay: 50 });
  console.log('[Gamblit] Filled Grow ID');

  // ── Step 3: Fill amount ───────────────────────────────────────────────────
  const amountInput = await findInput(page, [
    'input[type="number"]',
    'input[placeholder*="amount" i]',
    'input[placeholder*="bgl" i]',
    'input[placeholder*="dl" i]',
    'input[name*="amount" i]',
  ], finalGrowInput);

  if (!amountInput) throw new Error('Could not find amount input');
  await amountInput.click({ clickCount: 3 });
  await amountInput.type(String(dlAmount), { delay: 50 });
  console.log(`[Gamblit] Filled amount: ${dlAmount} DL`);

  await sleep(500);
  await page.screenshot({ path: `/tmp/gamblit_4_filled_${Date.now()}.png` }).catch(() => {});

  // ── Step 4: Submit ────────────────────────────────────────────────────────
  const submitted = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button:not([disabled])')];
    const btn = btns.find(b => /^(send|tip|confirm|submit|ok)$/i.test(b.textContent?.trim()));
    if (btn) { btn.click(); return btn.textContent.trim(); }
    const sub = document.querySelector('button[type="submit"]:not([disabled])');
    if (sub) { sub.click(); return 'submit'; }
    return null;
  });

  if (!submitted) throw new Error('Could not find submit button');
  console.log('[Gamblit] Submitted:', submitted);

  await sleep(4000);
  await page.screenshot({ path: `/tmp/gamblit_5_result_${Date.now()}.png` }).catch(() => {});

  // ── Step 5: Check result ──────────────────────────────────────────────────
  const result = await page.evaluate(() => ({
    toasts: [...document.querySelectorAll(
      '[class*="toast" i],[class*="alert" i],[class*="notification" i],[role="alert"]'
    )].map(el => el.textContent.trim()).filter(Boolean),
  }));

  console.log('[Gamblit] Toasts:', result.toasts);

  if (result.toasts.some(t => /error|fail|invalid|insufficient|limit/i.test(t))) {
    throw new Error('Gamblit error: ' + result.toasts.find(t => /error|fail/i.test(t)));
  }

  console.log(`[Gamblit] ✅ ${bglAmount} BGLs (${dlAmount} DL) → ${growId}`);
  return { success: true };
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
