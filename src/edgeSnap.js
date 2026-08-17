'use strict';

/**
 * 边缘吸附与自动隐藏的几何计算。
 *
 * 行为分三步：
 *   1. 用户把窗口拖到工作区边缘附近（≤ SNAP_THRESHOLD）→ 对齐贴边（snapBounds）
 *   2. 贴边后鼠标离开窗口一段时间 → 窗口滑出屏幕，只留 PEEK 像素（hiddenBounds）
 *   3. 鼠标碰到那条露出的边 → 滑回来（触发带见 triggerZone）
 *
 * 与 windowLayout 同样抽成纯函数模块，理由也一样：这里有三处很容易写错，
 * 而它们都藏在「窗口跑到屏幕外找不回来」这种最难排查的症状后面。
 *
 *   1. 隐藏靠**移动**窗口（改 x/y）而不是**压窄**窗口（改 width）。
 *      压窄会撞上 Electron 那个 minimumSize 静默夹取 setBounds 的坑
 *      （见 windowLayout 顶部注释），而且 6px 宽的视口会让渲染层整体重排、
 *      Canvas 重画，滑回来时闪一下。移动窗口对渲染层完全透明。
 *
 *   2. 隐藏位置一定不能落盘。配置里的 bounds 必须始终是「显示态的位置」，
 *      否则下次启动窗口开在屏幕外，而它是 frame:false + skipTaskbar 的窗口，
 *      任务栏上没有入口，用户只能去删配置文件。拦截在 main.js 的 persistBounds。
 *
 *   3. 移出屏幕的前提是那条边确实是**虚拟桌面的外沿**（isOuterEdge）。
 *      多显示器横排时，主屏左边界的外侧是另一块屏 —— 往那边「藏」窗口只是把它
 *      挪到隔壁屏正中间，用户会以为挂件失控了。这种边只吸附、不自动隐藏。
 *
 * 只支持 left / right / top 三条边，**不做 bottom**：工作区下沿紧邻任务栏，
 * 露出的那几像素会与任务栏的自动隐藏触发带、窗口预览浮层抢鼠标，误触率高到
 * 让功能变成干扰。挂件贴左右两侧本来也是更常见的用法。
 */

/** 窗口边缘与工作区边缘的距离小于它就吸附。24px≈拖动时手感上的「差一点点」 */
const SNAP_THRESHOLD = 24;

/**
 * 隐藏后仍留在屏幕内的像素。
 *
 * 6px 是权衡：再窄就只剩一条发丝，用户看不见也想不起来它在哪；再宽就成了
 * 一条碍眼的色条。真正决定「好不好碰到」的是 triggerZone 的外扩量，不是这个值。
 */
const PEEK = 6;

/** 触发带在 peek 之外再放宽多少（含沿边方向的两端）。鼠标不必精确压在 6px 上 */
const TRIGGER_GROW = 6;

/** 判「鼠标已经离开窗口」时窗口矩形往外放宽多少，避免贴边像素上的抖动来回触发 */
const LEAVE_TOLERANCE = 8;

/** 鼠标离开后多久才藏起来。太短会在鼠标划过时误藏，太长则像没生效 */
const HIDE_DELAY_MS = 700;

/** 光标轮询间隔。只在「已吸附且开了自动隐藏」时才跑，平时定时器根本不存在 */
const POLL_MS = 150;

/** 滑入滑出的动画时长与帧间隔 */
const ANIM_MS = 130;
const ANIM_STEP_MS = 16;

/**
 * 启动后的宽限期：这段时间内不自动隐藏。
 *
 * 上次退出时窗口是贴边的，启动后会立刻判定为已吸附；若光标此刻不在窗口上，
 * 700ms 后它就滑走了 —— 用户看到的是「双击图标，闪一下就没了」，
 * 十成会当成启动失败。
 */
const GRACE_MS = 3000;

/** 支持吸附的边。不含 bottom，理由见模块注释 */
const EDGES = ['left', 'right', 'top'];

/**
 * 收成一个合法矩形，拿不到就返回 null。
 *
 * 与 windowLayout.normalizeRect 的「逐字段兜底」刻意不同：那边是在算窗口该多大，
 * 编一个默认尺寸出来总比开不出窗口好；这边是在算「往哪儿藏」，输入不可信时
 * 编一个矩形出来只会把窗口挪到某个算不清的地方。null 让调用方直接跳过，
 * 窗口留在原位 —— 功能失效，但不会失控。
 */
function toRect(raw) {
  if (raw == null || typeof raw !== 'object') return null;
  const num = (v) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? n : null;
  };
  const x = num(raw.x);
  const y = num(raw.y);
  const width = num(raw.width);
  const height = num(raw.height);
  if (x == null || y == null || width == null || height == null) return null;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function isEdge(edge) {
  return typeof edge === 'string' && EDGES.includes(edge);
}

function clamp(v, min, max) {
  // min > max 时（窗口比工作区还大）以 min 为准：宁可露出下沿，也不要负宽度的夹取结果
  if (max < min) return min;
  const n = Number(v);
  // NaN 会穿过 Math.min/Math.max 原样出来，把一个 NaN 坐标交给 setBounds
  // 会让窗口跳到一个算不清的地方 —— 回落到下限
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** 矩形四向放宽 m 像素 */
function expandRect(rect, m) {
  const r = toRect(rect);
  if (!r) return null;
  const g = Math.round(Number(m));
  const grow = Number.isFinite(g) ? g : 0;
  return {
    x: r.x - grow,
    y: r.y - grow,
    width: r.width + grow * 2,
    height: r.height + grow * 2,
  };
}

/** 点是否在矩形内（含右下边界，用闭区间——差一个像素的漏判在贴边场景很明显） */
function pointInRect(point, rect) {
  const r = toRect(rect);
  if (!r || point == null || typeof point !== 'object') return false;
  const x = Number(point.x);
  const y = Number(point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
}

/**
 * 窗口该吸附到哪条边。
 *
 * 距离用**带符号**的差值而不是绝对值：窗口已经越出工作区（差值为负）时更该被
 * 判为吸附 —— 那正是「上次藏在边上、这次配置被写坏了」需要复位的情形，
 * 用绝对值会让越界 500px 的窗口判成「不吸附」，永远留在屏幕外。
 *
 * 多条边同时满足时取距离最小的那条；平手时 left / right 胜过 top，
 * 因为顶部隐藏会把标题栏（唯一的拖拽区）一起藏走，取回窗口更费劲。
 *
 * @param {{ bounds: object, workArea: object, threshold?: number }} p
 * @returns {'left'|'right'|'top'|null}
 */
function detectEdge(p) {
  const b = toRect(p && p.bounds);
  const wa = toRect(p && p.workArea);
  if (!b || !wa) return null;

  const t = Math.round(Number(p && p.threshold));
  const threshold = Number.isFinite(t) ? t : SNAP_THRESHOLD;

  // 顺序即平手时的优先级
  const gaps = [
    ['left', b.x - wa.x],
    ['right', wa.x + wa.width - (b.x + b.width)],
    ['top', b.y - wa.y],
  ];

  let best = null;
  for (const [edge, gap] of gaps) {
    if (gap > threshold) continue;
    if (best === null || gap < best.gap) best = { edge, gap };
  }
  return best ? best.edge : null;
}

/**
 * 贴边对齐后的矩形。
 *
 * 沿边方向同时夹进工作区内：用户常常是「往右上角一甩」，松手时窗口有一半在
 * 屏幕外，只对齐 x 会留下一个上半截看不见的窗口。
 *
 * @param {{ bounds: object, workArea: object, edge: string }} p
 * @returns {object|null} 输入不合法时为 null（调用方跳过，窗口留在原位）
 */
function snapBounds(p) {
  const b = toRect(p && p.bounds);
  const wa = toRect(p && p.workArea);
  const edge = p && p.edge;
  if (!b || !wa || !isEdge(edge)) return null;

  const maxX = wa.x + wa.width - b.width;
  const maxY = wa.y + wa.height - b.height;

  let x = clamp(b.x, wa.x, maxX);
  let y = clamp(b.y, wa.y, maxY);

  if (edge === 'left') x = wa.x;
  else if (edge === 'right') x = maxX;
  else if (edge === 'top') y = wa.y;

  return { x, y, width: b.width, height: b.height };
}

/**
 * 藏起来之后的矩形：窗口整体移出工作区，只留 peek 像素在里面。
 *
 * 只改位置、不改尺寸 —— 这是整个功能能对渲染层完全透明的原因，
 * 也绕开了 minimumSize 会夹住 setBounds 的坑（见模块注释第 1 条）。
 *
 * @param {{ bounds: object, workArea: object, edge: string, peek?: number }} p
 */
function hiddenBounds(p) {
  const b = toRect(p && p.bounds);
  const wa = toRect(p && p.workArea);
  const edge = p && p.edge;
  if (!b || !wa || !isEdge(edge)) return null;

  const pk = Math.round(Number(p && p.peek));
  // peek 不能比窗口本身还大，否则「隐藏后的位置」会跑到显示位置的另一侧
  const peek = clamp(Number.isFinite(pk) ? pk : PEEK, 1, Math.min(b.width, b.height));

  if (edge === 'left') return { ...b, x: wa.x - (b.width - peek) };
  if (edge === 'right') return { ...b, x: wa.x + wa.width - peek };
  return { ...b, y: wa.y - (b.height - peek) };
}

/**
 * 唤回窗口的触发带（屏幕坐标）。
 *
 * 按**显示态**的矩形算沿边范围，而不是隐藏态的：两者在沿边方向上是同一段，
 * 但显示态那份是用户记得的位置（「我把它贴在右边中间」），读起来更直白。
 *
 * 两个方向都放宽 grow：只在垂直方向精确覆盖窗口高度的话，鼠标往边上一甩
 * 常常差几个像素，用户会以为功能坏了。
 *
 * @param {{ shown: object, workArea: object, edge: string, peek?: number, grow?: number }} p
 */
function triggerZone(p) {
  const shown = toRect(p && p.shown);
  const wa = toRect(p && p.workArea);
  const edge = p && p.edge;
  if (!shown || !wa || !isEdge(edge)) return null;

  const pk = Math.round(Number(p && p.peek));
  const peek = Number.isFinite(pk) ? pk : PEEK;
  const g = Math.round(Number(p && p.grow));
  const grow = Number.isFinite(g) ? g : TRIGGER_GROW;
  const band = Math.max(1, peek + grow);

  if (edge === 'top') {
    return {
      x: shown.x - grow,
      y: wa.y,
      width: shown.width + grow * 2,
      height: band,
    };
  }
  const x = edge === 'left' ? wa.x : wa.x + wa.width - band;
  return {
    x,
    y: shown.y - grow,
    width: band,
    height: shown.height + grow * 2,
  };
}

/**
 * 这条边是否是虚拟桌面的外沿（外侧没有别的显示器）。
 *
 * 只有外沿才能靠「把窗口移出去」来隐藏。多屏横排时主屏左边界的外侧是另一块屏，
 * 往那边移动只是把挂件挪到隔壁屏的正中间 —— 比不隐藏糟得多。
 *
 * 探测点取边缘外侧 2px、沿边方向取窗口中点：用中点而不是整条边，是因为相邻屏
 * 常常只覆盖部分范围（分辨率不同、上下错位），只要窗口正对着的那一段外侧有屏，
 * 移出去就会被看见。
 *
 * @param {{ shown: object, workArea: object, edge: string, displays?: Array }} p
 * @returns {boolean} 拿不到 displays 时保守返回 false（宁可不隐藏）
 */
function isOuterEdge(p) {
  const shown = toRect(p && p.shown);
  const wa = toRect(p && p.workArea);
  const edge = p && p.edge;
  if (!shown || !wa || !isEdge(edge)) return false;

  const displays = Array.isArray(p && p.displays) ? p.displays : null;
  if (!displays || displays.length === 0) return false;

  const midX = shown.x + Math.round(shown.width / 2);
  const midY = shown.y + Math.round(shown.height / 2);
  const probe =
    edge === 'left'
      ? { x: wa.x - 2, y: midY }
      : edge === 'right'
        ? { x: wa.x + wa.width + 2, y: midY }
        : { x: midX, y: wa.y - 2 };

  for (const d of displays) {
    // 用 bounds 而不是 workArea：任务栏占掉的那条也是「屏幕上看得见的地方」
    if (pointInRect(probe, d && d.bounds)) return false;
  }
  return true;
}

/** easeOutCubic：起步快、收尾稳，短距离滑动下比线性更像「贴上去」 */
function ease(t) {
  const x = clamp(Number(t), 0, 1);
  return 1 - Math.pow(1 - x, 3);
}

/**
 * 动画插值。只插位置，尺寸取终点值 —— 滑动过程中改尺寸会触发渲染层重排。
 *
 * @param {object} from 起点矩形
 * @param {object} to 终点矩形
 * @param {number} t 0~1，已缓动
 */
function lerpRect(from, to, t) {
  const a = toRect(from);
  const b = toRect(to);
  if (!b) return null;
  if (!a) return b;
  const k = clamp(Number(t), 0, 1);
  return {
    x: Math.round(a.x + (b.x - a.x) * k),
    y: Math.round(a.y + (b.y - a.y) * k),
    width: b.width,
    height: b.height,
  };
}

/**
 * 保证窗口在工作区里露出足够多，够用户抓住。
 *
 * 用在**启动时**：配置里的位置可能是上一版留下的隐藏位置，或者用户拔掉了那块
 * 副屏。窗口是无边框 + skipTaskbar 的，一旦开在屏幕外就没有任何入口能把它拖回来。
 *
 * 只在露出不足时才动，且尽量少动（分别夹 x 与 y）：位置是用户的选择，
 * 没坏就不要替他改。
 *
 * @param {{ bounds: object, workArea: object, minVisible?: number }} p
 * @returns {object|null} 合法时返回（可能未改动的）矩形
 */
function ensureVisible(p) {
  const b = toRect(p && p.bounds);
  const wa = toRect(p && p.workArea);
  if (!b) return null;
  if (!wa) return b;

  const mv = Math.round(Number(p && p.minVisible));
  const minVisible = Number.isFinite(mv) && mv > 0 ? mv : 48;

  const visibleW = Math.min(b.x + b.width, wa.x + wa.width) - Math.max(b.x, wa.x);
  const visibleH = Math.min(b.y + b.height, wa.y + wa.height) - Math.max(b.y, wa.y);

  const needX = visibleW < Math.min(minVisible, b.width);
  const needY = visibleH < Math.min(minVisible, b.height);
  if (!needX && !needY) return b;

  return {
    x: needX ? clamp(b.x, wa.x, wa.x + wa.width - b.width) : b.x,
    y: needY ? clamp(b.y, wa.y, wa.y + wa.height - b.height) : b.y,
    width: b.width,
    height: b.height,
  };
}

/** 两个矩形是否完全一致。用来省掉「值没变也 setBounds」引起的多余 moved/resized */
function sameRect(a, b) {
  const ra = toRect(a);
  const rb = toRect(b);
  if (!ra || !rb) return false;
  return ra.x === rb.x && ra.y === rb.y && ra.width === rb.width && ra.height === rb.height;
}

module.exports = {
  SNAP_THRESHOLD,
  PEEK,
  TRIGGER_GROW,
  LEAVE_TOLERANCE,
  HIDE_DELAY_MS,
  POLL_MS,
  ANIM_MS,
  ANIM_STEP_MS,
  GRACE_MS,
  EDGES,
  toRect,
  expandRect,
  pointInRect,
  detectEdge,
  snapBounds,
  hiddenBounds,
  triggerZone,
  isOuterEdge,
  ease,
  lerpRect,
  ensureVisible,
  sameRect,
};
