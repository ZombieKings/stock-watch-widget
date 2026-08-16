'use strict';

/**
 * 三视图（分时 / 5日 / 日周K）共用的刻度几何与叠加层。
 *
 * 「叠加层」目前只有成本价参考线：三张图的纵轴口径完全不同（分时对称、5日与
 * K线取真实高低），但成本线是同一条语义线，画法分散到三个文件里必然各自长出
 * 不同的虚线节奏、标签位置和配色。策略（fitCost*）与绘制（drawCostLine）
 * 都收在这里，各视图只负责把自己的 yOf 传进来。
 *
 * 为什么单独成文件：这套「顶/中/底三档刻度」的 y 与 baseline 原先在 chart.js
 * 与 candle.js 里各写一份，写法还不一样——分时与日周K 把顶档放在 y=1 配
 * baseline='middle'，而 9px 字形在 middle 基线下相对刻度 y 覆盖 -5..+1，于是
 * 上沿 4 行被画布切掉（整个字形只有 7 行，切掉一半多）；5 日那份放在 y=5
 * 反而没事。同一个几何常量散在三处、其中两处写错，正是抽出来的理由。
 *
 * 关键约定：**顶档用 baseline='top'、底档用 'bottom'**，而不是统一 'middle'
 * 再拿 y 去凑。这样字形恒落在 [0, priceH] 内，与字号无关，日后换字号也不会再切。
 *
 * 注意本文件整体包在 IIFE 里：三个渲染脚本都是普通 <script>，共享同一个全局
 * 作用域，顶层 const 会互相撞名（chart.js 的 COLOR 与 candle.js 撞过一次，
 * 导致整个文件静默不加载）。这里不留任何顶层标识符，只挂 window.StockAxis。
 */

(function () {
  /** 刻度字号。三处必须一致，否则同一套 y 坐标在不同视图下裁切表现不同 */
  const AXIS_FONT = '9px "Segoe UI", sans-serif';

  /**
   * 字形垂直占位，均为实测值（Electron 33 / Segoe UI 9px，见 axis.test.js 注释）。
   * middle 基线下相对刻度 y 覆盖 -RISE..+DROP，合计 RISE+DROP+1 行。
   */
  const GLYPH_RISE = 5;
  const GLYPH_DROP = 1;
  const GLYPH_H = GLYPH_RISE + GLYPH_DROP + 1;

  /** 相邻两档字形不重叠所需的最小价格区高度 */
  const MIN_H_FOR_3 = 2 * GLYPH_H + 2 * GLYPH_RISE; // 顶↔中、中↔底都要留开
  const MIN_H_FOR_2 = 2 * GLYPH_H;

  /**
   * 各档刻度的 y 与 baseline，顶→底降序。
   *
   * 价格区太矮时主动减档：三个 9px 字形叠在一起比少显示一档更难读。
   *
   * @param {number} priceH 价格区高度（0 与 priceH 都是可用行）
   * @returns {{ y: number, baseline: 'top'|'middle'|'bottom' }[]}
   */
  function tickSlots(priceH) {
    const h = Number(priceH);
    if (!Number.isFinite(h) || h <= 0) return [];

    const top = { y: 0, baseline: 'top', frac: 0 };
    if (h < MIN_H_FOR_2) return [top]; // 连顶底两档都放不下
    const bottom = { y: h, baseline: 'bottom', frac: 1 };
    if (h < MIN_H_FOR_3) return [top, bottom];
    return [top, { y: h / 2, baseline: 'middle', frac: 0.5 }, bottom];
  }

  /**
   * 该档应显示的数值。
   *
   * 用 frac 插值而非按下标取预制数组：减档时数组长度与档数不一致，
   * `values[1]` 会把中间值画到底档位置上——这是抽出本函数的直接原因。
   *
   * @param {{ frac: number }} slot
   * @param {number} min 价格区底端对应值
   * @param {number} max 价格区顶端对应值
   */
  function tickValue(slot, min, max) {
    const lo = Number(min);
    const hi = Number(max);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return NaN;
    return hi - slot.frac * (hi - lo);
  }

  /**
   * 某档字形实际占据的行区间，供单测验证「恒在框内」。
   * @returns {[number, number]} [上沿, 下沿]，均含
   */
  function glyphSpan(slot) {
    if (slot.baseline === 'top') return [slot.y, slot.y + GLYPH_H - 1];
    if (slot.baseline === 'bottom') return [slot.y - (GLYPH_H - 1), slot.y];
    return [slot.y - GLYPH_RISE, slot.y + GLYPH_DROP];
  }

  /**
   * 右侧刻度槽宽度。
   *
   * 3 是文本左侧呼吸位，2 是右侧余量——分时的 `+26.78%` 实测 34.88px，原先
   * padR=34 让右沿落在 507.9 而画布只有 504，横向同样被切。
   *
   * @param {number} maxTextW 最坏情况文本宽度（用 measureText 量）
   */
  function gutterWidth(maxTextW) {
    const w = Number(maxTextW);
    return (Number.isFinite(w) && w > 0 ? Math.ceil(w) : 0) + 5;
  }

  /** 文本左边缘 x：绘图区右沿 + 呼吸位 */
  function tickTextX(padL, plotW) {
    return padL + plotW + 3;
  }

  // —— 成本价参考线 ——

  /**
   * 成本线配色。青色是这套配色里唯一没被占用的方向：
   * 红/绿是涨跌，白是 MA5 与昨收虚线，黄是均价与 MA10，紫是 MA20。
   * 成本线**不按盈亏染红绿**——它是一条固定参照，颜色跟着盈亏变会让人误以为
   * 线的位置动了；盈亏方向由详情区那块持仓数字给。
   */
  const COST_COLOR = '#3bc9db';

  /**
   * 纵轴为容纳成本线最多允许放大到原跨度的几倍。
   *
   * 不能无条件并入：成本 10 元、今天在 20 元附近震荡时，把 10 并进范围会让
   * 当日 ±1% 的走势压成一条平线——为了一条参照线毁掉主图，得不偿失。
   * 超过这个倍数就改画边缘标记（见 fitCost 的 edge），信息不丢但主图不变形。
   *
   * 1.5 是按小窗实际高度定的：价格区约 80-110px，放大 1.5 倍后原走势仍占
   * 2/3 高度、形状可辨。再大就开始糊了。
   */
  const COST_MAX_EXPAND = 1.5;

  /**
   * 成本标签的字形高度（行）。实测「成本 100」在 9px 下 ascent 8 / descent 1 = 9 行，
   * 比刻度数字用的 GLYPH_H(=7，拉丁 '+26.78%') 高 2 行——标签带中文，不能共用那个常量。
   */
  const LABEL_GLYPH_H = 9;

  /**
   * 把成本价并入 [min, max] 纵轴范围。
   *
   * 供 5日分时与日/周K 用——它们的纵轴是真实高低区间。分时是「以昨收对称展开」
   * 的另一套口径，用 fitCostDev。
   *
   * @param {{min: number, max: number}} range 原始范围
   * @param {number|null} cost 成本价
   * @returns {{min: number, max: number, cost: number|null, edge: 'top'|'bottom'|null}}
   *   cost 为 null 表示不画（无成本价或数值非法）；edge 非 null 表示成本在框外，
   *   调用方应画边缘标记而不是横线
   */
  function fitCost(range, cost) {
    const lo = Number(range && range.min);
    const hi = Number(range && range.max);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { min: lo, max: hi, cost: null, edge: null };

    // Number(null) === 0，会被当成 0 元的成本价并进范围，把曲线压到框底
    const c = cost == null || cost === '' ? NaN : Number(cost);
    if (!Number.isFinite(c) || c <= 0) return { min: lo, max: hi, cost: null, edge: null };

    if (c >= lo && c <= hi) return { min: lo, max: hi, cost: c, edge: null };

    const span = hi - lo;
    // 全程一个价时 span 可能为 0（computeRange 已兜底，这里再防一层除零）
    if (!(span > 0)) return { min: lo, max: hi, cost: c, edge: c > hi ? 'top' : 'bottom' };

    // 并入后需要的跨度。留 4% 余量，线不贴着边框
    const need = c > hi ? c - lo : hi - c;
    if (need / span > COST_MAX_EXPAND) {
      return { min: lo, max: hi, cost: c, edge: c > hi ? 'top' : 'bottom' };
    }

    const pad = span * 0.04;
    return {
      min: c < lo ? c - pad : lo,
      max: c > hi ? c + pad : hi,
      cost: c,
      edge: null,
    };
  }

  /**
   * 单日分时版：纵轴以昨收为中心对称展开，所以只能调「半幅」dev。
   *
   * 对称是分时图的核心约定（零轴恒在正中、右侧涨跌幅刻度上下对称），为成本线
   * 破掉它，右侧刻度就得改成非对称的价格标，整张图的读法都变了。所以这里放大
   * 的是 dev 而非单边——代价是成本价离昨收 2% 时，dev 要撑到 2%+，当日 0.5%
   * 的振幅会被压扁，因此同一个 COST_MAX_EXPAND 上限在这里更容易触发，
   * 触发后走边缘标记。
   *
   * @param {{base: number, dev: number}} scale computeScale 的结果
   * @param {number|null} cost
   * @returns {{base: number, dev: number, cost: number|null, edge: 'top'|'bottom'|null}}
   */
  function fitCostDev(scale, cost) {
    const base = Number(scale && scale.base);
    const dev = Number(scale && scale.dev);
    if (!Number.isFinite(base) || !Number.isFinite(dev) || !(dev > 0)) {
      return { base, dev, cost: null, edge: null };
    }

    const c = cost == null || cost === '' ? NaN : Number(cost);
    if (!Number.isFinite(c) || c <= 0) return { base, dev, cost: null, edge: null };

    const need = Math.abs(c - base);
    if (need <= dev) return { base, dev, cost: c, edge: null };

    // 放大 4% 余量，与 fitCost 一致，否则线正好压在边框上
    const wanted = need * 1.04;
    if (wanted / dev > COST_MAX_EXPAND) {
      return { base, dev, cost: c, edge: c > base ? 'top' : 'bottom' };
    }
    return { base, dev: wanted, cost: c, edge: null };
  }

  /**
   * 成本价文本：去掉无意义的尾随零。
   *
   * parseCost 保留 4 位小数（基金净值 4 位），固定 toFixed(2) 会把 1.2345 显示成
   * 1.23，用户对不上自己填的数；固定 toFixed(4) 又让 10.00 变成 10.0000 占掉
   * 小窗里本就紧张的横向空间。
   */
  function formatCost(v) {
    // 又一处 Number(null)===0 的坑：不先挡住 null/'' 会把「未设成本价」显示成「成本 0」
    const n = v == null || v === '' ? NaN : Number(v);
    if (!Number.isFinite(n)) return '--';
    const fixed = n.toFixed(4);
    return fixed.replace(/\.?0+$/, '');
  }

  /**
   * 画成本参考线（或框外时的边缘标记）。
   *
   * 标签压在线的上方、贴左沿：右侧是价格刻度槽，标在那儿会和刻度数字叠在一起；
   * 贴左沿则只可能盖住走势线的一小段，且带一层半透明底衬保证可读。
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} g
   * @param {{cost: number|null, edge: string|null}} g.fit fitCost / fitCostDev 的结果
   * @param {(price: number) => number} g.yOf 价格 → y
   * @param {number} g.padL 绘图区左沿
   * @param {number} g.plotW 绘图区宽
   * @param {number} g.priceH 价格区高
   */
  function drawCostLine(ctx, g) {
    const fit = g && g.fit;
    if (!fit || fit.cost == null) return false;

    const label = `成本 ${formatCost(fit.cost)}`;
    ctx.save();
    ctx.font = AXIS_FONT;
    ctx.textAlign = 'left';

    // 框外：贴着对应边框标一行带箭头的文字。不画横线——画在边框上会被误读成
    // 「成本正好等于当前区间的极值」
    if (fit.edge) {
      const up = fit.edge === 'top';
      ctx.textBaseline = up ? 'top' : 'bottom';
      const text = up ? `${label} ↑` : `${label} ↓`;
      const y = up ? 1 : g.priceH - 1;
      drawCostLabel(ctx, text, g.padL + 2, y, up ? 'top' : 'bottom');
      ctx.restore();
      return true;
    }

    const y = Math.round(g.yOf(fit.cost)) + 0.5;
    ctx.setLineDash([5, 3]); // 比昨收虚线(3,3)节奏更长，两条虚线不会看混
    ctx.strokeStyle = COST_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(g.padL, y);
    ctx.lineTo(g.padL + g.plotW, y);
    ctx.stroke();
    ctx.setLineDash([]);

    // 线贴顶时标签会被切掉，翻到线下方。阈值按中文字形高（实测 9 行）而非 GLYPH_H：
    // 用 7 判断会在 y=8 时判定「放得下」，实际字顶落到 -1 被画布切掉
    const below = y < LABEL_GLYPH_H + 2;
    drawCostLabel(ctx, label, g.padL + 2, below ? y + 2 : y - 2, below ? 'top' : 'bottom');
    ctx.restore();
    return true;
  }

  /**
   * 标签底衬的字形盒，按 measureText 实测而**不是**套用 GLYPH_H。
   *
   * GLYPH_H=7 是拿拉丁串 '+26.78%' 量的（ascent 7 / descent 0），刻度数字用它没问题；
   * 但成本标签带中文，「成本 100」实测 ascent 8 / descent 1 共 9 行。用 GLYPH_H 定底衬
   * 会漏掉字顶那 1 行，K 线影线正好从这道 1px 缝里透出来切在字上——小图上肉眼可见。
   *
   * ascent/descent 是相对当前 textBaseline 的，所以必须先设好 baseline 再量。
   *
   * @returns {{x: number, y: number, w: number, h: number}} 含 1px 呼吸位的底衬矩形
   */
  function labelBox(ctx, text, x, y) {
    const m = ctx.measureText(text);
    // 老 Chromium / 非常规字体可能不给 actualBoundingBox*，回落到拉丁常量
    const up = Number.isFinite(m.actualBoundingBoxAscent) ? m.actualBoundingBoxAscent : GLYPH_H;
    const down = Number.isFinite(m.actualBoundingBoxDescent) ? m.actualBoundingBoxDescent : 0;
    return {
      x: x - 1,
      y: Math.floor(y - up) - 1,
      w: Math.ceil(m.width) + 2,
      h: Math.ceil(up + down) + 2,
    };
  }

  /**
   * 带底衬的成本标签。
   *
   * 底衬要接近不透明：0.62 在 K 线图上压不住——K 线占满整个宽度，左沿正是影线与
   * 三条均线最密的地方（9px 中文笔画本就细）。0.88 遮得住又不像贴了块补丁。
   */
  function drawCostLabel(ctx, text, x, y, baseline) {
    ctx.textBaseline = baseline;
    const box = labelBox(ctx, text, x, y);
    ctx.fillStyle = 'rgba(12, 16, 24, 0.88)';
    ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.fillStyle = COST_COLOR;
    ctx.fillText(text, x, y);
  }

  const api = {
    AXIS_FONT,
    GLYPH_RISE,
    GLYPH_DROP,
    GLYPH_H,
    MIN_H_FOR_2,
    MIN_H_FOR_3,
    tickSlots,
    tickValue,
    glyphSpan,
    gutterWidth,
    tickTextX,
    COST_COLOR,
    COST_MAX_EXPAND,
    LABEL_GLYPH_H,
    fitCost,
    fitCostDev,
    formatCost,
    drawCostLine,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.StockAxis = api;
})();
