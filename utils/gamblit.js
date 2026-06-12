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
      // The balance is shown as a number DIRECTLY next to the World Lock icon in the navbar
      // In the HTML, the lock icon (img/svg) and the balance number are siblings or parent/child
      // Strategy: find the lock icon element, then get the adjacent text number

      // Look for the balance container in the header — it contains lock icon + number + "+" button
      const header = document.querySelector('header, nav, [class*="header"], [class*="navbar"], [class*="topbar"]');
      if (!header) return null;

      // Find all elements in header that contain ONLY a number (the balance display)
      const headerEls = [...header.querySelectorAll('*')];

      // The balance element is a leaf node (no children) containing just a number like "22,048"
      // It's positioned between the lock icon and the + button
      for (const el of headerEls) {
        if (el.children.length > 0) continue; // must be leaf node
        const text = (el.textContent || '').trim().replace(/,/g, '');
        // Must be a plain integer or decimal — no letters, symbols, etc.
        if (/^\d+$/.test(text) || /^\d+\.\d+$/.test(text)) {
          const num = parseFloat(text);
          // The WL balance in the header is typically between 1 and 10,000,000
          // Exclude small numbers (like "1", "2" from icons/badges)
          // and the "+" button text
          if (num >= 100) {
            // Verify this element is actually near the lock icon
            // by checking its parent contains a lock-related image/svg
            const parent = el.parentElement;
            const grandparent = parent?.parentElement;
            const container = grandparent || parent;
            if (container) {
              const html = container.innerHTML.toLowerCase();
              // Lock icon containers usually have "lock", "wl", "wallet", or an img src
              if (html.includes('lock') || html.includes('wl') || html.includes('wallet') ||
                  html.includes('.png') || html.includes('img') || html.includes('svg')) {
                return num;
              }
            }
            // Also check: if the next/prev sibling is a "+" button, this is likely the balance
            const siblings = [...(el.parentElement?.children || [])];
            const idx = siblings.indexOf(el);
            const prevSib = siblings[idx - 1];
            const nextSib = siblings[idx + 1];
            if (prevSib?.tagName === 'IMG' || nextSib?.textContent?.trim() === '+' ||
                prevSib?.querySelector?.('img, svg')) {
              return num;
            }
          }
        }
      }

      // Fallback: get ALL numbers in header, pick the one right before the + button
      const plusBtn = [...header.querySelectorAll('button, span, div')].find(el => el.textContent.trim() === '+');
      if (plusBtn) {
        // Walk backwards from + button to find the balance number
        let el = plusBtn.previousElementSibling;
        while (el) {
          const text = (el.textContent || '').trim().replace(/,/g, '');
          if (/^\d+$/.test(text)) {
            const num = parseInt(text);
            if (num >= 100) return num;
          }
          // Check leaf descendants
          const leaves = [...el.querySelectorAll('*')].filter(e => e.children.length === 0);
          for (const leaf of leaves) {
            const t = (leaf.textContent || '').trim().replace(/,/g, '');
            if (/^\d+$/.test(t) && parseInt(t) >= 100) return parseInt(t);
          }
          el = el.previousElementSibling;
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

    // wlBalance is in WLs — convert to DL and BGL
    const dl = wlBalance / 100;
    const bgl = Math.floor((dl / DL_PER_BGL) * 100) / 100;

    console.log(`[Gamblit] Balance: ${wlBalance.toLocaleString()} WL = ${dl.toFixed(2)} DL = ${bgl} BGLs`);
    return { wl: wlBalance, dl, bgl };
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

  // Coordinate-based click as fallback
  if (!userIconClicked || userIconClicked === 'no-match') {
    console.log('[Gamblit] Using coordinate click at (1143, 32)');
    await page.mouse.click(1143, 32);
  }

  await sleep(1000);

  // ── Step 1b: Click the "Tip" option in the dropdown menu ─────────────────
  const tipMenuClicked = await page.evaluate(() => {
    const allLinks = [...document.querySelectorAll('a, button, [role="menuitem"], [role="option"]')];
    const tipLink = allLinks.find(el => el.textContent.trim() === 'Tip');
    if (tipLink) { tipLink.click(); return 'tip-link: ' + tipLink.outerHTML.slice(0, 100); }
    return 'not-found';
  });

  console.log('[Gamblit] Tip menu click:', tipMenuClicked);

  if (!tipMenuClicked || tipMenuClicked === 'not-found') {
    await page.mouse.click(1137, 214);
  }

  await sleep(1500);
  await page.screenshot({ path: `/tmp/gamblit_2_tipmodal_${Date.now()}.png` }).catch(() => {});

  console.log('[Gamblit] User icon click:', userIconClicked ?? 'not found');
  await sleep(2000);
  await page.screenshot({ path: `/tmp/gamblit_2_afterclick_${Date.now()}.png` }).catch(() => {});

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

  // Fill amount in WLs (bglAmount × 10,000 WL per BGL)
  const wlAmount = bglAmount * WL_PER_BGL;
  await inputs[1].click({ clickCount: 3 });
  await inputs[1].type(String(wlAmount), { delay: 50 });
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
  await page.screenshot({ path: `/tmp/gamblit_5_result_${Date.now()}.png` }).catch(() => {});

  // ── Step 4: Check result ──────────────────────────────────────────────────
  const result = await page.evaluate(() => ({
    toasts: [...document.querySelectorAll(
      '[class*="toast" i],[class*="alert" i],[class*="notification" i],[role="alert"]'
    )].map(el => el.textContent.trim()).filter(Boolean),
  }));

  console.log('[Gamblit] Toasts:', result.toasts);

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
