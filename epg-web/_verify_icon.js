const puppeteer = require('puppeteer-core');
(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: 'new', args: ['--no-sandbox', '--disable-gpu']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.goto('http://127.0.0.1:8123/', { waitUntil: 'networkidle0', timeout: 30000 });
  await page.waitForSelector('#load', { timeout: 10000 });
  await page.evaluate(() => {
    document.getElementById('m3u').value = 'I:/AI/vlc-epg/examples/test.m3u';
    document.getElementById('xmltv').value = 'I:/AI/vlc-epg/examples/test_epg.xml';
  });
  await page.click('#load');
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('with EPG'), { timeout: 30000 });

  // open channel details (CNN has a channel logo + first-program icon)
  await page.evaluate(() => document.querySelector('.row').click());
  await new Promise(r => setTimeout(r, 1500)); // let image(s) attempt load
  const channelState = await page.evaluate(() => ({
    wrapDisplay: document.getElementById('dIcon').style.display,
    imgClass: document.getElementById('dIconImg').className,
    imgSrc: document.getElementById('dIconImg').getAttribute('src') || '',
    natural: document.getElementById('dIconImg').naturalWidth,
  }));
  console.log('channel card:', JSON.stringify(channelState));

  // click program block (first program has icon) -> program icon should show
  await page.evaluate(() => { const p = document.querySelector('.prog:not(.noinfo)'); if (p) p.click(); });
  await new Promise(r => setTimeout(r, 1500));
  const progState = await page.evaluate(() => ({
    wrapDisplay: document.getElementById('dIcon').style.display,
    imgClass: document.getElementById('dIconImg').className,
    imgSrc: document.getElementById('dIconImg').getAttribute('src') || '',
    natural: document.getElementById('dIconImg').naturalWidth,
  }));
  console.log('program card:', JSON.stringify(progState));

  await browser.close();
})().catch(e => { console.error('ERR', e); process.exit(1); });
