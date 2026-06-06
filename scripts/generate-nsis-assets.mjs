import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const outDir = join(root, "src-tauri", "installer");

const colors = {
  black: [8, 8, 8],
  panel: [16, 16, 16],
  panelSoft: [23, 23, 23],
  border: [46, 46, 46],
  amber: [201, 149, 42],
  amberDark: [82, 57, 10],
  white: [240, 240, 240],
  muted: [145, 145, 145],
};

const font = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  " ": ["000", "000", "000", "000", "000", "000", "000"],
};

function createImage(width, height, fill) {
  return {
    width,
    height,
    pixels: new Uint8Array(width * height * 3).fill(0).map((_, i) => fill[i % 3]),
  };
}

function idx(img, x, y) {
  return (y * img.width + x) * 3;
}

function blend(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function setPixel(img, x, y, color) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const p = idx(img, x, y);
  img.pixels[p] = color[0];
  img.pixels[p + 1] = color[1];
  img.pixels[p + 2] = color[2];
}

function rect(img, x, y, w, h, color) {
  for (let yy = y; yy < y + h; yy += 1) {
    for (let xx = x; xx < x + w; xx += 1) setPixel(img, xx, yy, color);
  }
}

function circle(img, cx, cy, radius, color) {
  const r2 = radius * radius;
  for (let y = cy - radius; y <= cy + radius; y += 1) {
    for (let x = cx - radius; x <= cx + radius; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) setPixel(img, x, y, color);
    }
  }
}

function ring(img, cx, cy, radius, stroke, color) {
  const outer = radius * radius;
  const inner = (radius - stroke) * (radius - stroke);
  for (let y = cy - radius; y <= cy + radius; y += 1) {
    for (let x = cx - radius; x <= cx + radius; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      const d = dx * dx + dy * dy;
      if (d <= outer && d >= inner) setPixel(img, x, y, color);
    }
  }
}

function roundedRect(img, x, y, w, h, r, color, borderColor) {
  for (let yy = y; yy < y + h; yy += 1) {
    for (let xx = x; xx < x + w; xx += 1) {
      const left = xx < x + r;
      const right = xx >= x + w - r;
      const top = yy < y + r;
      const bottom = yy >= y + h - r;
      let inside = true;
      if ((left || right) && (top || bottom)) {
        const cx = left ? x + r : x + w - r - 1;
        const cy = top ? y + r : y + h - r - 1;
        const dx = xx - cx;
        const dy = yy - cy;
        inside = dx * dx + dy * dy <= r * r;
      }
      if (inside) setPixel(img, xx, yy, color);
    }
  }

  if (!borderColor) return;
  rect(img, x + r, y, w - r * 2, 1, borderColor);
  rect(img, x + r, y + h - 1, w - r * 2, 1, borderColor);
  rect(img, x, y + r, 1, h - r * 2, borderColor);
  rect(img, x + w - 1, y + r, 1, h - r * 2, borderColor);
}

function line(img, x0, y0, x1, y1, color, width = 1) {
  const dx = Math.abs(x1 - x0);
  const sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0);
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;

  while (true) {
    circle(img, x, y, Math.max(0, Math.floor(width / 2)), color);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

function drawText(img, text, x, y, color, scale = 1) {
  let cursor = x;
  for (const ch of text.toUpperCase()) {
    const glyph = font[ch] ?? font[" "];
    for (let row = 0; row < glyph.length; row += 1) {
      for (let col = 0; col < glyph[row].length; col += 1) {
        if (glyph[row][col] !== "1") continue;
        rect(img, cursor + col * scale, y + row * scale, scale, scale, color);
      }
    }
    cursor += (glyph[0].length + 1) * scale;
  }
}

function drawSyncoraGlyph(img, x, y, size) {
  roundedRect(img, x, y, size, size, Math.round(size * 0.22), colors.panelSoft, colors.border);
  const cx = x + Math.round(size / 2);
  const cy = y + Math.round(size / 2);
  ring(img, cx, cy, Math.round(size * 0.28), Math.max(2, Math.round(size * 0.055)), colors.amber);
  circle(img, cx, cy, Math.round(size * 0.13), colors.amber);
  const pts = [
    [x + size * 0.31, y + size * 0.5],
    [x + size * 0.39, y + size * 0.5],
    [x + size * 0.44, y + size * 0.41],
    [x + size * 0.52, y + size * 0.58],
    [x + size * 0.58, y + size * 0.5],
    [x + size * 0.69, y + size * 0.5],
  ];
  for (let i = 0; i < pts.length - 1; i += 1) {
    line(
      img,
      Math.round(pts[i][0]),
      Math.round(pts[i][1]),
      Math.round(pts[i + 1][0]),
      Math.round(pts[i + 1][1]),
      colors.white,
      Math.max(2, Math.round(size * 0.045)),
    );
  }
}

function gradient(img, from, to) {
  for (let y = 0; y < img.height; y += 1) {
    const row = blend(from, to, y / Math.max(1, img.height - 1));
    rect(img, 0, y, img.width, 1, row);
  }
}

function toBmp(img) {
  const rowSize = Math.ceil((img.width * 3) / 4) * 4;
  const imageSize = rowSize * img.height;
  const fileSize = 54 + imageSize;
  const bmp = Buffer.alloc(fileSize);

  bmp.write("BM", 0);
  bmp.writeUInt32LE(fileSize, 2);
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(img.width, 18);
  bmp.writeInt32LE(img.height, 22);
  bmp.writeUInt16LE(1, 26);
  bmp.writeUInt16LE(24, 28);
  bmp.writeUInt32LE(0, 30);
  bmp.writeUInt32LE(imageSize, 34);
  bmp.writeInt32LE(2835, 38);
  bmp.writeInt32LE(2835, 42);

  let offset = 54;
  for (let y = img.height - 1; y >= 0; y -= 1) {
    for (let x = 0; x < img.width; x += 1) {
      const p = idx(img, x, y);
      bmp[offset] = img.pixels[p + 2];
      bmp[offset + 1] = img.pixels[p + 1];
      bmp[offset + 2] = img.pixels[p];
      offset += 3;
    }
    offset += rowSize - img.width * 3;
  }

  return bmp;
}

function header() {
  const img = createImage(150, 57, colors.black);
  gradient(img, [8, 8, 8], [20, 17, 11]);
  roundedRect(img, 4, 6, 142, 45, 10, colors.panel, colors.border);
  drawSyncoraGlyph(img, 13, 15, 27);
  drawText(img, "SYNCORA", 50, 20, colors.white, 2);
  rect(img, 5, 50, 140, 2, colors.amberDark);
  rect(img, 5, 52, 84, 1, colors.amber);
  return img;
}

function sidebar() {
  const img = createImage(164, 314, colors.black);
  gradient(img, [6, 6, 6], [16, 13, 8]);
  roundedRect(img, 13, 16, 138, 282, 16, colors.panel, colors.border);
  drawSyncoraGlyph(img, 48, 35, 68);
  drawText(img, "SYNCORA", 35, 125, colors.white, 2);
  drawText(img, "SETUP", 49, 148, colors.amber, 2);

  for (let i = 0; i < 9; i += 1) {
    const y = 194 + i * 10;
    const w = 28 + (i % 4) * 13;
    rect(img, 48, y, w, 3, i % 2 === 0 ? colors.amber : colors.border);
  }

  circle(img, 82, 262, 20, colors.amberDark);
  ring(img, 82, 262, 18, 3, colors.amber);
  line(img, 66, 262, 75, 262, colors.white, 3);
  line(img, 75, 262, 80, 253, colors.white, 3);
  line(img, 80, 253, 89, 273, colors.white, 3);
  line(img, 89, 273, 95, 262, colors.white, 3);
  line(img, 95, 262, 101, 262, colors.white, 3);

  return img;
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "nsis-header.bmp"), toBmp(header()));
writeFileSync(join(outDir, "nsis-sidebar.bmp"), toBmp(sidebar()));

console.log("Generated NSIS assets:");
console.log(`- ${join(outDir, "nsis-header.bmp")}`);
console.log(`- ${join(outDir, "nsis-sidebar.bmp")}`);
