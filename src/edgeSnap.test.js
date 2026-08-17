'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  SNAP_THRESHOLD,
  PEEK,
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
} = require('./edgeSnap');

/** 一块 1920x1080 的主屏，任务栏占掉底部 40px */
const WA = { x: 0, y: 0, width: 1920, height: 1040 };
/** 挂件默认尺寸（与 windowLayout 的 WIN_W/WIN_H 同量级） */
const W = 340;
const H = 580;

const at = (x, y) => ({ x, y, width: W, height: H });

// —— toRect ——

test('toRect 缺字段返回 null，而不是编一个矩形出来', () => {
  for (const bad of [null, undefined, 'x', 42, [], {}, { x: 0, y: 0, width: 10 }]) {
    assert.equal(toRect(bad), null);
  }
});

test('toRect 拒绝非正尺寸：宽 0 的窗口算不出该往哪藏', () => {
  assert.equal(toRect({ x: 0, y: 0, width: 0, height: 100 }), null);
  assert.equal(toRect({ x: 0, y: 0, width: 100, height: -5 }), null);
});

test('toRect 取整', () => {
  assert.deepEqual(toRect({ x: 1.6, y: 2.4, width: 340.5, height: 580.2 }), {
    x: 2,
    y: 2,
    width: 341,
    height: 580,
  });
});

// —— pointInRect / expandRect ——

test('pointInRect 边界算命中，差一个像素的漏判在贴边场景很明显', () => {
  const r = { x: 10, y: 10, width: 100, height: 50 };
  assert.equal(pointInRect({ x: 10, y: 10 }, r), true);
  assert.equal(pointInRect({ x: 110, y: 60 }, r), true);
  assert.equal(pointInRect({ x: 111, y: 60 }, r), false);
  assert.equal(pointInRect({ x: 9, y: 30 }, r), false);
});

test('pointInRect 非法输入一律不命中', () => {
  const r = { x: 0, y: 0, width: 10, height: 10 };
  assert.equal(pointInRect(null, r), false);
  assert.equal(pointInRect({ x: 'a', y: 1 }, r), false);
  assert.equal(pointInRect({ x: 1, y: 1 }, null), false);
});

test('expandRect 四向放宽', () => {
  assert.deepEqual(expandRect({ x: 10, y: 20, width: 100, height: 50 }, 5), {
    x: 5,
    y: 15,
    width: 110,
    height: 60,
  });
});

// —— detectEdge ——

test('detectEdge 贴左侧：差 10px 在阈值内', () => {
  assert.equal(detectEdge({ bounds: at(10, 300), workArea: WA }), 'left');
});

test('detectEdge 贴右侧', () => {
  const x = WA.width - W - 10;
  assert.equal(detectEdge({ bounds: at(x, 300), workArea: WA }), 'right');
});

test('detectEdge 贴顶部', () => {
  assert.equal(detectEdge({ bounds: at(800, 8), workArea: WA }), 'top');
});

test('detectEdge 屏幕中央不吸附', () => {
  assert.equal(detectEdge({ bounds: at(800, 300), workArea: WA }), null);
});

test('detectEdge 不认底边：工作区下沿的触发带会与任务栏抢鼠标', () => {
  const y = WA.height - H; // 正好贴着工作区下沿
  assert.equal(detectEdge({ bounds: at(800, y), workArea: WA }), null);
});

test('detectEdge 越出工作区的窗口仍判为吸附：那正是需要复位的情形', () => {
  // 差值为负。用绝对值的话越界 500px 会被判成「不吸附」，窗口永远留在屏幕外
  assert.equal(detectEdge({ bounds: at(-500, 300), workArea: WA }), 'left');
  assert.equal(detectEdge({ bounds: at(800, -400), workArea: WA }), 'top');
});

test('detectEdge 取距离最小的那条边', () => {
  // 左边差 20，顶部差 4 → 顶部更近
  assert.equal(detectEdge({ bounds: at(20, 4), workArea: WA }), 'top');
  // 左边差 2，顶部差 20 → 左边更近
  assert.equal(detectEdge({ bounds: at(2, 20), workArea: WA }), 'left');
});

test('detectEdge 平手时左右胜过顶部：顶部隐藏会把拖拽区一起藏走', () => {
  assert.equal(detectEdge({ bounds: at(5, 5), workArea: WA }), 'left');
});

test('detectEdge 阈值可覆盖', () => {
  assert.equal(detectEdge({ bounds: at(40, 300), workArea: WA }), null);
  assert.equal(detectEdge({ bounds: at(40, 300), workArea: WA, threshold: 60 }), 'left');
});

test('detectEdge 输入不合法返回 null', () => {
  assert.equal(detectEdge({ bounds: null, workArea: WA }), null);
  assert.equal(detectEdge({ bounds: at(10, 10), workArea: null }), null);
  assert.equal(detectEdge(null), null);
});

test('detectEdge 副屏工作区的坐标是负的，仍按相对位置判', () => {
  const left = { x: -1920, y: 0, width: 1920, height: 1040 };
  assert.equal(detectEdge({ bounds: at(-1915, 300), workArea: left }), 'left');
  assert.equal(detectEdge({ bounds: at(-1000, 300), workArea: left }), null);
});

// —— snapBounds ——

test('snapBounds 左侧对齐到工作区左沿', () => {
  const r = snapBounds({ bounds: at(10, 300), workArea: WA, edge: 'left' });
  assert.equal(r.x, WA.x);
  assert.equal(r.y, 300);
  assert.equal(r.width, W);
  assert.equal(r.height, H);
});

test('snapBounds 右侧对齐：右边框贴上工作区右沿', () => {
  const r = snapBounds({ bounds: at(1500, 300), workArea: WA, edge: 'right' });
  assert.equal(r.x + r.width, WA.x + WA.width);
});

test('snapBounds 顶部对齐，x 不动', () => {
  const r = snapBounds({ bounds: at(800, 8), workArea: WA, edge: 'top' });
  assert.equal(r.y, WA.y);
  assert.equal(r.x, 800);
});

test('snapBounds 沿边方向也夹回工作区内：往右上角一甩不该留半截在屏幕外', () => {
  const r = snapBounds({ bounds: at(1900, -200), workArea: WA, edge: 'right' });
  assert.equal(r.x + r.width, WA.x + WA.width);
  assert.equal(r.y, WA.y); // -200 被夹回顶部
});

test('snapBounds 贴左时下沿也不越界', () => {
  const r = snapBounds({ bounds: at(5, 1000), workArea: WA, edge: 'left' });
  assert.equal(r.y + r.height, WA.y + WA.height);
});

test('snapBounds 窗口比工作区还高时以顶部为准，不产出负值夹取', () => {
  const tall = { x: 5, y: 100, width: W, height: 2000 };
  const r = snapBounds({ bounds: tall, workArea: WA, edge: 'left' });
  assert.equal(r.y, WA.y);
  assert.equal(r.height, 2000);
});

test('snapBounds 非法边或非法输入返回 null，调用方跳过', () => {
  assert.equal(snapBounds({ bounds: at(10, 10), workArea: WA, edge: 'bottom' }), null);
  assert.equal(snapBounds({ bounds: at(10, 10), workArea: WA, edge: null }), null);
  assert.equal(snapBounds({ bounds: null, workArea: WA, edge: 'left' }), null);
});

// —— hiddenBounds ——

test('hiddenBounds 左侧：只留 peek 在工作区内', () => {
  const shown = snapBounds({ bounds: at(0, 300), workArea: WA, edge: 'left' });
  const h = hiddenBounds({ bounds: shown, workArea: WA, edge: 'left' });
  assert.equal(h.x + h.width, WA.x + PEEK);
});

test('hiddenBounds 右侧：左边框停在工作区右沿往里 peek 处', () => {
  const shown = snapBounds({ bounds: at(1600, 300), workArea: WA, edge: 'right' });
  const h = hiddenBounds({ bounds: shown, workArea: WA, edge: 'right' });
  assert.equal(h.x, WA.x + WA.width - PEEK);
});

test('hiddenBounds 顶部：只留 peek 在下面', () => {
  const shown = snapBounds({ bounds: at(800, 0), workArea: WA, edge: 'top' });
  const h = hiddenBounds({ bounds: shown, workArea: WA, edge: 'top' });
  assert.equal(h.y + h.height, WA.y + PEEK);
});

test('hiddenBounds 只改位置不改尺寸：改尺寸会撞上 minimumSize 的夹取', () => {
  const shown = at(0, 300);
  const h = hiddenBounds({ bounds: shown, workArea: WA, edge: 'left' });
  assert.equal(h.width, shown.width);
  assert.equal(h.height, shown.height);
  assert.equal(h.y, shown.y);
});

test('hiddenBounds peek 大于窗口时夹住，隐藏位置不会跑到显示位置另一侧', () => {
  const bar = { x: 0, y: 300, width: 340, height: 40 }; // 折叠态
  const h = hiddenBounds({ bounds: bar, workArea: WA, edge: 'top', peek: 999 });
  // peek 被夹到 min(width, height) = 40，此时隐藏位置就是原位
  assert.equal(h.y, WA.y);
});

test('hiddenBounds 自定 peek 生效', () => {
  const h = hiddenBounds({ bounds: at(0, 300), workArea: WA, edge: 'left', peek: 20 });
  assert.equal(h.x + h.width, WA.x + 20);
});

test('hiddenBounds 非法输入返回 null', () => {
  assert.equal(hiddenBounds({ bounds: null, workArea: WA, edge: 'left' }), null);
  assert.equal(hiddenBounds({ bounds: at(0, 0), workArea: WA, edge: 'bottom' }), null);
});

// —— triggerZone ——

test('triggerZone 左侧：贴着工作区左沿的一条竖带', () => {
  const shown = at(0, 300);
  const z = triggerZone({ shown, workArea: WA, edge: 'left' });
  assert.equal(z.x, WA.x);
  assert.ok(z.width >= PEEK);
  // 沿边方向覆盖窗口并往两端放宽
  assert.ok(z.y < shown.y);
  assert.ok(z.y + z.height > shown.y + shown.height);
});

test('triggerZone 右侧带子贴在工作区右沿内侧', () => {
  const shown = at(WA.width - W, 300);
  const z = triggerZone({ shown, workArea: WA, edge: 'right' });
  assert.equal(z.x + z.width, WA.x + WA.width);
});

test('triggerZone 顶部是一条横带', () => {
  const shown = at(800, 0);
  const z = triggerZone({ shown, workArea: WA, edge: 'top' });
  assert.equal(z.y, WA.y);
  assert.ok(z.width > shown.width);
  assert.ok(z.height >= PEEK);
});

test('triggerZone 覆盖隐藏后露出的那几像素——不然碰不到就唤不回', () => {
  const shown = at(0, 300);
  const hidden = hiddenBounds({ bounds: shown, workArea: WA, edge: 'left' });
  const z = triggerZone({ shown, workArea: WA, edge: 'left' });
  // 露出部分的右边缘那一列，取沿边方向的中点
  const probe = { x: hidden.x + hidden.width - 1, y: shown.y + Math.round(shown.height / 2) };
  assert.equal(pointInRect(probe, z), true);
});

test('triggerZone 右侧同样覆盖露出部分', () => {
  const shown = at(WA.width - W, 300);
  const hidden = hiddenBounds({ bounds: shown, workArea: WA, edge: 'right' });
  const z = triggerZone({ shown, workArea: WA, edge: 'right' });
  const probe = { x: hidden.x + 1, y: shown.y + 10 };
  assert.equal(pointInRect(probe, z), true);
});

test('triggerZone 顶部覆盖露出部分', () => {
  const shown = at(800, 0);
  const hidden = hiddenBounds({ bounds: shown, workArea: WA, edge: 'top' });
  const z = triggerZone({ shown, workArea: WA, edge: 'top' });
  const probe = { x: shown.x + 10, y: hidden.y + hidden.height - 1 };
  assert.equal(pointInRect(probe, z), true);
});

test('triggerZone 不覆盖屏幕中央', () => {
  const z = triggerZone({ shown: at(0, 300), workArea: WA, edge: 'left' });
  assert.equal(pointInRect({ x: 900, y: 500 }, z), false);
});

test('triggerZone 非法输入返回 null', () => {
  assert.equal(triggerZone({ shown: null, workArea: WA, edge: 'left' }), null);
  assert.equal(triggerZone({ shown: at(0, 0), workArea: WA, edge: 'bottom' }), null);
});

// —— isOuterEdge ——

const mainDisplay = { bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
const leftDisplay = { bounds: { x: -1920, y: 0, width: 1920, height: 1080 } };

test('isOuterEdge 单屏时左右上三条边都是外沿', () => {
  for (const edge of EDGES) {
    assert.equal(
      isOuterEdge({ shown: at(0, 300), workArea: WA, edge, displays: [mainDisplay] }),
      true,
      edge
    );
  }
});

test('isOuterEdge 左侧有副屏时左边界不是外沿：往那边藏只是挪到隔壁屏中间', () => {
  const displays = [mainDisplay, leftDisplay];
  assert.equal(isOuterEdge({ shown: at(0, 300), workArea: WA, edge: 'left', displays }), false);
  // 同一配置下右边界仍是外沿
  assert.equal(
    isOuterEdge({ shown: at(WA.width - W, 300), workArea: WA, edge: 'right', displays }),
    true
  );
});

test('isOuterEdge 相邻屏只覆盖部分范围时按窗口中点判', () => {
  // 副屏只在上半部（y: 0~500）
  const partial = { bounds: { x: -1920, y: 0, width: 1920, height: 500 } };
  const displays = [mainDisplay, partial];
  // 窗口在上半部 → 中点 y≈290，落在副屏范围内 → 不是外沿
  assert.equal(isOuterEdge({ shown: at(0, 0), workArea: WA, edge: 'left', displays }), false);
  // 窗口在下半部 → 中点 y≈750，副屏覆盖不到 → 是外沿
  assert.equal(isOuterEdge({ shown: at(0, 460), workArea: WA, edge: 'left', displays }), true);
});

test('isOuterEdge 拿不到 displays 时保守返回 false，宁可不隐藏', () => {
  assert.equal(isOuterEdge({ shown: at(0, 300), workArea: WA, edge: 'left' }), false);
  assert.equal(isOuterEdge({ shown: at(0, 300), workArea: WA, edge: 'left', displays: [] }), false);
});

test('isOuterEdge 用 display.bounds 而非 workArea：任务栏那条也是看得见的地方', () => {
  // 副屏的 workArea 比 bounds 矮 40px；探测点落在那 40px 里也应算「有屏」
  const below = { bounds: { x: 0, y: -1080, width: 1920, height: 1080 } };
  const displays = [mainDisplay, below];
  assert.equal(isOuterEdge({ shown: at(800, 0), workArea: WA, edge: 'top', displays }), false);
});

// —— ease / lerpRect ——

test('ease 端点固定，中间单调', () => {
  assert.equal(ease(0), 0);
  assert.equal(ease(1), 1);
  assert.ok(ease(0.5) > 0.5); // easeOut：前半程走得更多
  assert.ok(ease(0.3) < ease(0.6));
});

test('ease 越界与非法输入夹到 [0,1]', () => {
  assert.equal(ease(-1), 0);
  assert.equal(ease(2), 1);
  assert.equal(ease('x'), 0);
});

test('lerpRect 只插位置，尺寸取终点', () => {
  const from = { x: 0, y: 100, width: 340, height: 580 };
  const to = { x: -334, y: 100, width: 340, height: 580 };
  const mid = lerpRect(from, to, 0.5);
  assert.equal(mid.x, -167);
  assert.equal(mid.y, 100);
  assert.equal(mid.width, 340);
});

test('lerpRect 端点精确落在起终点', () => {
  const from = at(0, 100);
  const to = at(-334, 100);
  assert.deepEqual(lerpRect(from, to, 0), from);
  assert.deepEqual(lerpRect(from, to, 1), to);
});

test('lerpRect 起点不合法时直接跳到终点', () => {
  const to = at(-334, 100);
  assert.deepEqual(lerpRect(null, to, 0.5), to);
});

// —— ensureVisible ——

test('ensureVisible 位置正常时原样返回，不替用户改位置', () => {
  const b = at(800, 300);
  assert.deepEqual(ensureVisible({ bounds: b, workArea: WA }), b);
});

test('ensureVisible 贴边显示的窗口不算越界', () => {
  const b = at(0, 0);
  assert.deepEqual(ensureVisible({ bounds: b, workArea: WA }), b);
});

test('ensureVisible 把隐藏位置拉回来：无边框窗口开在屏幕外就没入口了', () => {
  const hidden = { x: -334, y: 300, width: W, height: H }; // 只露 6px
  const r = ensureVisible({ bounds: hidden, workArea: WA });
  assert.equal(r.x, WA.x);
  assert.equal(r.y, 300); // 纵向没问题就不动
});

test('ensureVisible 右侧隐藏位置也能拉回', () => {
  const hidden = { x: WA.width - 6, y: 300, width: W, height: H };
  const r = ensureVisible({ bounds: hidden, workArea: WA });
  assert.equal(r.x + r.width, WA.x + WA.width);
});

test('ensureVisible 顶部隐藏位置拉回，x 不动', () => {
  const hidden = { x: 800, y: -574, width: W, height: H };
  const r = ensureVisible({ bounds: hidden, workArea: WA });
  assert.equal(r.y, WA.y);
  assert.equal(r.x, 800);
});

test('ensureVisible 拿不到工作区时原样返回，不猜', () => {
  const b = at(-500, 300);
  assert.deepEqual(ensureVisible({ bounds: b, workArea: null }), b);
});

test('ensureVisible 非法 bounds 返回 null', () => {
  assert.equal(ensureVisible({ bounds: null, workArea: WA }), null);
});

// —— sameRect ——

test('sameRect 四字段全等才算相同', () => {
  assert.equal(sameRect(at(0, 0), at(0, 0)), true);
  assert.equal(sameRect(at(0, 0), at(1, 0)), false);
  assert.equal(sameRect(at(0, 0), null), false);
});

// —— 常量间的一致性 ——

test('触发带至少和露出的 peek 一样宽，否则唤不回', () => {
  const z = triggerZone({ shown: at(0, 300), workArea: WA, edge: 'left' });
  assert.ok(z.width >= PEEK);
});

test('吸附阈值大于 0 且不至于把半个屏幕都算成边缘', () => {
  assert.ok(SNAP_THRESHOLD > 0);
  assert.ok(SNAP_THRESHOLD < 100);
});

// —— 完整流程：吸附 → 隐藏 → 唤回 ——

test('全流程：右上角甩过去 → 贴右边 → 藏起来 → 触发带能碰到 → 复位回原处', () => {
  const dropped = at(1890, 40); // 用户松手的位置，右边越界一点
  const edge = detectEdge({ bounds: dropped, workArea: WA });
  assert.equal(edge, 'right');

  const shown = snapBounds({ bounds: dropped, workArea: WA, edge });
  assert.equal(shown.x + shown.width, WA.x + WA.width);

  const hidden = hiddenBounds({ bounds: shown, workArea: WA, edge });
  assert.equal(hidden.x, WA.x + WA.width - PEEK);
  // 尺寸没变 → 渲染层完全不知道发生了什么
  assert.equal(hidden.width, shown.width);

  const z = triggerZone({ shown, workArea: WA, edge });
  assert.equal(pointInRect({ x: WA.width - 1, y: shown.y + 100 }, z), true);

  // 唤回就是回到 shown，位置与吸附后完全一致
  assert.equal(sameRect(lerpRect(hidden, shown, 1), shown), true);
});
