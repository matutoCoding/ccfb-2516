// 生成模拟古籍扫描页：竖排文字、边框鱼尾、页码，输出到 test-fixtures/
// 运行：node scripts/gen-fixtures.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const W = 600;
const H = 840;

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  // 加 filter 字节
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = deflateSync(raw, { level: 6 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// 5x7 点阵字库（仅测试用字）
const GLYPHS = {
  学: ['01110','10001','10001','11111','10001','10001','10001'],
  而: ['11111','00100','00100','11110','00100','00100','00100'],
  时: ['10001','10001','11111','10101','11111','10001','10001'],
  习: ['00100','01010','10001','11111','10001','10001','00000'],
  之: ['10001','01010','00100','01010','10001','00000','00000'],
  曰: ['01110','10001','10001','10001','10001','10001','01110'],
  子: ['01110','00100','00100','11110','00100','00101','00010'],
  不: ['10001','01010','00100','11111','00100','00100','00100'],
  亦: ['10101','10101','01110','11111','01010','01010','10001'],
  说: ['10110','10101','11111','00100','01110','10001','01110'],
  乎: ['00100','00100','01110','10001','10001','10001','01110'],
  有: ['11110','10001','10001','11110','10001','10001','11110'],
  朋: ['11110','10001','10001','11110','10001','10001','11110'],
  自: ['01110','10001','10001','11111','10001','10001','01110'],
  远: ['11001','10101','10010','11111','10010','10101','11001'],
  方: ['01110','10001','10001','11111','00100','01000','10000'],
  来: ['10001','10001','01110','11111','00100','01010','10001'],
  页: ['11110','10001','10001','11110','10001','10001','11110'],
  论: ['10110','10100','11110','00100','01110','10001','01110'],
  语: ['10110','10101','11111','00100','01110','10001','01110'],
};

const TEXT = '学而时习之不亦说乎有朋自远方来子曰';

function setPx(buf, x, y, shade = 40) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  buf[i] = shade;
  buf[i + 1] = shade - 5;
  buf[i + 2] = shade - 15;
  buf[i + 3] = 255;
}

function drawGlyph(buf, ch, x0, y0, scale) {
  const g = GLYPHS[ch];
  if (!g) return;
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 5; x++) {
      if (g[y][x] === '1') {
        for (let sy = 0; sy < scale; sy++)
          for (let sx = 0; sx < scale; sx++) setPx(buf, x0 + x * scale + sx, y0 + y * scale + sy);
      }
    }
  }
}

function drawRect(buf, x0, y0, w, h) {
  for (let x = x0; x < x0 + w; x++) { setPx(buf, x, y0); setPx(buf, x, y0 + h - 1); }
  for (let y = y0; y < y0 + h; y++) { setPx(buf, x0, y); setPx(buf, x0 + w - 1, y); }
}

function makePage(num) {
  const buf = Buffer.alloc(W * H * 4);
  // 米黄纸底
  for (let i = 0; i < W * H; i++) {
    const n = (Math.random() - 0.5) * 12;
    buf[i * 4] = 232 + n;
    buf[i * 4 + 1] = 219 + n;
    buf[i * 4 + 2] = 186 + n;
    buf[i * 4 + 3] = 255;
  }
  // 版框
  drawRect(buf, 48, 60, W - 96, H - 120);
  // 竖排文字：从右向左列
  const scale = 5;
  const colW = 52;
  const startX = W - 100;
  const startY = 100;
  let idx = (num - 1) * 8;
  for (let col = 0; col < 8; col++) {
    for (let row = 0; row < 10; row++) {
      const ch = TEXT[idx % TEXT.length];
      idx++;
      drawGlyph(buf, ch, startX - col * colW, startY + row * 46, scale);
    }
  }
  // 页码（数字简化：画点阵方块组）
  const label = String(num);
  let lx = W / 2 - label.length * 14;
  for (const d of label) {
    const n = Number(d);
    for (let i = 0; i < 5; i++) if ((n >> i) & 1) drawRect(buf, lx, H - 48, 8, 5);
    lx += 16;
  }
  return encodePng(W, H, buf);
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test-fixtures');
mkdirSync(outDir, { recursive: true });
for (let n = 1; n <= 12; n++) {
  const name = `scan-${String(n).padStart(2, '0')}.png`;
  writeFileSync(join(outDir, name), makePage(n));
}
console.log('已生成 12 张测试扫描页于 test-fixtures/');
