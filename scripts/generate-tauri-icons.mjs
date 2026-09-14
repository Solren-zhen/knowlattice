/**
 * 生成 Tauri 图标（src-tauri/icons）：从 public/icon-512.png 的 PNG 尺寸图，
 * 组装 tauri.conf.json 需要的 32x32.png / 128x128.png / 128x128@2x.png / icon.ico / icon.icns。
 * 用法：先运行 PowerShell 生成 icon-{16,32,48,128,256,512}.png（System.Drawing），
 * 再执行 `node scripts/generate-tauri-icons.mjs` 组装 ICO/ICNS 并改名。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const DIR = 'src-tauri/icons';
const png = (f) => readFileSync(`${DIR}/${f}`);

/** 复制为 tauri.conf.json 需要的文件名 */
const renames = {
  'icon-32.png': '32x32.png',
  'icon-128.png': '128x128.png',
  'icon-256.png': '128x128@2x.png',
};
for (const [from, to] of Object.entries(renames)) {
  writeFileSync(`${DIR}/${to}`, png(from));
  console.log(`renamed ${from} -> ${to}`);
}

// ---------- ICO：PNG 条目（Vista+ 支持），16/32/48/256 ----------
function buildIco(entries) {
  const chunks = entries.map(({ size }) => png(`icon-${size}.png`));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(chunks.length, 4);
  const dir = Buffer.alloc(16 * chunks.length);
  let offset = 6 + dir.length;
  chunks.forEach((b, i) => {
    const o = i * 16;
    dir.writeUInt8(entries[i].size >= 256 ? 0 : entries[i].size, o); // 0 = 256
    dir.writeUInt8(entries[i].size >= 256 ? 0 : entries[i].size, o + 1);
    dir.writeUInt8(0, o + 2); // palette
    dir.writeUInt8(0, o + 3); // reserved
    dir.writeUInt16LE(1, o + 4); // planes
    dir.writeUInt16LE(32, o + 6); // bpp
    dir.writeUInt32LE(b.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += b.length;
  });
  return Buffer.concat([header, dir, ...chunks]);
}
writeFileSync(`${DIR}/icon.ico`, buildIco([16, 32, 48, 256].map((size) => ({ size }))));
console.log('wrote icon.ico');

// ---------- ICNS：PNG chunk（ic07/ic08/ic09/ic11/ic12） ----------
const ICNS_CHUNKS = [
  ['ic11', 16],
  ['ic12', 32],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
];
const parts = ICNS_CHUNKS.map(([type, size]) => {
  const b = png(`icon-${size}.png`);
  const h = Buffer.alloc(8);
  h.write(type, 0, 'ascii');
  h.writeUInt32BE(b.length + 8, 4);
  return Buffer.concat([h, b]);
});
const icns = Buffer.concat([Buffer.from('icns'), (() => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(8 + parts.reduce((n, p) => n + p.length, 0), 0);
  return b;
})(), ...parts]);
writeFileSync(`${DIR}/icon.icns`, icns);
console.log('wrote icon.icns');

// ---------- 校验 ----------
import { statSync } from 'node:fs';
for (const f of ['32x32.png', '128x128.png', '128x128@2x.png', 'icon.ico', 'icon.icns']) {
  const st = statSync(`${DIR}/${f}`);
  console.log(`  ok ${f} (${st.size} bytes)`);
}
