// Regenerates binary assets that cannot live in git as plain files.
// Reads base64 sources next to this script and writes the real files:
//   scripts/icon.png.b64 -> assets/icon.png
// Runs automatically on `npm install` (postinstall) and can be run by hand:
//   node scripts/unpack-assets.js
const fs = require('fs');
const path = require('path');

const ASSETS = [
  { src: path.join(__dirname, 'icon.png.b64'), dest: path.join(__dirname, '..', 'assets', 'icon.png') },
];

for (const { src, dest } of ASSETS) {
  if (!fs.existsSync(src)) { console.log(`[rogue] skip: ${src} not found`); continue; }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(fs.readFileSync(src, 'utf8').trim(), 'base64'));
  console.log(`[rogue] wrote ${dest}`);
}
