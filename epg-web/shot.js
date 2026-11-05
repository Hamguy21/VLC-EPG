// Headless screenshot of the VLC EPG web UI (real visual verification).
const puppeteer = require('puppeteer-core');
const path = require('path');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.on('console', m => console.log('[console]', m.type(), m.text()));
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.goto('http://127.0.0.1:8123/', { waitUntil: 'networkidle0', timeout: 30000 });
  await page.waitForSelector('#m3u', { timeout: 10000 });
  // Use the local test fixture pair (has matching EPG -> real program blocks)
  await page.evaluate(() => {
    document.getElementById('m3u').value = 'I:/AI/vlc-epg/examples/test.m3u';
    document.getElementById('xmltv').value = 'I:/AI/vlc-epg/examples/test_epg.xml';
  });
  await page.evaluate(() => document.getElementById('load').click());
  await new Promise(r => setTimeout(r, 8000));
  const status = await page.evaluate(() => document.getElementById('status').textContent);
  const progs = await page.evaluate(() => document.querySelectorAll('.prog').length);
  const rows = await page.evaluate(() => document.querySelectorAll('.row').length);
  console.log('status:', status, '| progs:', progs, '| rows:', rows);
  if (progs === 0) { await page.screenshot({ path: 'I:/AI/vlc-epg/docs/epg-empty.png' }); }
  await page.screenshot({ path: path.join(__dirname, '..', 'docs', 'epg-web-preview.png'), fullPage: false });
  console.log('screenshot saved');
  await browser.close();
})().catch(e => { console.error('ERR', e); process.exit(1); });
