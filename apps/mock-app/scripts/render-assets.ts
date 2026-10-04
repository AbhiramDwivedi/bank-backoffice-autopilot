// One-off dev tool: renders the login button and toolbar icons used by the mock app from
// inline HTML/CSS/SVG snippets into small PNGs, using a headless Chromium page as the rasterizer.
// The mock app ships these as static files under apps/mock-app/public/img; this script is not
// imported by the app and does not run at request time.
//
// Run with: npx tsx apps/mock-app/scripts/render-assets.ts
//
// Each asset is rendered at deviceScaleFactor 1 so the output PNG is exactly the target
// element size (no retina upscaling), then cropped to that element with locator.screenshot.

import { chromium } from 'playwright';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'public', 'img');

interface AssetSpec {
  file: string;
  width: number;
  height: number;
  html: string;
}

const assets: AssetSpec[] = [
  {
    // Beveled Windows-2000-style "Sign On" button, replacing the blank btn_login.gif used as
    // <input type="image"> on the login form.
    file: 'btn_login.png',
    width: 90,
    height: 24,
    html: `
      <div class="btn2k">Sign On</div>
      <style>
        html, body { margin: 0; padding: 0; }
        .btn2k {
          box-sizing: border-box;
          width: 90px;
          height: 24px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: linear-gradient(to bottom, #f4f4f2 0%, #d4d0c8 100%);
          border-top: 1px solid #ffffff;
          border-left: 1px solid #ffffff;
          border-right: 1px solid #404040;
          border-bottom: 1px solid #404040;
          box-shadow: inset 1px 1px 0 #dfdfdf, inset -1px -1px 0 #808080;
          font-family: Tahoma, Arial, sans-serif;
          font-size: 11px;
          color: #000000;
        }
      </style>
    `,
  },
  {
    // Power/log-off icon: a circle with a vertical line through the top, in a dark red.
    file: 'ico_power.png',
    width: 16,
    height: 16,
    html: `
      <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
        <circle cx="8" cy="9" r="4.5" fill="none" stroke="#A61B1B" stroke-width="1.6"/>
        <line x1="8" y1="2.2" x2="8" y2="7" stroke="#A61B1B" stroke-width="1.6" stroke-linecap="round"/>
      </svg>
    `,
  },
  {
    // Help icon: a question mark in a filled blue circle.
    file: 'ico_help.png',
    width: 16,
    height: 16,
    html: `
      <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
        <circle cx="8" cy="8" r="7" fill="#1A5FB4"/>
        <text x="8" y="12" text-anchor="middle" font-family="Tahoma, Arial, sans-serif"
              font-size="10" font-weight="bold" fill="#FFFFFF">?</text>
      </svg>
    `,
  },
  {
    // Print icon: a small printer -- body, feed slot and an output sheet.
    file: 'ico_print.png',
    width: 16,
    height: 16,
    html: `
      <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
        <rect x="4" y="1" width="8" height="5" fill="#FFFFFF" stroke="#000000" stroke-width="0.6"/>
        <rect x="1" y="6" width="14" height="6" rx="1" fill="#606060"/>
        <rect x="3" y="7.5" width="10" height="1.6" fill="#303030"/>
        <rect x="4" y="11" width="8" height="3.2" fill="#FFFFFF" stroke="#000000" stroke-width="0.6"/>
      </svg>
    `,
  },
  {
    // Search icon: a magnifying glass.
    file: 'ico_search.png',
    width: 16,
    height: 16,
    html: `
      <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
        <circle cx="6.5" cy="6.5" r="4.2" fill="none" stroke="#333333" stroke-width="1.6"/>
        <line x1="9.6" y1="9.6" x2="14" y2="14" stroke="#333333" stroke-width="2" stroke-linecap="round"/>
      </svg>
    `,
  },
];

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    for (const asset of assets) {
      await page.setContent(`<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;">${asset.html}</body></html>`);
      const locator = asset.html.trim().startsWith('<svg')
        ? page.locator('svg')
        : page.locator('body > *:first-child');
      const box = await locator.boundingBox();
      if (!box || Math.round(box.width) !== asset.width || Math.round(box.height) !== asset.height) {
        throw new Error(`${asset.file}: rendered size ${JSON.stringify(box)} does not match target ${asset.width}x${asset.height}`);
      }
      const outPath = path.join(OUT_DIR, asset.file);
      await locator.screenshot({ path: outPath, omitBackground: true });
      console.log(`wrote ${outPath} (${asset.width}x${asset.height})`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
