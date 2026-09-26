import { chromium } from '@playwright/test';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('http://127.0.0.1:3190/?token=hG6-_LFnK15l_Sg9Mn8V_EBWsQZcT3ZMWU53qgnXNN0', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(8000);
for (let i = 0; i < 3; i++) {
  const b = page.getByRole('button', { name: 'Configure later', exact: true });
  if (await b.count() && await b.first().isVisible().catch(() => false)) { await b.first().click(); await page.waitForTimeout(1200); } else break;
}
const rp = page.locator('[data-sidebar-right-expand]').first();
console.log('right-expand count', await rp.count(), 'visible', await rp.isVisible().catch(() => false));
await rp.click().catch((e) => console.log('rp err', String(e).slice(0, 80)));
await page.waitForTimeout(1500);
const en = page.locator('[data-sidebar-right-guide-entry="dsh-vscode-bridge:ide"]').first();
console.log('ide entry count', await en.count(), 'visible', await en.isVisible().catch(() => false));
await en.click().catch((e) => console.log('en err', String(e).slice(0, 80)));
await page.waitForTimeout(8000);
console.log('stage visible', await page.locator('.dshvs-stage').first().isVisible().catch(() => false));
const f = page.frames().find((x) => /:18654/.test(x.url()));
console.log('frame?', !!f, f && f.url().slice(0, 80));
if (f) {
  await f.waitForSelector('.part.auxiliarybar', { timeout: 60000 });
  await page.waitForTimeout(2500);
  const head = await f.evaluate(() => {
    const aux = document.querySelector('.part.auxiliarybar');
    const title = aux && (aux.querySelector('.title') || aux.querySelector('[class*="title"]'));
    return (title ? title.outerHTML : (aux ? aux.outerHTML.slice(0, 3000) : 'NO AUX')).slice(0, 2600);
  });
  console.log(head);
}
await browser.close();