'use strict';

/**
 * 分时图绘制（原生 Canvas，无第三方库）。
 *
 * A 股分时图约定：
 *   - 纵轴以昨收为中心**对称**展开，涨跌幅上下等距，这样零轴恒在正中
 *   - 白线 = 价格，黄线 = 均价，中间虚线 = 昨收
 *   - 红涨绿跌（与欧美相反）
 *   - 横轴固定 240 分钟（09:30-11:30 + 13:00-15:00），未走完的时间留白
 */

/** 一个交易日的分时点数：上午 120 + 下午 120 */
const TOTAL_MINUTES = 240;

/**
 * 5 日分时的内边距。悬停命中判定要用同一套值，所以导出而非写死在函数里。
 * 右侧比单日分时宽：纵轴不再对称，刻度标的是价格而非涨跌幅，字更长。
 */
const MINUTE5D_LAYOUT = {
  padL: 2,
  padR: 42,
  padB: 11, // 底部日期刻度
};

/** 5 日分时绘图区宽度，供命中判定复用 */
function minute5dPlotWidth(cssW) {
  return (Number(cssW) || 300) - MINUTE5D_LAYOUT.padL - MINUTE5D_LAYOUT.padR;
}

const COLOR = {
  up: '#f5475f',
  down: '#12b886',
  flat: '#9aa4b2',
  avg: '#f0b429',
  grid: 'rgba(255, 255, 255, 0.07)',
  baseline: 'rgba(255, 255, 255, 0.28)',
  text: 'rgba(255, 255, 255, 0.45)',
  volUp: 'rgba(245, 71, 95, 0.5)',
  volDown: 'rgba(18, 186, 134, 0.5)',
  // 5 日分时的悬停十字线。原先漏了这个键：strokeStyle 赋 undefined 会被 Canvas
  // 静默忽略，于是十字线沿用上一次的 strokeStyle（均价线的黄色）
  crosshair: 'rgba(255, 255, 255, 0.3)',
};

/** 把 'HH:MM' 转为「距开盘的分钟序号」（0-239），午休时段折叠掉 */
function minuteIndex(hhmm) {
  const parts = String(hhmm || '').split(':');
  if (parts.length !== 2) return -1;
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return -1;

  const abs = h * 60 + m;
  const amOpen = 9 * 60 + 30;
  const amClose = 11 * 60 + 30;
  const pmOpen = 13 * 60;

  if (abs < amOpen) return 0;
  if (abs <= amClose) return abs - amOpen; // 0..120
  if (abs < pmOpen) return 120;
  return Math.min(TOTAL_MINUTES, 120 + (abs - pmOpen)); // 120..240
}

/** 纵轴范围：以昨收为中心，取「最大偏离」向外对称扩展 */
function computeScale(points, prevClose) {
  const base = Number(prevClose);
  if (!Number.isFinite(base) || base <= 0) return null;

  let maxDev = 0;
  for (const p of points) {
    if (Number.isFinite(p.price)) maxDev = Math.max(maxDev, Math.abs(p.price - base));
    if (Number.isFinite(p.avgPrice)) maxDev = Math.max(maxDev, Math.abs(p.avgPrice - base));
  }
  // 全程平盘时给个最小幅度，避免除零把线画到中轴之外
  if (maxDev <= 0) maxDev = base * 0.002;
  // 上下各留 8% 余量，线不贴边
  const pad = maxDev * 0.08;
  return { base, dev: maxDev + pad };
}

/**
 * 全局槽位：第 dayIdx 天的第 minuteIdx 分钟 → 0..(天数*240)。
 * 5 天拼成一条横轴，每天固定占 240 槽——当天没走完也占满，右侧留白，
 * 这样日界线的位置不随时间漂移。
 */
function slotIndex(dayIdx, minuteIdx) {
  return dayIdx * TOTAL_MINUTES + minuteIdx;
}

/**
 * 5 日分时纵轴范围：取 5 天所有价格与均价的高低点，留 6% 余量。
 *
 * 与单日分时的「昨收对称」不同——5 天跨度可达 ±30%，对称展开会浪费近一半画布。
 * 首日昨收并进范围，保证那条参照虚线一定在框内。
 * @param {Array<{ points: Array }>} days
 * @param {number|null} baseClose 首日昨收
 */
function computeMultiDayScale(days, baseClose) {
  let min = Infinity;
  let max = -Infinity;

  for (const day of Array.isArray(days) ? days : []) {
    for (const p of (day && day.points) || []) {
      if (Number.isFinite(p.price)) {
        min = Math.min(min, p.price);
        max = Math.max(max, p.price);
      }
      if (Number.isFinite(p.avgPrice)) {
        min = Math.min(min, p.avgPrice);
        max = Math.max(max, p.avgPrice);
      }
    }
  }

  // 参照虚线要在框内，否则它会被画到图外。
  // 注意不能直接 Number(baseClose)：Number(null) 是 0，会被当成 0 元的价格并进范围，
  // 把整条曲线压到画布底部
  const base = baseClose == null || baseClose === '' ? NaN : Number(baseClose);
  if (Number.isFinite(base)) {
    min = Math.min(min, base);
    max = Math.max(max, base);
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;

  // 全程一个价（停牌）时给个最小幅度，避免除零
  if (max - min < 1e-9) {
    const half = Math.max(Math.abs(max) * 0.002, 0.01);
    return { min: min - half, max: max + half };
  }

  const pad = (max - min) * 0.06;
  return { min: min - pad, max: max + pad };
}

/**
 * 反查：画布 x → { dayIdx, pointIdx }。供悬停读数用。
 *
 * 先由 x 反推全局槽位，再定位到天；天内按**点在该天的分钟槽**找最近的一个点，
 * 不能直接用数组下标——午休折叠后下标与槽位并非线性对应。
 * @returns {{ dayIdx: number, pointIdx: number }|null} 落在留白或框外时返回 null
 */
function hitTestMinute5d(x, padL, plotW, days) {
  const list = Array.isArray(days) ? days : [];
  if (list.length === 0 || !(plotW > 0)) return null;

  const totalSlots = list.length * TOTAL_MINUTES;
  const rel = (Number(x) - padL) / plotW;
  if (!Number.isFinite(rel) || rel < 0 || rel > 1) return null;

  const slot = rel * totalSlots;
  const dayIdx = Math.min(list.length - 1, Math.floor(slot / TOTAL_MINUTES));
  const within = slot - dayIdx * TOTAL_MINUTES;

  const points = (list[dayIdx] && list[dayIdx].points) || [];
  if (points.length === 0) return null;

  // 找分钟槽最接近的点。当天未走完时，落在右侧留白上就贴到最后一个点
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < points.length; i += 1) {
    const mi = minuteIndex(points[i].time);
    if (mi < 0) continue;
    const dist = Math.abs(mi - within);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best < 0 ? null : { dayIdx, pointIdx: best };
}

/**
 * 绘制分时图。
 * @param {HTMLCanvasElement} canvas
 * @param {{ points: Array, prevClose: number|null }} data
 * @param {{ cost?: number|null }} [opts] cost = 持仓成本价，画一条青色参照线
 */
function drawMinuteChart(canvas, data, opts = {}) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  // CSS 尺寸 → 物理像素，避免 HiDPI 下模糊
  const cssW = canvas.clientWidth || 300;
  const cssH = canvas.clientHeight || 120;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const points = (data && Array.isArray(data.points) ? data.points : []).filter((p) =>
    Number.isFinite(p.price)
  );
  const rawScale = computeScale(points, data && data.prevClose);
  if (!rawScale) return false;

  // 布局：价格区占 72%，量柱区占剩余，中间留 4px 间隙
  const axis = window.StockAxis;
  // 成本线可能撑大 dev，必须在算 padR 之前——刻度槽宽按 pctMax 的实测文本宽定，
  // 用放大前的 dev 去量，`-12.34%` 这种更长的串会被右沿切掉
  const costFit = axis.fitCostDev(rawScale, opts && opts.cost);
  const scale = { base: costFit.base, dev: costFit.dev };
  const padL = 2;
  // 右侧刻度槽按**实测文本宽**算，不能写死：涨跌幅串长度随幅度变化，
  // 原先固定 34 装不下 `+26.78%`（实测 34.88px），右沿被画布切掉
  const pctMax = (scale.dev / scale.base) * 100;
  ctx.font = axis.AXIS_FONT;
  const padR = axis.gutterWidth(
    Math.max(
      ctx.measureText(`+${pctMax.toFixed(2)}%`).width,
      ctx.measureText(`-${pctMax.toFixed(2)}%`).width,
      ctx.measureText('0.00%').width
    )
  );
  const priceH = Math.round(cssH * 0.72);
  const volTop = priceH + 4;
  const volH = cssH - volTop;
  const plotW = cssW - padL - padR;

  const xOf = (idx) => padL + (plotW * idx) / TOTAL_MINUTES;
  const yOf = (price) => {
    const ratio = (price - scale.base) / scale.dev; // -1..1
    return priceH / 2 - (ratio * priceH) / 2;
  };

  // —— 网格：横向 4 等分，纵向按 30 分钟 ——
  ctx.strokeStyle = COLOR.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= 4; i += 1) {
    const y = Math.round((priceH * i) / 4) + 0.5;
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
  }
  for (let m = 0; m <= TOTAL_MINUTES; m += 30) {
    const x = Math.round(xOf(m)) + 0.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, priceH);
  }
  ctx.stroke();

  // —— 昨收基准线（虚线） ——
  ctx.save();
  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = COLOR.baseline;
  ctx.beginPath();
  const yBase = Math.round(yOf(scale.base)) + 0.5;
  ctx.moveTo(padL, yBase);
  ctx.lineTo(padL + plotW, yBase);
  ctx.stroke();
  ctx.restore();

  // —— 午休分隔线 ——
  ctx.save();
  ctx.setLineDash([2, 4]);
  ctx.strokeStyle = COLOR.grid;
  ctx.beginPath();
  const xNoon = Math.round(xOf(120)) + 0.5;
  ctx.moveTo(xNoon, 0);
  ctx.lineTo(xNoon, priceH);
  ctx.stroke();
  ctx.restore();

  if (points.length === 0) return false;

  const last = points[points.length - 1];
  const lineColor =
    last.price > scale.base ? COLOR.up : last.price < scale.base ? COLOR.down : COLOR.flat;

  // —— 量柱 ——
  if (volH > 6) {
    let maxVol = 0;
    for (const p of points) maxVol = Math.max(maxVol, Number(p.volume) || 0);
    if (maxVol > 0) {
      const barW = Math.max(1, plotW / TOTAL_MINUTES - 0.4);
      let prevPrice = scale.base;
      for (const p of points) {
        const idx = minuteIndex(p.time);
        if (idx < 0) continue;
        const v = Number(p.volume) || 0;
        const h = Math.max(v > 0 ? 1 : 0, (v / maxVol) * volH);
        // 与上一分钟比较定色：这一分钟是买盘推动还是卖盘
        ctx.fillStyle = p.price >= prevPrice ? COLOR.volUp : COLOR.volDown;
        ctx.fillRect(xOf(idx) - barW / 2, volTop + (volH - h), barW, h);
        prevPrice = p.price;
      }
    }
  }

  // —— 价格线下方渐变填充 ——
  const grad = ctx.createLinearGradient(0, 0, 0, priceH);
  const rgb = lineColor === COLOR.up ? '245, 71, 95' : lineColor === COLOR.down ? '18, 186, 134' : '154, 164, 178';
  grad.addColorStop(0, `rgba(${rgb}, 0.22)`);
  grad.addColorStop(1, `rgba(${rgb}, 0.01)`);

  ctx.beginPath();
  let started = false;
  for (const p of points) {
    const idx = minuteIndex(p.time);
    if (idx < 0) continue;
    const x = xOf(idx);
    const y = yOf(p.price);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  }
  if (started) {
    // 收口到基准线形成闭合区域
    const lastIdx = minuteIndex(last.time);
    ctx.lineTo(xOf(lastIdx), yBase);
    ctx.lineTo(xOf(minuteIndex(points[0].time)), yBase);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
  }

  // —— 价格线 ——
  ctx.beginPath();
  started = false;
  for (const p of points) {
    const idx = minuteIndex(p.time);
    if (idx < 0) continue;
    const x = xOf(idx);
    const y = yOf(p.price);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 1.4;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // —— 均价线 ——
  const avgPoints = points.filter((p) => Number.isFinite(p.avgPrice));
  if (avgPoints.length > 1) {
    ctx.beginPath();
    started = false;
    for (const p of avgPoints) {
      const idx = minuteIndex(p.time);
      if (idx < 0) continue;
      const x = xOf(idx);
      const y = yOf(p.avgPrice);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.strokeStyle = COLOR.avg;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // —— 成本参照线 ——
  // 画在渐变与均价线之后：半透明渐变盖上去会把青色染成红/绿，而成本线的作用
  // 就是让人一眼看到「现价在成本上方还是下方」，被染色就失效了
  axis.drawCostLine(ctx, { fit: costFit, yOf, padL, plotW, priceH });

  // —— 右侧涨跌幅刻度 ——
  // 纵轴以昨收对称展开，所以顶=+pctMax、底=-pctMax，中间恒为 0
  ctx.fillStyle = COLOR.text;
  ctx.font = axis.AXIS_FONT;
  ctx.textAlign = 'left';
  const textX = axis.tickTextX(padL, plotW);
  for (const slot of axis.tickSlots(priceH)) {
    const v = axis.tickValue(slot, -pctMax, pctMax);
    ctx.textBaseline = slot.baseline;
    ctx.fillText(`${v > 0 ? '+' : ''}${v.toFixed(2)}%`, textX, slot.y);
  }

  return true;
}

/**
 * 绘制 5 日连续分时。
 *
 * 与单日分时的三点区别：
 *   1. 纵轴按实际高低点，不对称（见 computeMultiDayScale）
 *   2. 均价线**按日断开**——它是当日累计额÷当日累计股数，跨日硬连那段斜线没有含义
 *   3. 量柱跨 5 天用同一个 maxVol 归一，否则日间的量对比会失真
 *
 * @param {HTMLCanvasElement} canvas
 * @param {{ days: Array, baseClose: number|null }} data
 * @param {{ hover?: { dayIdx: number, pointIdx: number }|null, cost?: number|null }} [opts]
 * @returns {boolean} 是否画出了内容
 */
function drawMinute5dChart(canvas, data, opts = {}) {
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

  const days = (data && Array.isArray(data.days) ? data.days : []).filter(
    (d) => d && Array.isArray(d.points) && d.points.length > 0
  );
  if (days.length === 0) return false;

  const baseClose = data && data.baseClose != null ? Number(data.baseClose) : null;
  const rawScale = computeMultiDayScale(days, baseClose);
  if (!rawScale) return false;

  // 成本价并入纵轴（超出放大上限时改画边缘标记，见 axis.fitCost）
  const costFit = window.StockAxis.fitCost(rawScale, opts && opts.cost);
  const scale = { min: costFit.min, max: costFit.max };

  const { padL, padR, padB } = MINUTE5D_LAYOUT;
  const priceH = Math.round((cssH - padB) * 0.72);
  const volTop = priceH + 4;
  const volH = cssH - padB - volTop;
  const plotW = cssW - padL - padR;
  const totalSlots = days.length * TOTAL_MINUTES;

  const xOf = (slot) => padL + (plotW * slot) / totalSlots;
  const span = scale.max - scale.min;
  const yOf = (price) => priceH - ((price - scale.min) / span) * priceH;

  // —— 网格：横向 4 等分 ——
  ctx.strokeStyle = COLOR.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= 4; i += 1) {
    const y = Math.round((priceH * i) / 4) + 0.5;
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
  }
  ctx.stroke();

  // —— 午休虚线：每天中点 ——
  ctx.save();
  ctx.setLineDash([2, 4]);
  ctx.strokeStyle = COLOR.grid;
  ctx.beginPath();
  for (let d = 0; d < days.length; d += 1) {
    const x = Math.round(xOf(slotIndex(d, 120))) + 0.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, priceH);
  }
  ctx.stroke();
  ctx.restore();

  // —— 首日昨收参照虚线 ——
  let yBase = null;
  if (Number.isFinite(baseClose)) {
    yBase = Math.round(yOf(baseClose)) + 0.5;
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = COLOR.baseline;
    ctx.beginPath();
    ctx.moveTo(padL, yBase);
    ctx.lineTo(padL + plotW, yBase);
    ctx.stroke();
    ctx.restore();
  }

  // 末点相对首日昨收定色；没有昨收就跟首点比
  const lastDay = days[days.length - 1];
  const lastPoint = lastDay.points[lastDay.points.length - 1];
  const ref = Number.isFinite(baseClose) ? baseClose : days[0].points[0].price;
  const lineColor =
    lastPoint.price > ref ? COLOR.up : lastPoint.price < ref ? COLOR.down : COLOR.flat;

  // —— 量柱：5 天统一归一 ——
  if (volH > 6) {
    let maxVol = 0;
    for (const day of days) {
      for (const p of day.points) maxVol = Math.max(maxVol, Number(p.volume) || 0);
    }
    if (maxVol > 0) {
      const barW = Math.max(0.6, plotW / totalSlots - 0.2);
      for (let d = 0; d < days.length; d += 1) {
        // 每天第一根跟当日昨收比，不跟前一天末点比
        let prevPrice = Number.isFinite(days[d].prevClose) ? days[d].prevClose : days[d].points[0].price;
        for (const p of days[d].points) {
          const mi = minuteIndex(p.time);
          if (mi < 0) continue;
          const v = Number(p.volume) || 0;
          const h = Math.max(v > 0 ? 1 : 0, (v / maxVol) * volH);
          ctx.fillStyle = p.price >= prevPrice ? COLOR.volUp : COLOR.volDown;
          ctx.fillRect(xOf(slotIndex(d, mi)) - barW / 2, volTop + (volH - h), barW, h);
          prevPrice = p.price;
        }
      }
    }
  }

  // —— 价格线：全程连续，跨夜跳空作为真实信息保留 ——
  const pricePath = [];
  for (let d = 0; d < days.length; d += 1) {
    for (const p of days[d].points) {
      const mi = minuteIndex(p.time);
      if (mi < 0 || !Number.isFinite(p.price)) continue;
      pricePath.push([xOf(slotIndex(d, mi)), yOf(p.price)]);
    }
  }
  if (pricePath.length === 0) return false;

  // 线下渐变填充：收口到基准线（无昨收时收口到底边）
  const rgb =
    lineColor === COLOR.up ? '245, 71, 95' : lineColor === COLOR.down ? '18, 186, 134' : '154, 164, 178';
  const grad = ctx.createLinearGradient(0, 0, 0, priceH);
  grad.addColorStop(0, `rgba(${rgb}, 0.22)`);
  grad.addColorStop(1, `rgba(${rgb}, 0.01)`);

  const yFloor = yBase != null ? yBase : priceH;
  ctx.beginPath();
  ctx.moveTo(pricePath[0][0], pricePath[0][1]);
  for (let i = 1; i < pricePath.length; i += 1) ctx.lineTo(pricePath[i][0], pricePath[i][1]);
  ctx.lineTo(pricePath[pricePath.length - 1][0], yFloor);
  ctx.lineTo(pricePath[0][0], yFloor);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // —— 日界实线：一眼能数出 5 段 ——
  // 必须画在渐变**之后**：渐变是半透明红/绿，盖在日界线上会把它染成红色，
  // 视觉上就找不到日界了（价格贴近上沿时那一段尤其明显）。
  ctx.strokeStyle = COLOR.baseline;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let d = 1; d < days.length; d += 1) {
    const x = Math.round(xOf(slotIndex(d, 0))) + 0.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, volTop + volH);
  }
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(pricePath[0][0], pricePath[0][1]);
  for (let i = 1; i < pricePath.length; i += 1) ctx.lineTo(pricePath[i][0], pricePath[i][1]);
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 1.4;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // —— 均价线：每天一段，日界处不连 ——
  ctx.strokeStyle = COLOR.avg;
  ctx.lineWidth = 1;
  for (let d = 0; d < days.length; d += 1) {
    ctx.beginPath();
    let started = false;
    for (const p of days[d].points) {
      const mi = minuteIndex(p.time);
      if (mi < 0 || !Number.isFinite(p.avgPrice)) continue;
      const x = xOf(slotIndex(d, mi));
      const y = yOf(p.avgPrice);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    if (started) ctx.stroke();
  }

  drawMinute5dAxis(ctx, { days, scale, xOf, yOf, padL, padR, plotW, priceH, cssH, cssW, padB });

  // —— 成本参照线 ——
  window.StockAxis.drawCostLine(ctx, { fit: costFit, yOf, padL, plotW, priceH });

  // —— 十字线 ——
  const hover = opts && opts.hover;
  if (hover && days[hover.dayIdx]) {
    const point = days[hover.dayIdx].points[hover.pointIdx];
    const mi = point ? minuteIndex(point.time) : -1;
    if (point && mi >= 0) {
      const x = Math.round(xOf(slotIndex(hover.dayIdx, mi))) + 0.5;
      const y = Math.round(yOf(point.price)) + 0.5;
      ctx.save();
      ctx.strokeStyle = COLOR.crosshair;
      ctx.setLineDash([2, 2]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, volTop + volH);
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.restore();
    }
  }

  return true;
}

/** 右侧价格刻度 + 底部日期刻度 */
function drawMinute5dAxis(ctx, g) {
  const axis = window.StockAxis;
  ctx.fillStyle = COLOR.text;
  ctx.font = axis.AXIS_FONT;

  // 右侧：上/中/下三档价格。纵轴不对称，标涨跌幅会误导
  ctx.textAlign = 'left';
  const digits = g.scale.max >= 100 ? 1 : 2;
  const textX = axis.tickTextX(g.padL, g.plotW);
  for (const slot of axis.tickSlots(g.priceH)) {
    const v = axis.tickValue(slot, g.scale.min, g.scale.max);
    ctx.textBaseline = slot.baseline;
    ctx.fillText(v.toFixed(digits), textX, slot.y);
  }

  // 底部：每天中点标 MM-DD
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  for (let d = 0; d < g.days.length; d += 1) {
    const x = g.xOf(slotIndex(d, 120));
    const label = String(g.days[d].date || '').slice(5); // MM-DD
    if (label) ctx.fillText(label, x, g.cssH - 1);
  }
}

// —— 折叠态分时缩略图 ——

/** 缩略图横轴的最小跨度（分钟）。见 sparklineSpan 里的下限说明 */
const SPARK_MIN_SPAN = 30;

/**
 * 缩略图纵轴范围：贴着当日实际高低点，而**不是**像 computeScale 那样以昨收对称展开。
 *
 * 对称展开在 60x24 的小图里是浪费：一只涨 5% 的票，当日在 5.0%~5.2% 之间震荡，
 * 对称范围就是 ±5.2%，那条线会被顶到框子最上沿糊成一横道，看不出走势。
 * 缩略图的职责只有「今天走的形状」——涨跌方向与幅度已经由旁边的数字和颜色给出了。
 *
 * 昨收线只在落进可见范围内时才返回，跳空后一天没回来过就不画：
 * 一条永远贴在边框上的虚线不提供信息，还会吃掉本就不多的高度。
 *
 * @param {Array<{price: number}>} points
 * @param {number|null} prevClose
 * @returns {{min: number, max: number, base: number|null}|null}
 */
function sparklineScale(points, prevClose) {
  let min = Infinity;
  let max = -Infinity;
  for (const p of Array.isArray(points) ? points : []) {
    if (Number.isFinite(p.price)) {
      min = Math.min(min, p.price);
      max = Math.max(max, p.price);
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;

  const span = max - min;
  if (span <= 0) {
    // 全天一个价（次新股一字板、停牌前最后一笔）：撑开一条窄带，线落在正中而非除零
    const band = (Math.abs(max) || 1) * 0.002;
    min -= band;
    max += band;
  } else {
    // 上下各留 12%，线不贴边，最高最低点的圆角还能看出来
    const pad = span * 0.12;
    min -= pad;
    max += pad;
  }

  const base = Number(prevClose);
  return { min, max, base: Number.isFinite(base) && base > min && base < max ? base : null };
}

/**
 * 横轴分母：已走到的分钟数，最少按 SPARK_MIN_SPAN 算。
 *
 * 这里**故意不用** TOTAL_MINUTES——那是大图的做法，右侧留白表示「还没走完」。
 * 62px 宽的缩略图撑不起这个信息量：开盘一小时时 60/240 只占 15px，
 * 走势被压成一小段毛刺，而这个缩略图存在的唯一理由就是看走势形状。
 * 代价是横向比例随时间变，上午的图看着和整天一样宽——对一个拇指图可以接受，
 * 真要看时间轴展开就有大图。
 *
 * 开盘头几分钟用 lastIdx 当分母会把两三个点拉满全宽，抖得厉害，故设下限。
 */
function sparklineSpan(points) {
  let lastIdx = 0;
  for (const p of Array.isArray(points) ? points : []) {
    if (!Number.isFinite(p.price)) continue;
    const idx = minuteIndex(p.time);
    if (idx >= 0) lastIdx = Math.max(lastIdx, idx);
  }
  return Math.max(SPARK_MIN_SPAN, lastIdx);
}

/**
 * 缩略图折线坐标。左沿锚在开盘（槽 0）而不是首个数据点——
 * 首点偶尔不是 09:30（集合竞价缺失、数据源丢头几分钟），锚在首点会让
 * 左沿含义随数据漂移。
 *
 * @returns {Array<{x: number, y: number}>}
 */
function sparklinePoints(points, scale, w, h) {
  const out = [];
  if (!scale || !(scale.max > scale.min)) return out;
  const span = sparklineSpan(points);
  for (const p of Array.isArray(points) ? points : []) {
    if (!Number.isFinite(p.price)) continue;
    const idx = minuteIndex(p.time);
    if (idx < 0) continue;
    out.push({
      x: (w * Math.min(idx, span)) / span,
      y: h - ((p.price - scale.min) / (scale.max - scale.min)) * h,
    });
  }
  return out;
}

/**
 * 画折叠态的分时缩略图：只有价格线 + 昨收虚线 + 线下渐变 + 末点圆点。
 *
 * 没有复用 drawMinuteChart：那张图带量柱、网格、右侧刻度和午休分隔线，
 * 缩到 24px 高全糊成一片。这里是另一套取舍，不是同一张图的小号。
 *
 * @param {HTMLCanvasElement} canvas
 * @param {{points: Array, prevClose: number|null}} data
 * @param {{color?: string}} [opts] color 由调用方按涨跌额给，保证与旁边价格数字同色
 * @returns {boolean} 是否画出了内容（false 时调用方应把画布藏掉）
 */
function drawSparkline(canvas, data, opts = {}) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  const cssW = canvas.clientWidth || 62;
  const cssH = canvas.clientHeight || 24;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const raw = (data && Array.isArray(data.points) ? data.points : []).filter((p) =>
    Number.isFinite(p.price)
  );
  const scale = sparklineScale(raw, data && data.prevClose);
  if (!scale) return false;

  // 线宽 1，上下各让出 1px，否则最高/最低点的线会被画布边缘切掉半根
  const inset = 1;
  const plotH = Math.max(1, cssH - inset * 2);
  const pts = sparklinePoints(raw, scale, cssW, plotH).map((p) => ({ x: p.x, y: p.y + inset }));
  if (pts.length === 0) return false;

  const color = opts.color || COLOR.flat;

  // —— 昨收虚线 ——
  if (scale.base != null) {
    const yBase =
      Math.round(inset + plotH - ((scale.base - scale.min) / (scale.max - scale.min)) * plotH) + 0.5;
    ctx.save();
    ctx.setLineDash([2, 2]);
    ctx.strokeStyle = COLOR.baseline;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, yBase);
    ctx.lineTo(cssW, yBase);
    ctx.stroke();
    ctx.restore();
  }

  // —— 线下渐变 ——
  const rgb =
    color === COLOR.up ? '245, 71, 95' : color === COLOR.down ? '18, 186, 134' : '154, 164, 178';
  const grad = ctx.createLinearGradient(0, 0, 0, cssH);
  grad.addColorStop(0, `rgba(${rgb}, 0.30)`);
  grad.addColorStop(1, `rgba(${rgb}, 0.02)`);

  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (const p of pts) ctx.lineTo(p.x, p.y);
  const lastPt = pts[pts.length - 1];
  ctx.lineTo(lastPt.x, cssH);
  ctx.lineTo(pts[0].x, cssH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // —— 价格线 ——
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (const p of pts) ctx.lineTo(p.x, p.y);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // —— 末点：标出「现在走到哪」，盘中右侧大片留白时尤其需要 ——
  ctx.beginPath();
  ctx.arc(lastPt.x, lastPt.y, 1.5, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();

  return true;
}

// 双导出：浏览器里挂 window，Node 里可 require 做单测
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    minuteIndex,
    computeScale,
    slotIndex,
    computeMultiDayScale,
    hitTestMinute5d,
    minute5dPlotWidth,
    sparklineScale,
    sparklinePoints,
    sparklineSpan,
    SPARK_MIN_SPAN,
    TOTAL_MINUTES,
    MINUTE5D_LAYOUT,
    COLOR,
  };
}
if (typeof window !== 'undefined') {
  window.StockChart = {
    drawMinuteChart,
    drawMinute5dChart,
    drawSparkline,
    sparklineScale,
    sparklinePoints,
    sparklineSpan,
    minuteIndex,
    slotIndex,
    computeMultiDayScale,
    hitTestMinute5d,
    minute5dPlotWidth,
    TOTAL_MINUTES,
    MINUTE5D_LAYOUT,
    COLOR,
  };
}
