'use strict';

/**
 * 技术指标趋势子图（原生 Canvas，无第三方库）。
 *
 * 四张独立小图，各自纵轴：
 *   MACD —— 零轴 + 红绿柱（hist）+ DIF/DEA 双线
 *   RSI  —— 三条周期线 + 70/30 参考虚线
 *   KDJ  —— K/D/J 三线 + 80/20 参考虚线
 *   BOLL —— 上/中/下轨 + 收盘价线
 *
 * 为什么不复用 candle.js：那边的坐标系绑着「高低价 + 量柱」两段式布局与右侧价格刻度，
 * 这里每张图只有一段、纵轴含义各不相同（有的固定 0..100，有的要含零轴），
 * 套用过去要塞满分支，不如各画各的。
 *
 * 顶层符号一律加 IND_ 前缀：renderer/ 下的脚本共享全局作用域，
 * 重名会让整个文件在解析期就抛错、静默不加载（见 groups.test.js 的卫兵测试）。
 */

const IND_COLOR = {
  up: '#f5475f',
  down: '#12b886',
  grid: 'rgba(255, 255, 255, 0.07)',
  zero: 'rgba(255, 255, 255, 0.22)',
  ref: 'rgba(255, 255, 255, 0.14)',
  text: 'rgba(255, 255, 255, 0.4)',
  dif: '#e8ecf3',
  dea: '#f0b429',
  rsi6: '#e8ecf3',
  rsi12: '#f0b429',
  rsi24: '#b07cf0',
  k: '#e8ecf3',
  d: '#f0b429',
  j: '#b07cf0',
  band: '#f0b429',
  close: '#e8ecf3',
};

/** 各子图内边距。右侧留出刻度数字的位置 */
const IND_PAD = { l: 2, r: 26, t: 4, b: 3 };

/**
 * 纵轴范围。
 *
 * @param {Array<number|null>} values 可含 null（预热不足）
 * @param {{ includeZero?: boolean, fixed?: [number, number], padPct?: number }} [opts]
 *   fixed       固定范围（RSI/KDJ 用 0..100，避免每次刷新纵轴跳动）
 *   includeZero 强制含零轴（MACD 用，否则柱子没有基准）
 *   padPct      上下余量，默认 8%
 * @returns {{ min: number, max: number } | null} 无有效值时返回 null
 */
function indRange(values, opts = {}) {
  const nums = (Array.isArray(values) ? values : []).filter((v) => Number.isFinite(v));
  if (nums.length === 0) return null;

  let min = Math.min(...nums);
  let max = Math.max(...nums);

  if (opts.includeZero) {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }

  // 全平（横盘或只有一个点）时人为撑开，否则 (v-min)/(max-min) 除零
  if (min === max) {
    const d = Math.abs(min) > 1 ? Math.abs(min) * 0.05 : 0.5;
    min -= d;
    max += d;
  }

  const pad = (max - min) * (opts.padPct == null ? 0.08 : opts.padPct);
  return { min: min - pad, max: max + pad };
}

/**
 * 把序列切成「连续有值」的分段。
 *
 * 预热不足的位置是 null，直接连线会跨过空洞画出一条假趋势；
 * 分段后各段独立 stroke，空洞处自然断开。
 *
 * @param {Array<number|null>} values
 * @returns {Array<Array<{ i: number, v: number }>>} 每段至少 1 个点
 */
function indSegments(values) {
  const out = [];
  let cur = null;

  (Array.isArray(values) ? values : []).forEach((v, i) => {
    if (Number.isFinite(v)) {
      if (!cur) {
        cur = [];
        out.push(cur);
      }
      cur.push({ i, v });
    } else {
      cur = null;
    }
  });

  return out;
}

/**
 * 刻度文字：绝对值小的多留小数，大的收紧，避免 26px 宽度里挤成一团。
 * 整数直接写整数 —— 参考线是 70/30/80/20，写成「70.0」白占一位还更难认。
 */
function indTick(v) {
  if (!Number.isFinite(v)) return '';
  if (Number.isInteger(v)) return String(v);
  const a = Math.abs(v);
  if (a >= 100) return String(Math.round(v));
  if (a >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

/** 有没有能画的值。长度非 0 不等于有数据：整段可能全是预热期的 null */
function indHasData(values) {
  return (Array.isArray(values) ? values : []).some((v) => Number.isFinite(v));
}

/**
 * 建立子图坐标系并画好背景（边框 + 参考线 + 右侧刻度）。
 * 返回 xOf/yOf 供各指标画自己的线。
 */
function indFrame(ctx, cssW, cssH, range, refs = []) {
  const { l, r, t, b } = IND_PAD;
  const plotW = cssW - l - r;
  const plotH = cssH - t - b;

  const yOf = (v) => t + plotH - ((v - range.min) / (range.max - range.min)) * plotH;
  const xOf = (i, n) => l + (n <= 1 ? plotW / 2 : (plotW * i) / (n - 1));

  // 参考线（RSI 的 70/30、KDJ 的 80/20、MACD 的零轴）
  for (const ref of refs) {
    const y = yOf(ref.v);
    if (y < t - 0.5 || y > t + plotH + 0.5) continue;

    ctx.save();
    ctx.strokeStyle = ref.strong ? IND_COLOR.zero : IND_COLOR.ref;
    ctx.lineWidth = 1;
    if (!ref.strong) ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(l, Math.round(y) + 0.5);
    ctx.lineTo(l + plotW, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.restore();

    if (ref.label !== false) {
      ctx.fillStyle = IND_COLOR.text;
      ctx.font = '8px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(indTick(ref.v), l + plotW + 3, y);
    }
  }

  return { xOf, yOf, plotW, plotH, top: t, left: l };
}

/** 画一条折线，null 处断开 */
function indLine(ctx, values, n, xOf, yOf, color, width = 1) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';

  for (const seg of indSegments(values)) {
    if (seg.length === 1) {
      // 孤立点画不出线，点一个 1px 方块，否则这根数据看起来像丢了
      ctx.fillStyle = color;
      ctx.fillRect(xOf(seg[0].i, n) - 0.5, yOf(seg[0].v) - 0.5, 1.5, 1.5);
      continue;
    }
    ctx.beginPath();
    seg.forEach((p, k) => {
      const x = xOf(p.i, n);
      const y = yOf(p.v);
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
}

/** canvas 尺寸对齐 DPR 并清屏，返回 CSS 像素尺寸 */
function indSetup(canvas) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 300;
  const cssH = canvas.clientHeight || 48;

  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  return { ctx, cssW, cssH };
}

/** 数据不足时给一句提示，而不是留一张空白画布让人以为坏了 */
function indEmpty(ctx, cssW, cssH, msg) {
  ctx.fillStyle = IND_COLOR.text;
  ctx.font = '9px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(msg || '数据不足', cssW / 2, cssH / 2);
}

/** MACD：零轴 + 红绿柱 + DIF/DEA */
function drawMacd(canvas, series) {
  const { ctx, cssW, cssH } = indSetup(canvas);
  const s = series || {};
  const n = (s.dif || []).length;
  if (n === 0) {
    indEmpty(ctx, cssW, cssH);
    return false;
  }

  // 三条共用一个纵轴：柱高与线的相对关系才有意义
  const range = indRange([...(s.dif || []), ...(s.dea || []), ...(s.macd || [])], {
    includeZero: true,
  });
  if (!range) {
    indEmpty(ctx, cssW, cssH);
    return false;
  }

  const { xOf, yOf, plotW } = indFrame(ctx, cssW, cssH, range, [
    { v: 0, strong: true, label: false },
  ]);

  // 柱宽按点距算，留 1px 缝；点太密时至少 1px
  const step = n > 1 ? plotW / (n - 1) : plotW;
  const bw = Math.max(1, Math.min(4, step - 1));
  const y0 = yOf(0);

  (s.macd || []).forEach((v, i) => {
    if (!Number.isFinite(v)) return;
    const x = xOf(i, n);
    const y = yOf(v);
    ctx.fillStyle = v >= 0 ? IND_COLOR.up : IND_COLOR.down;
    // 高度不足 1px 的柱子（接近零轴）也要看得见，否则金叉附近一片空白
    const h = Math.max(1, Math.abs(y - y0));
    ctx.fillRect(x - bw / 2, Math.min(y, y0), bw, h);
  });

  indLine(ctx, s.dif, n, xOf, yOf, IND_COLOR.dif);
  indLine(ctx, s.dea, n, xOf, yOf, IND_COLOR.dea);
  return true;
}

/** RSI：三周期 + 70/30 */
function drawRsi(canvas, series) {
  const { ctx, cssW, cssH } = indSetup(canvas);
  const s = series || {};
  const n = (s.rsi6 || []).length;
  if (n === 0) {
    indEmpty(ctx, cssW, cssH);
    return false;
  }

  // 纵轴固定，所以画得出框 —— 但整段全 null 时框里一条线也没有，
  // 那是「没数据」不是「走势平」，得跟空序列一样给提示
  if (!indHasData(s.rsi6) && !indHasData(s.rsi12) && !indHasData(s.rsi24)) {
    indEmpty(ctx, cssW, cssH);
    return false;
  }

  // 固定 0..100：RSI 本身就是有界的，跟着数据缩放会让「70 线」每次都在不同高度
  const range = { min: 0, max: 100 };
  const { xOf, yOf } = indFrame(ctx, cssW, cssH, range, [{ v: 70 }, { v: 30 }]);

  indLine(ctx, s.rsi24, n, xOf, yOf, IND_COLOR.rsi24);
  indLine(ctx, s.rsi12, n, xOf, yOf, IND_COLOR.rsi12);
  indLine(ctx, s.rsi6, n, xOf, yOf, IND_COLOR.rsi6);
  return true;
}

/** KDJ：K/D/J + 80/20。J 可超出 [0,100]，故纵轴跟数据走 */
function drawKdj(canvas, series) {
  const { ctx, cssW, cssH } = indSetup(canvas);
  const s = series || {};
  const n = (s.k || []).length;
  if (n === 0) {
    indEmpty(ctx, cssW, cssH);
    return false;
  }

  // J = 3K-2D，常冲到 -20 或 120，钉死 0..100 会把它削平在边框上
  const range = indRange([...(s.k || []), ...(s.d || []), ...(s.j || [])], { padPct: 0.06 });
  if (!range) {
    indEmpty(ctx, cssW, cssH);
    return false;
  }

  const { xOf, yOf } = indFrame(ctx, cssW, cssH, range, [{ v: 80 }, { v: 20 }]);

  indLine(ctx, s.j, n, xOf, yOf, IND_COLOR.j);
  indLine(ctx, s.d, n, xOf, yOf, IND_COLOR.d);
  indLine(ctx, s.k, n, xOf, yOf, IND_COLOR.k);
  return true;
}

/** BOLL：上中下轨 + 收盘价 */
function drawBoll(canvas, series) {
  const { ctx, cssW, cssH } = indSetup(canvas);
  const s = series || {};
  const n = (s.close || []).length;
  if (n === 0) {
    indEmpty(ctx, cssW, cssH);
    return false;
  }

  const range = indRange([...(s.up || []), ...(s.low || []), ...(s.close || [])], { padPct: 0.05 });
  if (!range) {
    indEmpty(ctx, cssW, cssH);
    return false;
  }

  // 不给参考线：BOLL 没有 70/30 那样的固定阈值，画一条居中横线只会被
  // 误读成中轨（真正的中轨在下面按数据画）
  const { xOf, yOf } = indFrame(ctx, cssW, cssH, range, []);

  // 上下轨用虚线：三条实线加收盘价共四条，实线太满看不清哪条是价格
  ctx.save();
  ctx.setLineDash([2, 2]);
  indLine(ctx, s.up, n, xOf, yOf, IND_COLOR.band);
  indLine(ctx, s.low, n, xOf, yOf, IND_COLOR.band);
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = 0.55;
  indLine(ctx, s.mid, n, xOf, yOf, IND_COLOR.band);
  ctx.restore();

  indLine(ctx, s.close, n, xOf, yOf, IND_COLOR.close, 1.2);
  return true;
}

const IND_API = {
  drawMacd,
  drawRsi,
  drawKdj,
  drawBoll,
  indRange,
  indSegments,
  indTick,
  indHasData,
  IND_PAD,
  IND_COLOR,
};

if (typeof module !== 'undefined' && module.exports) module.exports = IND_API;
if (typeof window !== 'undefined') window.StockIndChart = IND_API;
