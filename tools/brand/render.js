// Renders the brand art (tools/brand/*.svg) into the files the app and the installers use:
//   assets/icon.ico (16–256 px, Windows), assets/icon.png (1024 px: macOS .icns is made from it,
//   Linux), assets/logo.png (128 px: the phone client), assets/installer-sidebar.bmp (NSIS 164×314),
//   android/.../mipmap-*/ic_launcher.png (the phone app's launcher icon).
// Run: npx electron tools/brand/render.js   (each size is drawn from the SVG, so small icons stay sharp)
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const BRAND = __dirname;

// An SVG as a data URL, with the SVGs it embeds (href="x.svg") inlined: an <img> loads no files.
function svgData(name) {
  const text = fs.readFileSync(path.join(BRAND, name), 'utf8').replace(/href="([\w-]+\.svg)"/g, (_m, f) => `href="${svgData(f)}"`);
  return `data:image/svg+xml;base64,${Buffer.from(text).toString('base64')}`;
}

// One hidden page draws each SVG onto a canvas at the exact size and hands back a PNG.
let page = null;
async function render(svg, width, height) {
  if (!page) {
    page = new BrowserWindow({ show: false, width: 400, height: 400 });
    await page.loadURL('data:text/html,<!doctype html><title>render</title>');
  }
  const url = await page.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = ${width};
      c.height = ${height};
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, ${width}, ${height});
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('could not load ${svg}'));
    img.src = ${JSON.stringify(svgData(svg))};
  })`);
  return nativeImage.createFromDataURL(url);
}

// ICO with PNG-compressed entries (Windows Vista and later).
function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = 6 + 16 * pngs.length;
  const dir = [];
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    dir.push(e);
  }
  return Buffer.concat([header, ...dir, ...pngs.map((p) => p.data)]);
}

// 24-bit bottom-up BMP (what NSIS wants for its side panel), from a NativeImage (BGRA bitmap).
function bmp(img) {
  const { width, height } = img.getSize();
  const bgra = img.toBitmap();
  const row = Math.ceil((width * 3) / 4) * 4;
  const out = Buffer.alloc(54 + row * height);
  out.write('BM', 0);
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(row * height, 34);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      const d = 54 + (height - 1 - y) * row + x * 3;
      out[d] = bgra[s];
      out[d + 1] = bgra[s + 1];
      out[d + 2] = bgra[s + 2];
    }
  }
  return out;
}

app.whenReady().then(async () => {
  try {
    const sizes = [16, 24, 32, 48, 64, 128, 256];
    const pngs = [];
    for (const size of sizes) pngs.push({ size, data: (await render('icon.svg', size, size)).toPNG() });
    fs.writeFileSync(path.join(ROOT, 'assets', 'icon.ico'), ico(pngs));
    fs.writeFileSync(path.join(ROOT, 'assets', 'icon.png'), (await render('icon.svg', 1024, 1024)).toPNG());
    fs.writeFileSync(path.join(ROOT, 'assets', 'logo.png'), (await render('icon.svg', 128, 128)).toPNG());
    fs.writeFileSync(path.join(ROOT, 'assets', 'installer-sidebar.bmp'), bmp(await render('sidebar.svg', 164, 314)));
    const res = path.join(ROOT, 'android', 'app', 'src', 'main', 'res');
    for (const [dpi, size] of [['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]]) {
      fs.mkdirSync(path.join(res, `mipmap-${dpi}`), { recursive: true });
      fs.writeFileSync(path.join(res, `mipmap-${dpi}`, 'ic_launcher.png'), (await render('icon.svg', size, size)).toPNG());
      // The adaptive icon's foreground (108 dp: 2.25 × the legacy icon's size).
      const fg = Math.round(size * 2.25);
      fs.writeFileSync(path.join(res, `mipmap-${dpi}`, 'ic_launcher_foreground.png'), (await render('foreground.svg', fg, fg)).toPNG());
    }
    // The watch app's launcher icon (round on the watch face; same art).
    const wear = path.join(ROOT, 'android', 'wear', 'src', 'main', 'res');
    for (const [dpi, size] of [['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]]) {
      if (!fs.existsSync(path.join(wear, `mipmap-${dpi}`))) continue;
      fs.writeFileSync(path.join(wear, `mipmap-${dpi}`, 'ic_launcher.png'), (await render('icon.svg', size, size)).toPNG());
      const fg = Math.round(size * 2.25);
      fs.writeFileSync(path.join(wear, `mipmap-${dpi}`, 'ic_launcher_foreground.png'), (await render('foreground.svg', fg, fg)).toPNG());
    }
    console.log('rendered icon.ico, icon.png, logo.png, installer-sidebar.bmp and the Android launcher icons (phone and watch)');
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
  app.quit();
});
