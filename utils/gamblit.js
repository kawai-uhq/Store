// utils/gamblit.js — Puppeteer-based Gamblit tipping
const puppeteer = require('puppeteer');

const GAMBLIT_URL = process.env.GAMBLIT_URL || 'https://gamblit.net';
const TIP_DAILY_LIMIT = 500;

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
    if (['image', 'media', 'font', 'stylesheet'].includes(req.resourceType())) req.abort();
    else req.continue();
  });

  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36');

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

async function tipUser(growId, bglAmount) {
  console.log(`[Gamblit] Tipping ${bglAmount} BGLs → ${growId}`);
  const page = await getPage();

  await page.goto(GAMBLIT_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(2000);

  await page.screenshot({ path: `/tmp/gamblit_before_${Date.now()}.png` }).catch(() => {});

  // Find and click tip button
  const tipClicked = await page.evaluate(() => {
    const all = [...document.querySelectorAll('button, [role="button"], a')];
    const btn = all.find(el => /^tip$/i.test(el.textContent?.trim()));
    if (btn) { btn.click(); return true; }
    return false;
  });

  if (tipClicked) {
    console.log('[Gamblit] Clicked tip button');
    await sleep(2000);
  } else {
    for (const path of ['/tip', '/wallet', '/send']) {
      try {
        await page.goto(GAMBLIT_URL + path, { waitUntil: 'networkidle2', timeout: 10000 });
        const hasForm = await page.evaluate(() =>
          !!document.querySelector('input[placeholder*="grow" i], input[placeholder*="user" i]')
        );
        if (hasForm) { console.log('[Gamblit] Found form at', path); break; }
      } catch (_) {}
    }
    await sleep(1500);
  }

  await page.screenshot({ path: `/tmp/gamblit_form_${Date.now()}.png` }).catch(() => {});

  // Fill Grow ID
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
    await page.screenshot({ path: `/tmp/gamblit_noinput_${Date.now()}.png` });
    const inputs = await page.evaluate(() =>
      [...document.querySelectorAll('input')].map(i => ({
        type: i.type, placeholder: i.placeholder, name: i.name, id: i.id
      }))
    );
    console.error('[Gamblit] Inputs on page:', JSON.stringify(inputs));
    throw new Error('Could not find Grow ID input — check /tmp/gamblit_noinput_*.png');
  }

  await growInput.click({ clickCount: 3 });
  await growInput.type(String(growId), { delay: 50 });
  console.log('[Gamblit] Filled Grow ID');

  // Fill amount
  const amountInput = await findInput(page, [
    'input[type="number"]',
    'input[placeholder*="amount" i]',
    'input[placeholder*="bgl" i]',
    'input[placeholder*="dl" i]',
    'input[name*="amount" i]',
  ], growInput);

  if (!amountInput) throw new Error('Could not find amount input');
  await amountInput.click({ clickCount: 3 });
  await amountInput.type(String(bglAmount), { delay: 50 });
  console.log('[Gamblit] Filled amount');

  await sleep(500);
  await page.screenshot({ path: `/tmp/gamblit_filled_${Date.now()}.png` }).catch(() => {});

  // Submit
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
  await page.screenshot({ path: `/tmp/gamblit_result_${Date.now()}.png` }).catch(() => {});

  const result = await page.evaluate(() => ({
    toasts: [...document.querySelectorAll(
      '[class*="toast" i],[class*="alert" i],[class*="notification" i],[role="alert"]'
    )].map(el => el.textContent.trim()).filter(Boolean),
  }));

  console.log('[Gamblit] Toasts:', result.toasts);

  if (result.toasts.some(t => /error|fail|invalid|insufficient|limit/i.test(t))) {
    throw new Error('Gamblit error: ' + result.toasts.find(t => /error|fail/i.test(t)));
  }

  console.log(`[Gamblit] ✅ ${bglAmount} BGLs → ${growId}`);
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

module.exports = { tipUser, verifyToken, closeBrowser, TIP_DAILY_LIMIT };
