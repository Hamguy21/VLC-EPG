// Headless screenshot of the VLC EPG web UI (real visual verification).
//
// Configurable via environment variables:
//   M3U  - playlist source (default: local test fixture)
//   EPG  - XMLTV source    (default: local test fixture)
//   OUT  - screenshot path (default: <repo>/docs/epg-web-preview.png)
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const M3U = process.env.M3U || path.join(__dirname, '..', 'examples', 'test.m3u');
const EPG = process.env.EPG || path.join(__dirname, '..', 'examples', 'test_epg.xml');
const OUT = process.env.OUT || path.join(__dirname, '..', 'docs', 'epg-web-preview.png');

const findBrowser = () => {
  if (process.env.BROWSER) return process.env.BROWSER;
  const cands = process.platform === 'win32'
    ? ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
       'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
       'C:/Program Files/Google/Chrome/Application/chrome.exe',
       'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe']
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
         '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/microsoft-edge'];
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (_) {} }
  return undefined;
};

(async () => {
  const browser = await puppeteer.launch({
    executablePath: findBrowser(),
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu']
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    page.on('console', m => console.log('[console]', m.type(), m.text()));
    page.on('pageerror', e => console.log('[pageerror]', e.message));
    await page.goto('http://127.0.0.1:8123/', { waitUntil: 'networkidle0', timeout: 30000 });
    await page.waitForSelector('#m3u', { timeout: 10000 });

    await page.evaluate((m3u, epg) => {
      document.getElementById('m3u').value = m3u;
      document.getElementById('xmltv').value = epg;
    }, M3U, EPG);
    await page.evaluate(() => document.getElementById('load').click());

    // Wait for the grid to actually render (up to 30s for slow EPG downloads)
    await page.waitForSelector('.row', { timeout: 30000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 1000));

    const status = await page.evaluate(() => document.getElementById('status').textContent);
    const progs = await page.evaluate(() => document.querySelectorAll('.prog').length);
    const rows = await page.evaluate(() => document.querySelectorAll('.row').length);
    console.log('status:', status, '| progs:', progs, '| rows:', rows);

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    if (progs === 0) {
      const empty = path.join(path.dirname(OUT), 'epg-empty.png');
      await page.screenshot({ path: empty, fullPage: false });
      console.log('no programs rendered — empty-state screenshot:', empty);
    }
    await page.screenshot({ path: OUT, fullPage: false });
    console.log('screenshot saved:', OUT);
  } finally {
    await browser.close();
  }
})().catch(e => { console.error('ERR', e); process.exit(1); });
