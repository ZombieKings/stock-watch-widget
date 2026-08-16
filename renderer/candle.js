'use strict';

/**
 * 日/周/月 K 线绘制（原生 Canvas，无第三方库）。
 *
 * A 股约定：
 *   - 红涨绿跌（与欧美相反）
 *   - 实体 = 开收之间，上下影线 = 最高最低；开收相等画一条横线（十字星）
 *   - 实体颜色看「收 vs 开」（当期内涨跌），涨跌幅数字看「收 vs 前收」（跨期涨跌），
 *     两者含义不同，不能混用
 *   - MA5 白 / MA10 黄 / MA20 紫，与主流行情软件配色一致
 *
 * 与 chart.js 的分时图共用配色，但坐标系完全不同（分时以昨收对称展开，
 * K 线取真实高低范围），故独立成文件。
 */

const MA_STYLE = [
  { key: 'ma5', color: '#e8ecf3', label: 'MA5' },
  { key: 'ma10', color: '#f0b429', label: 'MA10' },
  { key: 'ma20', color: '#b07cf0', label: 'MA20' },
];

/**
 * 注意：index.html 用普通 <script> 加载，chart.js 与本文件**共享同一个全局作用域**。
 * 这里不能叫 COLOR——chart.js 已经用了这个名字，重名会让本文件整体抛
 * "Identifier 'COLOR' has already been declared" 而静默不加载。
 * 新增顶层常量前先确认 chart.js / renderer.js 没占用同名。
 */
const CANDLE_COLOR = {
  up: '#f5475f',
  down: '#12b886',
  flat: '#9aa4b2',
  grid: 'rgba(255, 255, 255, 0.07)',
  text: 'rgba(255, 255, 255, 0.45)',
  crosshair: 'rgba(255, 255, 255, 0.3)',
  volUp: 'rgba(245, 71, 95, 0.5)',
  volDown: 'rgba(18, 186, 134, 0.5)',
};

/**
 * 内边距。悬停命中判定要用同一套值，所以导出而非写死在函数里——
 * 两处各写一份数字，改了一处忘了另一处，十字线就会偏一根。
 */
const LAYOUT = {
  padL: 2,
  padR: 42, // 右侧价格刻度
  padB: 11, // 底部日期刻度
};

/** 绘图区宽度：与 drawCandleChart 内部算法一致，供命中判定复用 */
function plotWidth(cssW) {
  return (Number(cssW) || 300) - LAYOUT.padL - LAYOUT.padR;
}

/**
 * 纵轴范围：可见区高低点**并上均线**，再留 6% 余量。
 * 均线在图形左右两端常跑出高低点之外，不并进来会被画到框外。
 */
function computeRange(bars, maKeys = []) {
  let min = Infinity;
  let max = -Infinity;

  for (const b of bars || []) {
    if (Number.isFinite(b.high)) max = Math.max(max, b.high);
    if (Number.isFinite(b.low)) min = Math.min(min, b.low);
    for (const k of maKeys) {
      const v = b[k];
      if (Number.isFinite(v)) {
        max = Math.max(max, v);
        min = Math.min(min, v);
      }
    }
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;

  // 一字板：整段同价，给最小高度避免后续除零
  if (max - min < 1e-9) {
    const eps = Math.abs(max) * 0.005 || 0.01;
    return { min: min - eps, max: max + eps };
  }

  const pad = (max - min) * 0.06;
  return { min: min - pad, max: max + pad };
}

/**
 * 每根 K 线的横向几何：槽宽 = 可用宽 / 根数，实体宽留 1px 间隙。
 * 根数很多时槽宽可能小于 1px，实体宽兜到 1，画成密集竖线。
 */
function computeGeometry(plotW, count) {
  // 注意 Math.max(1, NaN) === NaN，不能靠它兜非法输入
  const raw = Math.round(Number(count));
  const n = Number.isFinite(raw) && raw > 0 ? raw : 1;
  const slot = plotW / n;
  const body = Math.max(1, Math.floor(slot - 1));
  return { slot, body: Math.min(body, 14) }; // 上限 14px，根数少时不至于胖成方块
}

/** 屏幕 x → 第几根（用于悬停读数）；超出范围返回 -1 */
function barIndexAtX(x, padL, plotW, count) {
  const n = Math.max(1, Math.round(count));
  if (!Number.isFinite(x) || x < padL || x > padL + plotW) return -1;
  const idx = Math.floor(((x - padL) / plotW) * n);
  return Math.min(n - 1, Math.max(0, idx));
}

/**
 * 缩放：可见根数的上下限。
 *
 * 下限 10 根——再少 K 线实体会胖到失去形态意义；上限 400 根受服务端约束
 * （klineClient 的 MAX_BARS=640，扣掉均线预热的 20 根还要留余量）。
 */
const ZOOM_MIN_BARS = 10;
const ZOOM_MAX_BARS = 400;

/** 每格滚轮的缩放倍率。1.25 手感接近各家行情软件，太大一格就跳过头 */
const ZOOM_STEP = 1.25;

/**
 * 算出滚轮缩放后的新可见根数。
 *
 * @param {number} current 当前可见根数
 * @param {number} deltaY 滚轮增量，向上滚（负值）= 放大 = 根数变少
 * @returns {number} 夹在 [ZOOM_MIN_BARS, ZOOM_MAX_BARS] 内的整数
 */
function zoomBarCount(current, deltaY) {
  const n = Math.round(Number(current));
  const base = Number.isFinite(n) && n > 0 ? n : 80;
  const d = Number(deltaY);
  if (!Number.isFinite(d) || d === 0) return clampBarCount(base);

  // 向上滚 deltaY<0：看得更细 → 根数变少
  const next = d < 0 ? base / ZOOM_STEP : base * ZOOM_STEP;
  // 必须先取整再夹：round 后可能与 base 相同（如 10*1.25=12.5→13 没问题，
  // 但 10/1.25=8→夹回 10），由调用方比较前后值决定要不要重画
  return clampBarCount(Math.round(next));
}

/** 把可见根数夹进合法区间 */
function clampBarCount(count) {
  const n = Math.round(Number(count));
  if (!Number.isFinite(n)) return ZOOM_MIN_BARS;
  return Math.min(ZOOM_MAX_BARS, Math.max(ZOOM_MIN_BARS, n));
}

/**
 * 缩放后重新定位可见窗口，让**光标下那根**尽量停在原处。
 *
 * 不锚定光标的话，缩放会像"整段数据往一边跑"，很难对准想看的位置。
 * 锚点用「光标在可见区内的相对位置」表示，缩放前后保持该比例不变。
 *
 * @param {object} p
 * @param {number} p.total 总根数（含均线预热段）
 * @param {number} p.oldFrom 原可见区起点下标
 * @param {number} p.oldCount 原可见根数
 * @param {number} p.newCount 新可见根数
 * @param {number|null} p.anchorRatio 光标在可见区内的比例 0..1；null/undefined 表示
 *        锚定右端（必须是 number 类型才当锚点，见函数内注释）
 * @returns {{ visibleFrom: number, visibleCount: number }}
 */
function rezoomWindow(p) {
  const total = Math.max(0, Math.round(Number(p && p.total)) || 0);
  const newCount = clampBarCount(p && p.newCount);
  if (total === 0) return { visibleFrom: 0, visibleCount: 0 };

  // 可见根数不能超过总根数
  const count = Math.min(newCount, total);
  const oldCount = Math.max(1, Math.round(Number(p.oldCount)) || 1);
  const oldFrom = Math.max(0, Math.round(Number(p.oldFrom)) || 0);

  // 锚点必须直接对原值判类型，**不能**先 Number() 转换：Number(null) === 0 且
  // Number.isFinite(0) 为真，于是「无光标」会被当成 ratio=0（锚定最左），
  // 缩放/重定位后可见区停在原起点，右端露不出最新一根——一进日/周K 就落在
  // 一屏之前的历史上。与 isHoverActive 是同一类坑。
  const ratio = typeof p.anchorRatio === 'number' ? p.anchorRatio : NaN;
  // 没有光标（键盘缩放、鼠标在绘图区外、或拉到新数据后重定位）时锚定最右侧——
  // 那是最新一根（当日/本周），用户最常关心的位置
  if (!Number.isFinite(ratio)) {
    return { visibleFrom: Math.max(0, total - count), visibleCount: count };
  }

  const clampedRatio = Math.min(1, Math.max(0, ratio));
  // 光标指向的绝对下标（可为小数，保留精度以免连续缩放时逐格漂移）
  const anchorAbs = oldFrom + clampedRatio * oldCount;
  let from = Math.round(anchorAbs - clampedRatio * count);

  // 夹进 [0, total-count]，保证可见区始终填满
  from = Math.min(Math.max(0, total - count), Math.max(0, from));
  return { visibleFrom: from, visibleCount: count };
}

/**
 * 拖拽位移换算成「平移几根」。
 *
 * 槽宽 = 可见区宽 / 可见根数，所以每根对应的像素数随缩放而变：放大（根数少、
 * 槽宽大）时同样的手移距离只该走几根，缩小时走很多根——按槽宽换算天然满足这点，
 * 手感是「抓着某根拖着走」，与各家行情软件一致。
 *
 * 返回的是「位移相当于几根」，符号与 dx 一致。方向由调用方决定：往右拖是把内容
 * 拽向右侧、露出更早的数据，所以 visibleFrom 要**减去**这个值。
 *
 * @param {number} dx 累计像素位移（右为正）
 * @param {number} plotW 绘图区宽度
 * @param {number} visibleCount 当前可见根数
 * @returns {number} 位移对应的根数（整数，可正可负）
 */
function dragBarShift(dx, plotW, visibleCount) {
  const d = Number(dx);
  const w = Number(plotW);
  const n = Math.round(Number(visibleCount));
  if (!Number.isFinite(d) || !Number.isFinite(w) || w <= 0) return 0;
  if (!Number.isFinite(n) || n <= 0) return 0;

  const slot = w / n;
  if (slot <= 0) return 0;
  // 向零取整：不足一个槽宽的抖动不该触发平移，否则贴着边界会持续重画
  const n2 = Math.trunc(d / slot);
  // Math.trunc(-0.5) 是 -0，归一成 0——调用方要拿返回值做等值判断
  return n2 === 0 ? 0 : n2;
}

/**
 * 平移可见窗口。可见根数不变，只挪起点，并夹在 [0, total-count] 内。
 *
 * @param {object} p
 * @param {number} p.total 总根数（含均线预热段）
 * @param {number} p.from 当前可见区起点下标
 * @param {number} p.count 可见根数
 * @param {number} p.shift 平移根数，负值向历史（左），正值向最新（右）
 * @param {number} [p.minFrom] 起点下界，默认 0。调用方用它挡住均线预热段——
 *        那几根算不出 MA20，露出来均线会断头
 * @returns {{ visibleFrom: number, visibleCount: number, atLeft: boolean, atRight: boolean }}
 *          atLeft/atRight 标记是否已顶到两端，供调用方决定要不要补拉数据
 */
function panWindow(p) {
  const total = Math.max(0, Math.round(Number(p && p.total)) || 0);
  if (total === 0) return { visibleFrom: 0, visibleCount: 0, atLeft: true, atRight: true };

  const count = Math.min(Math.max(1, Math.round(Number(p.count)) || 1), total);
  const from = Math.max(0, Math.round(Number(p.from)) || 0);
  const shift = Math.round(Number(p.shift)) || 0;

  const maxFrom = Math.max(0, total - count);
  // 下界不能超过上界：数据少到装不满一屏时 maxFrom 可能小于 minFrom，
  // 此时以 maxFrom 为准，否则会返回一个越过数组末尾的起点
  const minFrom = Math.min(maxFrom, Math.max(0, Math.round(Number(p.minFrom)) || 0));
  const next = Math.min(maxFrom, Math.max(minFrom, from + shift));

  return {
    visibleFrom: next,
    visibleCount: count,
    atLeft: next === minFrom,
    atRight: next === maxFrom,
  };
}

/**
 * 日期标签。
 *   60分 K：'2026-08-06 10:30' → '06 10:30'（日 + 时刻，跨日才看得出边界）
 *   日  K：'2026-08-06'        → '08-06'
 *   周/月K：                     → '26-08'
 */
function tickLabel(dateStr, period) {
  const s = String(dateStr || '');
  if (s.length < 10) return s;
  // 带时间部分的是分钟级 K，'YYYY-MM-DD HH:MM' 共 16 字符
  if (period === '60min' || s.length >= 16) return `${s.slice(8, 10)} ${s.slice(11, 16)}`;
  return period === 'day' ? s.slice(5) : s.slice(2, 7);
}

/**
 * 绘制 K 线图。
 * @param {HTMLCanvasElement} canvas
 * @param {object} data collectKline 的返回值；`visibleCount` 为缩放后的可见根数，
 *        缺省时取「从 visibleFrom 到末尾」（未缩放时的行为）
 * @param {{ hoverIndex?: number, cost?: number|null }} [opts] hoverIndex 是**可见区内**的下标；
 *        cost = 持仓成本价，画一条青色参照线
 * @returns {boolean} 是否画出了内容
 */
function drawCandleChart(canvas, data, opts = {}) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  const cssW = canvas.clientWidth || 300;
  const cssH = canvas.clientHeight || 120;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const all = (data && Array.isArray(data.bars) ? data.bars : []).filter(
    (b) => Number.isFinite(b.high) && Number.isFinite(b.low)
  );
  const from = Math.max(0, Math.min(all.length, Number(data && data.visibleFrom) || 0));
  // visibleCount 由缩放决定；未设时切到末尾，保持缩放前的行为
  const rawCount = Math.round(Number(data && data.visibleCount));
  const count = Number.isFinite(rawCount) && rawCount > 0 ? rawCount : all.length - from;
  const bars = all.slice(from, from + count);
  if (bars.length === 0) return false;

  const maKeys = MA_STYLE.map((m) => m.key);
  const rawRange = computeRange(bars, maKeys);
  if (!rawRange) return false;

  // 成本价并入纵轴。放在 computeRange 之外而不是加个参数：computeRange 的职责是
  // 「数据自身的范围」，成本价是用户输入，两者混在一起后者的放大上限策略会渗进
  // 一个纯几何函数里
  const costFit = window.StockAxis.fitCost(rawRange, opts && opts.cost);
  const range = { min: costFit.min, max: costFit.max };

  // 布局：价格 70%，量柱剩余，右侧留价格刻度，底部留日期
  const { padL, padR, padB } = LAYOUT;
  const priceH = Math.round((cssH - padB) * 0.7);
  const volTop = priceH + 4;
  const volH = cssH - padB - volTop;
  const plotW = plotWidth(cssW);

  const { slot, body } = computeGeometry(plotW, bars.length);
  const xOf = (i) => padL + slot * (i + 0.5);
  const yOf = (price) => {
    const ratio = (price - range.min) / (range.max - range.min);
    return priceH - ratio * priceH;
  };

  // —— 网格 ——
  ctx.strokeStyle = CANDLE_COLOR.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= 2; i += 1) {
    const y = Math.round((priceH * i) / 2) + 0.5;
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
  }
  ctx.stroke();

  drawVolume(ctx, bars, { xOf, body, volTop, volH });
  drawCandles(ctx, bars, { xOf, yOf, body, priceH });
  drawMaLines(ctx, bars, { xOf, yOf });
  drawAxis(ctx, { range, priceH, padL, plotW, bars, period: data && data.period, cssH, padB });

  // 成本参照线画在均线之后：MA20 的紫线与青色成本线容易压住彼此，
  // 后画的是用户自己的持仓成本，优先级更高
  window.StockAxis.drawCostLine(ctx, { fit: costFit, yOf, padL, plotW, priceH });

  if (isHoverActive(opts.hoverIndex, bars.length)) {
    const hover = opts.hoverIndex;
    drawCrosshair(ctx, bars[hover], { xOf, yOf, hover, priceH, volTop, volH, padL, plotW });
  }

  return true;
}

/**
 * 该不该画十字线。
 * 必须直接对原值判断——不能先 Number() 转换：Number(null) === 0 且
 * Number.isInteger(0) 为真，未悬停时传 null 会在第 0 根上留一条幽灵十字线。
 * @param {*} hoverIndex 可见区内下标；null / undefined 表示未悬停
 * @param {number} count 可见根数
 */
function isHoverActive(hoverIndex, count) {
  return Number.isInteger(hoverIndex) && hoverIndex >= 0 && hoverIndex < count;
}

/** 量柱：颜色跟随当根涨跌，与实体一致 */
function drawVolume(ctx, bars, g) {
  if (g.volH <= 4) return;
  let maxVol = 0;
  for (const b of bars) maxVol = Math.max(maxVol, Number(b.volume) || 0);
  if (maxVol <= 0) return;

  for (let i = 0; i < bars.length; i += 1) {
    const b = bars[i];
    const v = Number(b.volume) || 0;
    const h = Math.max(v > 0 ? 1 : 0, (v / maxVol) * g.volH);
    ctx.fillStyle = b.close >= b.open ? CANDLE_COLOR.volUp : CANDLE_COLOR.volDown;
    ctx.fillRect(g.xOf(i) - g.body / 2, g.volTop + (g.volH - h), g.body, h);
  }
}

/** 实体 + 影线。开收相等时画 1px 横线（十字星），不能画成零高矩形（不可见） */
function drawCandles(ctx, bars, g) {
  for (let i = 0; i < bars.length; i += 1) {
    const b = bars[i];
    const rising = b.close >= b.open;
    const color = b.close === b.open ? CANDLE_COLOR.flat : rising ? CANDLE_COLOR.up : CANDLE_COLOR.down;
    const x = g.xOf(i);

    // 影线：整根 K 的高低，落在实体中轴上
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const xw = Math.round(x) + 0.5;
    ctx.moveTo(xw, g.yOf(b.high));
    ctx.lineTo(xw, g.yOf(b.low));
    ctx.stroke();

    // 实体
    const yOpen = g.yOf(b.open);
    const yClose = g.yOf(b.close);
    const top = Math.min(yOpen, yClose);
    const h = Math.abs(yClose - yOpen);
    ctx.fillStyle = color;
    if (h < 1) {
      ctx.fillRect(x - g.body / 2, Math.round(top) + 0.5, g.body, 1);
    } else {
      ctx.fillRect(x - g.body / 2, top, g.body, h);
    }
  }
}

/** 均线：null 处断开，不能连成直线跨过空缺 */
function drawMaLines(ctx, bars, g) {
  for (const style of MA_STYLE) {
    ctx.strokeStyle = style.color;
    ctx.lineWidth = 1;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < bars.length; i += 1) {
      const v = bars[i][style.key];
      if (!Number.isFinite(v)) {
        started = false; // 断线，下一个有值的点重新起笔
        continue;
      }
      const x = g.xOf(i);
      const y = g.yOf(v);
      if (started) ctx.lineTo(x, y);
      else {
        ctx.moveTo(x, y);
        started = true;
      }
    }
    ctx.stroke();
  }
}

/** 右侧价格刻度 + 底部日期刻度 */
function drawAxis(ctx, g) {
  const axis = window.StockAxis;
  ctx.fillStyle = CANDLE_COLOR.text;
  ctx.font = axis.AXIS_FONT;

  // 右侧价格：顶、中、底。y 与 baseline 由 axis.js 统一给，
  // 原先顶档写 y=1 配 middle 基线，9px 字形上沿到 -4，被画布切掉 4 行
  ctx.textAlign = 'left';
  const decimals = g.range.max < 10 ? 3 : 2; // 低价股多给一位，否则三档显示成同一个数
  const textX = axis.tickTextX(g.padL, g.plotW);
  for (const slot of axis.tickSlots(g.priceH)) {
    const v = axis.tickValue(slot, g.range.min, g.range.max);
    ctx.textBaseline = slot.baseline;
    ctx.fillText(v.toFixed(decimals), textX, slot.y);
  }

  // 底部日期：首、中、末三个，够定位区间又不重叠
  ctx.textBaseline = 'bottom';
  const yBottom = g.cssH - 1;
  const picks = [0, Math.floor((g.bars.length - 1) / 2), g.bars.length - 1];
  const aligns = ['left', 'center', 'right'];
  const xs = [g.padL, g.padL + g.plotW / 2, g.padL + g.plotW];
  for (let i = 0; i < picks.length; i += 1) {
    const bar = g.bars[picks[i]];
    if (!bar) continue;
    // 根数太少时首末重合，跳过中间那个
    if (i === 1 && g.bars.length < 5) continue;
    ctx.textAlign = aligns[i];
    ctx.fillText(tickLabel(bar.date, g.period), xs[i], yBottom);
  }
}

/** 悬停十字线：竖线贯穿价格区与量柱区，横线在收盘价高度 */
function drawCrosshair(ctx, bar, g) {
  const x = Math.round(g.xOf(g.hover)) + 0.5;
  const y = Math.round(g.yOf(bar.close)) + 0.5;

  ctx.save();
  ctx.strokeStyle = CANDLE_COLOR.crosshair;
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 2]);
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, g.volTop + g.volH);
  ctx.moveTo(g.padL, y);
  ctx.lineTo(g.padL + g.plotW, y);
  ctx.stroke();
  ctx.restore();
}

// 双导出：浏览器里挂 window，Node 里可 require 做单测
// 注意：原 axisTicks 已移除。刻度取值统一走 axis.js 的 tickSlots + tickValue，
// 同一套几何留两个真相源，改一处忘另一处就会错位。
const API = {
  computeRange,
  computeGeometry,
  barIndexAtX,
  isHoverActive,
  tickLabel,
  plotWidth,
  zoomBarCount,
  clampBarCount,
  rezoomWindow,
  dragBarShift,
  panWindow,
  MA_STYLE,
  COLOR: CANDLE_COLOR,
  LAYOUT,
  ZOOM_MIN_BARS,
  ZOOM_MAX_BARS,
  ZOOM_STEP,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = API;
}
if (typeof window !== 'undefined') {
  window.StockCandle = { ...API, drawCandleChart };
}
