'use strict';
/**
 * 生成应用图标。`npm run icon` 调用。
 *
 * 产出两处，用途不同：
 *   build/icon.ico        —— electron-builder 用（exe 与安装器的图标）
 *   assets/tray-*.png     —— 运行时托盘用
 *
 * 为什么托盘不复用 build/icon.ico：`build/` 是 electron-builder 的
 * buildResources 目录，其内容**不会**打进应用包，打包后读不到。
 * 托盘资源必须放在 files 覆盖的 assets/ 下。
 *
 * 本机没有 ImageMagick / sharp，所以借 Electron 自带的 Chromium 画 canvas
 * 取 PNG，再手工拼 ICO 容器（格式简单，见 buildIco）。
 *
 * 图案：深色圆角底 + 三根上行 K 线 + 白色折线箭头，
 * 配色取自 renderer/style.css 的 --bg / --up / --down，与界面一致。
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]; // 256 是 electron-builder 的硬性要求
const TRAY_SIZES = [16, 32]; // 托盘 1x / 2x，系统按 DPI 挑

/** 绘制函数。以字符串传进页面执行，返回 dataURL */
const DRAW = `
(size) => {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const x = c.getContext('2d');
  const S = size;
  const px = (v) => Math.round(v * S);

  const BG1 = '#1e2430', BG2 = '#141821';
  const UP = '#f5475f', DOWN = '#12b886';

  // —— 圆角底：半径 22%，接近 Windows 11 图标观感 ——
  const r = S * 0.22;
  const g = x.createLinearGradient(0, 0, 0, S);
  g.addColorStop(0, BG1);
  g.addColorStop(1, BG2);
  x.fillStyle = g;
  x.beginPath();
  x.moveTo(r, 0);
  x.lineTo(S - r, 0); x.quadraticCurveTo(S, 0, S, r);
  x.lineTo(S, S - r); x.quadraticCurveTo(S, S, S - r, S);
  x.lineTo(r, S);     x.quadraticCurveTo(0, S, 0, S - r);
  x.lineTo(0, r);     x.quadraticCurveTo(0, 0, r, 0);
  x.closePath();
  x.fill();

  // 深色任务栏上需要一点边界感
  if (S >= 32) {
    x.strokeStyle = 'rgba(255,255,255,0.10)';
    x.lineWidth = Math.max(1, S * 0.008);
    x.stroke();
  }

  // —— 三根 K 线，左低右高 ——
  const candles = [
    { cx: 0.265, bodyTop: 0.560, bodyBot: 0.760, wickTop: 0.500, wickBot: 0.815, up: false },
    { cx: 0.500, bodyTop: 0.400, bodyBot: 0.610, wickTop: 0.340, wickBot: 0.670, up: true  },
    { cx: 0.735, bodyTop: 0.240, bodyBot: 0.470, wickTop: 0.185, wickBot: 0.525, up: true  },
  ];
  const bodyW = S * 0.155;
  const wickW = Math.max(1, Math.round(S * 0.042));

  for (const k of candles) {
    x.fillStyle = k.up ? UP : DOWN;
    const cx = px(k.cx);
    const wx = Math.round(cx - wickW / 2);
    x.fillRect(wx, px(k.wickTop), wickW, px(k.wickBot) - px(k.wickTop));
    const bx = Math.round(cx - bodyW / 2);
    x.fillRect(bx, px(k.bodyTop), Math.max(2, Math.round(bodyW)), px(k.bodyBot) - px(k.bodyTop));
  }

  // —— 上行箭头：48px 以下会糊成一团，不画 ——
  if (S >= 48) {
    x.strokeStyle = 'rgba(255,255,255,0.92)';
    x.lineWidth = Math.max(1.5, S * 0.028);
    x.lineCap = 'round';
    x.lineJoin = 'round';
    x.beginPath();
    x.moveTo(px(0.20), px(0.415));
    x.lineTo(px(0.435), px(0.265));
    x.lineTo(px(0.63), px(0.345));
    x.lineTo(px(0.845), px(0.155));
    x.stroke();
    x.beginPath();
    x.moveTo(px(0.845), px(0.155));
    x.lineTo(px(0.700), px(0.150));
    x.moveTo(px(0.845), px(0.155));
    x.lineTo(px(0.850), px(0.300));
    x.stroke();
  }

  return c.toDataURL('image/png');
}
`;

/**
 * 拼 ICO 容器：6 字节文件头 + N×16 字节目录项 + N 段图像数据。
 * 图像段直接放 PNG（Vista 起原生支持），不必转 BMP。
 * 目录项的宽高各占 1 字节，256 要写 0。
 */
function buildIco(pngs) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); // reserved
  head.writeUInt16LE(1, 2); // 1 = icon
  head.writeUInt16LE(pngs.length, 4);

  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, buf } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); // 调色板数，真彩为 0
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // 色彩平面
    e.writeUInt16LE(32, 6); // 位深
    e.writeUInt32LE(buf.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += buf.length;
  }
  return Buffer.concat([head, ...entries, ...pngs.map((p) => p.buf)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('data:text/html,<html><body></body></html>');

  const render = async (size) => {
    const url = await win.webContents.executeJavaScript(`(${DRAW})(${size})`, true);
    return Buffer.from(url.split(',')[1], 'base64');
  };

  // —— build/icon.ico ——
  const pngs = [];
  for (const size of ICO_SIZES) pngs.push({ size, buf: await render(size) });
  const buildDir = path.join(ROOT, 'build');
  fs.mkdirSync(buildDir, { recursive: true });
  const ico = buildIco(pngs);
  fs.writeFileSync(path.join(buildDir, 'icon.ico'), ico);
  console.log(`  build/icon.ico          ${ico.length} bytes  (${ICO_SIZES.join('/')})`);

  // —— assets/tray-*.png ——
  const assetsDir = path.join(ROOT, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  for (const size of TRAY_SIZES) {
    const buf = pngs.find((p) => p.size === size).buf;
    fs.writeFileSync(path.join(assetsDir, `tray-${size}.png`), buf);
    console.log(`  assets/tray-${size}.png${size === 16 ? '  ' : '  '}      ${buf.length} bytes`);
  }

  app.quit();
});
