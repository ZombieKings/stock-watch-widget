'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  WIN_W,
  WIN_H,
  MIN_H,
  COLLAPSED_H,
  NEWS_TARGET_H,
  SCREEN_MARGIN,
  MODES,
  LIST_ROW_H,
  LIST_HEAD_H,
  LIST_MAX_ROWS,
  LIST_MIN_H,
  normalizeRect,
  safeExpandedHeight,
  safeListHeight,
  listHeightToPersist,
  collapsedBounds,
  expandedBounds,
  boundsToPersist,
  defaultBounds,
  autoBounds,
  resolveMode,
  listHeight,
  listBounds,
  boundsForMode,
  minSizeForMode,
  resizableForMode,
  nextMode,
} = require('./windowLayout');

// —— normalizeRect ——

test('normalizeRect 逐字段兜底，位置坏了不连带丢掉尺寸', () => {
  const r = normalizeRect({ x: 'bad', y: 30, width: 400, height: 600 });
  assert.equal(r.x, 0); // 只有 x 回落
  assert.equal(r.y, 30);
  assert.equal(r.width, 400);
  assert.equal(r.height, 600);
});

test('normalizeRect 非对象输入返回默认尺寸', () => {
  for (const bad of [null, undefined, 'x', 42, []]) {
    const r = normalizeRect(bad);
    assert.equal(r.width, WIN_W);
    assert.equal(r.height, WIN_H);
  }
});

test('normalizeRect 取整，避免小数尺寸让 Canvas 模糊', () => {
  const r = normalizeRect({ x: 10.6, y: 20.4, width: 340.5, height: 580.2 });
  assert.deepEqual(r, { x: 11, y: 20, width: 341, height: 580 });
});

// —— safeExpandedHeight ——
//
// 这个函数的存在理由：一旦折叠高度（40）被误存进配置，展开时若原样采信，
// 用户会得到一条 40px 的缝，看起来像启动失败且无法拖大（折叠态不可 resize）。

test('safeExpandedHeight 拒绝小于最小高度的值', () => {
  assert.equal(safeExpandedHeight(COLLAPSED_H), WIN_H, '折叠高度不能当展开高度');
  assert.equal(safeExpandedHeight(0), WIN_H);
  assert.equal(safeExpandedHeight(100), WIN_H);
  assert.equal(safeExpandedHeight(MIN_H - 1), WIN_H);
});

test('safeExpandedHeight 采信合法高度', () => {
  assert.equal(safeExpandedHeight(MIN_H), MIN_H);
  assert.equal(safeExpandedHeight(720), 720);
});

test('safeExpandedHeight 非法输入回落，可指定回落值', () => {
  for (const bad of [null, undefined, NaN, 'tall', {}]) {
    assert.equal(safeExpandedHeight(bad), WIN_H);
  }
  assert.equal(safeExpandedHeight(null, 640), 640);
});

// —— collapsedBounds ——

test('collapsedBounds 只压高度，位置与宽度不动', () => {
  const r = collapsedBounds({ x: 1500, y: 24, width: 400, height: 700 });
  assert.deepEqual(r, { x: 1500, y: 24, width: 400, height: COLLAPSED_H });
});

test('collapsedBounds 幂等：对已折叠的矩形再折叠不变', () => {
  const once = collapsedBounds({ x: 10, y: 20, width: 340, height: 580 });
  assert.deepEqual(collapsedBounds(once), once);
});

// —— expandedBounds ——

test('expandedBounds 用记住的高度还原，位置沿用当前值', () => {
  // 折叠期间用户把窗口挪到了别处，展开要在新位置展开
  const r = expandedBounds({ x: 900, y: 300, width: 340, height: COLLAPSED_H }, 640);
  assert.deepEqual(r, { x: 900, y: 300, width: 340, height: 640 });
});

test('expandedBounds 记住的高度不合法时回落到默认', () => {
  const r = expandedBounds({ x: 0, y: 0, width: 340, height: COLLAPSED_H }, COLLAPSED_H);
  assert.equal(r.height, WIN_H, '存坏的折叠高度不能用来展开');
});

test('expandedBounds 缺少 storedHeight 时用默认高度', () => {
  assert.equal(expandedBounds({ x: 0, y: 0, width: 340, height: 40 }).height, WIN_H);
});

// —— boundsToPersist ——
//
// 核心不变量：折叠态落盘时**高度必须保住展开值**，否则展开就再也回不去。

test('boundsToPersist 展开态原样落盘', () => {
  const current = { x: 100, y: 50, width: 360, height: 620 };
  assert.deepEqual(boundsToPersist({ current, stored: { height: 580 }, collapsed: false }), current);
});

test('boundsToPersist 折叠态保住展开高度，位置与宽度仍跟着走', () => {
  // 折叠后用户把窗口拖到了 (800, 400)
  const r = boundsToPersist({
    current: { x: 800, y: 400, width: 360, height: COLLAPSED_H },
    stored: { x: 100, y: 50, width: 360, height: 620 },
    collapsed: true,
  });
  assert.equal(r.x, 800, '新位置要记住');
  assert.equal(r.y, 400);
  assert.equal(r.width, 360);
  assert.equal(r.height, 620, '高度必须保住展开值，不能写 40');
});

test('boundsToPersist 折叠态且无已存高度时落到默认，而不是 40', () => {
  const r = boundsToPersist({
    current: { x: 0, y: 0, width: 340, height: COLLAPSED_H },
    stored: null,
    collapsed: true,
  });
  assert.equal(r.height, WIN_H);
});

test('boundsToPersist 折叠态下已存高度本身就坏了也不写 40', () => {
  const r = boundsToPersist({
    current: { x: 0, y: 0, width: 340, height: COLLAPSED_H },
    stored: { height: COLLAPSED_H }, // 上个版本写坏的
    collapsed: true,
  });
  assert.equal(r.height, WIN_H, '要能从坏配置里自愈');
});

test('回归：折叠 → 移动 → 展开，高度必须回到原值', () => {
  // 完整走一遍真实时序，这是折叠功能最容易坏的地方
  const original = { x: 1500, y: 24, width: 340, height: 580 };

  // 1. 折叠
  const afterCollapse = collapsedBounds(original);
  assert.equal(afterCollapse.height, COLLAPSED_H);

  // 2. 折叠态下移动窗口 → 落盘（这一步若写入 height=40 就完了）
  const moved = { ...afterCollapse, x: 600, y: 800 };
  const persisted = boundsToPersist({ current: moved, stored: original, collapsed: true });
  assert.equal(persisted.height, 580);

  // 3. 展开：位置用移动后的，高度用落盘里的
  const afterExpand = expandedBounds(moved, persisted.height);
  assert.deepEqual(afterExpand, { x: 600, y: 800, width: 340, height: 580 });
});

test('回归：反复折叠展开不会让高度逐次漂移', () => {
  let bounds = { x: 100, y: 100, width: 340, height: 640 };
  let stored = { ...bounds };

  for (let i = 0; i < 5; i += 1) {
    bounds = collapsedBounds(bounds);
    stored = boundsToPersist({ current: bounds, stored, collapsed: true });
    bounds = expandedBounds(bounds, stored.height);
    stored = boundsToPersist({ current: bounds, stored, collapsed: false });
  }
  assert.equal(bounds.height, 640, '五轮后高度仍应是 640');
});

// —— defaultBounds ——

test('defaultBounds 贴屏幕右上角', () => {
  const r = defaultBounds(1920);
  assert.equal(r.x, 1920 - WIN_W - 24);
  assert.equal(r.y, 24);
  assert.equal(r.width, WIN_W);
  assert.equal(r.height, WIN_H);
});

test('defaultBounds 屏幕宽未知时不产出 NaN 坐标', () => {
  for (const bad of [undefined, null, NaN, 'wide']) {
    const r = defaultBounds(bad);
    assert.ok(Number.isFinite(r.x), `x 不能是 NaN（输入 ${bad}）`);
  }
});

// —— autoBounds：分组开合后的自动高度 ——
//
// 三条规则的优先级：用户手动高度（下限）> 工作区上限（截断）> 上移腾空间。
// 实测数据：全部收起需 578px，全部展开需 1509px（超过 1410px 的工作区高度）。

/** 一块 2560×1410 的工作区，与开发机实测值一致 */
const WA = { x: 0, y: 0, width: 2560, height: 1410 };

/** 默认位置的窗口：贴右上角，340×580 */
function winAt(y = 24, height = WIN_H) {
  return { x: 2196, y, width: WIN_W, height };
}

test('autoBounds 内容变高时窗口跟着长高', () => {
  // 展开技术指标（+287）：578 → 865
  const r = autoBounds({ needed: 865, userHeight: WIN_H, current: winAt(), workArea: WA });
  assert.equal(r.height, 865);
  assert.equal(r.y, 24, '装得下就不动位置');
  assert.equal(r.width, WIN_W, '只管高度，宽度不动');
  assert.equal(r.x, 2196);
});

test('autoBounds 内容变矮时窗口跟着缩回', () => {
  // needed 578 低于默认下限 580，所以缩到 580 —— 用户没手动拖过时，
  // 默认高度就是下限，不会缩到比初始窗口更小
  const r = autoBounds({ needed: 578, userHeight: WIN_H, current: winAt(24, 865), workArea: WA });
  assert.equal(r.height, WIN_H);
});

test('autoBounds 内容需求介于下限与当前高度之间时缩到内容所需', () => {
  // 用户拖到 500（比默认矮），此时下限是 500；内容需 650 → 给 650
  const r = autoBounds({ needed: 650, userHeight: 500, current: winAt(24, 900), workArea: WA });
  assert.equal(r.height, 650, '确实缩了，不是卡在 900');
});

test('autoBounds 不低于用户手动拖过的高度', () => {
  // 用户把窗口拖到 700（为了多看新闻），收起分组后内容只需 578 —— 仍给 700。
  // 缩回 580 等于把用户拖出来的新闻区空间又拿走
  const r = autoBounds({ needed: 578, userHeight: 700, current: winAt(24, 865), workArea: WA });
  assert.equal(r.height, 700);
});

test('autoBounds 内容需求高于手动高度时以内容为准', () => {
  const r = autoBounds({ needed: 900, userHeight: 700, current: winAt(), workArea: WA });
  assert.equal(r.height, 900);
});

test('autoBounds 手动高度非法时退到默认高度作下限', () => {
  // 折叠高度 40 被误存进配置是已知的历史问题（见 safeExpandedHeight），
  // 拿它当下限会得出一个 40px 的窗口
  for (const bad of [undefined, null, 40, COLLAPSED_H, -5, 'tall', NaN]) {
    const r = autoBounds({ needed: 500, userHeight: bad, current: winAt(), workArea: WA });
    assert.equal(r.height, WIN_H, `userHeight=${bad} 应退到默认 ${WIN_H}`);
  }
});

test('autoBounds 高度永不低于 MIN_H', () => {
  // needed 很小 + userHeight 也小的组合不该产出一条缝
  const r = autoBounds({ needed: 100, userHeight: 40, current: winAt(), workArea: WA });
  assert.ok(r.height >= MIN_H, `${r.height} 应不小于 ${MIN_H}`);
});

test('autoBounds 超出工作区时截断，余下靠滚动区消化', () => {
  // 全部展开需 1509px > 工作区 1410px，这是必然会走到的分支
  const r = autoBounds({ needed: 1509, userHeight: WIN_H, current: winAt(), workArea: WA });
  assert.ok(r.height < 1509, '必须截断');
  assert.ok(r.y + r.height + SCREEN_MARGIN <= WA.y + WA.height, '窗口底部不能越出工作区');
});

test('autoBounds 窗口靠下时上移腾出空间', () => {
  // 窗口在 y=1000，下方只剩约 394px；内容要 900px → 应上移
  const r = autoBounds({ needed: 900, userHeight: WIN_H, current: winAt(1000), workArea: WA });
  assert.ok(r.y < 1000, `应上移，实际 y=${r.y}`);
  assert.equal(r.height, 900, '上移后就装得下，不必截断');
  assert.ok(r.y >= WA.y + SCREEN_MARGIN, '不能移出工作区上沿');
  assert.ok(r.y + r.height + SCREEN_MARGIN <= WA.y + WA.height);
});

test('autoBounds 上移到顶仍不够时才截断', () => {
  const r = autoBounds({ needed: 3000, userHeight: WIN_H, current: winAt(1200), workArea: WA });
  assert.ok(r.y >= WA.y + SCREEN_MARGIN);
  assert.ok(r.y + r.height + SCREEN_MARGIN <= WA.y + WA.height, '底部仍不能越界');
  assert.ok(r.height >= MIN_H);
});

test('autoBounds 工作区带偏移（任务栏在上方 / 副屏）时按偏移算', () => {
  const wa = { x: 0, y: 60, width: 1920, height: 1000 }; // 底部 1060
  const r = autoBounds({ needed: 2000, userHeight: WIN_H, current: { x: 100, y: 500, width: WIN_W, height: WIN_H }, workArea: wa });
  assert.ok(r.y >= 60 + SCREEN_MARGIN, `y=${r.y} 不能越过工作区上沿 60`);
  assert.ok(r.y + r.height + SCREEN_MARGIN <= 1060, '底部不能越过工作区下沿 1060');
});

test('autoBounds 拿不到工作区时只保底，不压小窗口', () => {
  // 宁可窗口偏高，也不要因为拿不到屏幕信息就把它压小
  for (const bad of [undefined, null, {}, { y: 0 }, { height: 0 }, 'screen']) {
    const r = autoBounds({ needed: 900, userHeight: WIN_H, current: winAt(), workArea: bad });
    assert.equal(r.height, 900, `workArea=${JSON.stringify(bad)} 时应照 needed 给`);
    assert.equal(r.y, 24, '不动位置');
  }
});

test('autoBounds needed 非法时退到手动高度，不产出 NaN', () => {
  for (const bad of [undefined, null, NaN, 'tall', {}]) {
    const r = autoBounds({ needed: bad, userHeight: 700, current: winAt(), workArea: WA });
    assert.equal(r.height, 700, `needed=${bad} 应退到手动高度`);
    assert.ok(Number.isFinite(r.y) && Number.isFinite(r.height));
  }
});

test('autoBounds 全部字段缺失也返回合法矩形', () => {
  const r = autoBounds();
  for (const k of ['x', 'y', 'width', 'height']) {
    assert.ok(Number.isFinite(r[k]), `${k} 应是有限数`);
  }
  assert.ok(r.height >= MIN_H);
});

test('autoBounds 结果全是整数——小数尺寸会让 Canvas 发虚', () => {
  const r = autoBounds({ needed: 865.7, userHeight: 700.3, current: { x: 10.5, y: 24.9, width: 340.2, height: 580.6 }, workArea: WA });
  for (const k of ['x', 'y', 'width', 'height']) {
    assert.equal(r[k], Math.round(r[k]), `${k} 应取整`);
  }
});

test('回归：手动拖高 → 展开 → 收起，高度回到手动值而非默认', () => {
  const userHeight = 700;
  // 展开技术指标
  const opened = autoBounds({ needed: 865, userHeight, current: winAt(24, userHeight), workArea: WA });
  assert.equal(opened.height, 865);
  // 收起回来
  const closed = autoBounds({ needed: 578, userHeight, current: winAt(24, opened.height), workArea: WA });
  assert.equal(closed.height, userHeight, '必须回到 700，不是默认 580');
});

test('回归：反复开合不会让高度逐次漂移', () => {
  const userHeight = WIN_H;
  let cur = winAt(24, WIN_H);
  for (let i = 0; i < 5; i += 1) {
    cur = { ...cur, ...autoBounds({ needed: 865, userHeight, current: cur, workArea: WA }) };
    assert.equal(cur.height, 865, `第 ${i + 1} 次展开`);
    cur = { ...cur, ...autoBounds({ needed: 578, userHeight, current: cur, workArea: WA }) };
    assert.equal(cur.height, WIN_H, `第 ${i + 1} 次收起`);
  }
  assert.equal(cur.y, 24, '位置也不该漂移');
});

test('NEWS_TARGET_H 与默认窗口下新闻区的实测高度一致', () => {
  // 340×580 窗口全收起时新闻区实测 145px。改这个值会让自动调高前后
  // 新闻区观感不一致，且要同步 renderer.js 里的同名常量
  assert.equal(NEWS_TARGET_H, 145);
  // 各区块实测：head 40 + quote 97 + chart 149 + 5×25 分组 + news 145 + status 22 + 边框 2 = 580
  const measured = 40 + 97 + 149 + 5 * 25 + NEWS_TARGET_H + 22 + 2;
  assert.equal(measured, WIN_H, `按实测各区块累加应等于默认高度 ${WIN_H}，得到 ${measured}`);
});

// —— resolveMode ——

test('resolveMode 认三个登记的模式名', () => {
  for (const m of MODES) assert.equal(resolveMode(m), m);
});

test('resolveMode 非法输入回落 expanded，绝不产出 undefined', () => {
  // 悬浮窗宁可尺寸不对也不能开不出来，所以这里必须给个可用值
  for (const bad of ['garbage', '', null, undefined, 42, {}, [], true]) {
    assert.equal(resolveMode(bad), 'expanded', `resolveMode(${JSON.stringify(bad)})`);
  }
});

test('resolveMode 兼容旧的 collapsed 布尔', () => {
  assert.equal(resolveMode(undefined, true), 'collapsed');
  assert.equal(resolveMode(undefined, false), 'expanded');
  // 只有严格 true 才算折叠：手改过的配置里可能是 'true' 字符串
  assert.equal(resolveMode(undefined, 'true'), 'expanded');
  assert.equal(resolveMode(undefined, 1), 'expanded');
});

test('resolveMode 两者矛盾时以 mode 为准', () => {
  // 半迁移的调用点或手改过的配置会出现这种输入，采信新字段而不是猜
  assert.equal(resolveMode('expanded', true), 'expanded');
  assert.equal(resolveMode('list', true), 'list');
  assert.equal(resolveMode('collapsed', false), 'collapsed');
});

// —— listHeight ——

test('listHeight 行数为 0 时给出最小可用高度（放空态提示）', () => {
  assert.equal(listHeight(0), LIST_MIN_H);
  assert.equal(listHeight(0), LIST_HEAD_H + LIST_ROW_H + 2);
});

test('listHeight 在上限内随行数线性增长', () => {
  assert.equal(listHeight(1), LIST_HEAD_H + 1 * LIST_ROW_H + 2);
  assert.equal(listHeight(5), LIST_HEAD_H + 5 * LIST_ROW_H + 2);
  assert.equal(listHeight(LIST_MAX_ROWS), LIST_HEAD_H + LIST_MAX_ROWS * LIST_ROW_H + 2);
});

test('listHeight 超过上限时截断，余下靠列表自身滚动', () => {
  const cap = listHeight(LIST_MAX_ROWS);
  assert.equal(listHeight(LIST_MAX_ROWS + 1), cap);
  assert.equal(listHeight(100), cap);
});

test('listHeight 非法行数不产出 NaN，落到下限', () => {
  // 渲染层量错行数不该让窗口尺寸变成 NaN——那会让 setBounds 静默失败
  for (const bad of [null, undefined, NaN, 'abc', -3, {}, []]) {
    const h = listHeight(bad);
    assert.ok(Number.isInteger(h) && h > 0, `listHeight(${JSON.stringify(bad)}) = ${h}`);
    assert.equal(h, LIST_MIN_H);
  }
});

test('listHeight 小数行数被取整', () => {
  assert.equal(listHeight(3.4), listHeight(3));
  assert.equal(listHeight(3.6), listHeight(4));
});

test('列表模式上限高度与默认窗口同量级——切过去不该一下顶满屏幕', () => {
  assert.ok(listHeight(LIST_MAX_ROWS) < WIN_H, `${listHeight(LIST_MAX_ROWS)} 应小于 ${WIN_H}`);
});

// —— listBounds ——

test('listBounds 只改高度，位置与宽度不动', () => {
  const cur = { x: 1200, y: 80, width: 360, height: 580 };
  const r = listBounds(cur, 4);
  assert.equal(r.x, 1200);
  assert.equal(r.y, 80);
  assert.equal(r.width, 360);
  assert.equal(r.height, listHeight(4));
});

test('listBounds 输入矩形坏了也返回合法结果', () => {
  const r = listBounds({ x: 'x', y: null, width: undefined, height: NaN }, 3);
  for (const k of ['x', 'y', 'width', 'height']) {
    assert.ok(Number.isFinite(r[k]), `${k} 应是有限数，得到 ${r[k]}`);
  }
  assert.equal(r.width, WIN_W, '宽度坏了回落默认');
});

// —— boundsForMode ——

test('boundsForMode 三种模式分别等价于各自的专用函数', () => {
  const cur = { x: 100, y: 50, width: 340, height: 580 };
  assert.deepEqual(boundsForMode({ mode: 'collapsed', current: cur }), collapsedBounds(cur));
  assert.deepEqual(boundsForMode({ mode: 'list', current: cur, rowCount: 6 }), listBounds(cur, 6));
  assert.deepEqual(
    boundsForMode({ mode: 'expanded', current: cur, storedHeight: 700 }),
    expandedBounds(cur, 700)
  );
});

test('boundsForMode 未知模式回落 expanded 而非产出 NaN', () => {
  const cur = { x: 10, y: 20, width: 340, height: 40 };
  const r = boundsForMode({ mode: 'garbage', current: cur, storedHeight: 640 });
  assert.equal(r.height, 640, '应走 expanded 分支，取已存高度');
});

test('boundsForMode 全部字段缺失也返回合法矩形', () => {
  const r = boundsForMode({});
  for (const k of ['x', 'y', 'width', 'height']) {
    assert.ok(Number.isFinite(r[k]), `${k} 应是有限数`);
  }
  assert.equal(r.height, WIN_H);
});

// —— minSizeForMode ——

test('minSizeForMode：列表模式的下限必须不高于它自己的最小高度', () => {
  // 这一条是 Electron「setBounds 被 minimumSize 静默夹住」坑的守卫。
  // 反了的话股票少时切列表模式会「没反应」（高度被夹回 MIN_H），
  // 股票多时却正常——症状随关注列表长度变化，极难排查
  assert.ok(
    minSizeForMode('list').minHeight <= listHeight(1),
    `list 的 minHeight(${minSizeForMode('list').minHeight}) 必须 ≤ 一行高度(${listHeight(1)})`
  );
  assert.ok(minSizeForMode('list').minHeight <= listHeight(0), '空列表时同样成立');
});

test('minSizeForMode：折叠模式的下限必须不高于 COLLAPSED_H', () => {
  // 同一个坑的原始版本：minHeight 还是 360 时 setBounds({height:40}) 被夹回去，
  // 表现为「点了折叠没反应」
  assert.ok(minSizeForMode('collapsed').minHeight <= COLLAPSED_H);
});

test('minSizeForMode：展开模式沿用 MIN_H', () => {
  assert.equal(minSizeForMode('expanded').minHeight, MIN_H);
});

test('minSizeForMode 三种模式的宽度下限一致——切模式不该改变横向可缩放范围', () => {
  const widths = MODES.map((m) => minSizeForMode(m).minWidth);
  assert.equal(new Set(widths).size, 1, `宽度下限应一致，得到 ${JSON.stringify(widths)}`);
});

test('minSizeForMode 未知模式回落 expanded 的下限', () => {
  assert.deepEqual(minSizeForMode('garbage'), minSizeForMode('expanded'));
});

// —— resizableForMode ——

test('只有折叠态不可手动缩放', () => {
  assert.equal(resizableForMode('expanded'), true);
  // 列表态可缩放：宽度决定名称显示多少字、高度决定显示几行，都是用户会想调的。
  // 超出的行靠 .list-rows 自身滚动消化
  assert.equal(resizableForMode('list'), true);
  // 折叠态那一行的高度由字号定死（COLLAPSED_H），拖高得到一条上下留白的空条，
  // 拖矮则把内容裁掉
  assert.equal(resizableForMode('collapsed'), false);
});

test('resizableForMode 未知模式按可缩放处理——宁可让用户能拖，也别锁死窗口', () => {
  assert.equal(resizableForMode('garbage'), true);
});

// —— nextMode ——

test('nextMode 按 expanded → list → collapsed → expanded 轮换', () => {
  assert.equal(nextMode('expanded'), 'list');
  assert.equal(nextMode('list'), 'collapsed');
  assert.equal(nextMode('collapsed'), 'expanded');
});

test('nextMode 轮换三次回到原点', () => {
  let m = 'expanded';
  for (let i = 0; i < 3; i += 1) m = nextMode(m);
  assert.equal(m, 'expanded');
});

test('nextMode 未知模式当 expanded 处理', () => {
  assert.equal(nextMode('garbage'), 'list');
});

// —— boundsToPersist 的三态行为 ——

test('boundsToPersist 列表态保住展开高度——与折叠态同一个坑', () => {
  // 列表高度看着像个「正常」窗口高度（不像 40 那么显眼），照原样落盘后
  // 切回展开会得到一个 116px 的窗口
  const r = boundsToPersist({
    current: { x: 500, y: 200, width: 340, height: listHeight(3) },
    stored: { x: 100, y: 100, width: 340, height: 640 },
    mode: 'list',
  });
  assert.equal(r.height, 640, '高度沿用已存的展开高度');
  assert.equal(r.x, 500, '位置跟着走');
  assert.equal(r.y, 200);
});

test('boundsToPersist 列表态且无已存高度时落到默认，而不是列表高度', () => {
  const r = boundsToPersist({
    current: { x: 0, y: 0, width: 340, height: listHeight(2) },
    stored: null,
    mode: 'list',
  });
  assert.equal(r.height, WIN_H);
});

test('boundsToPersist mode=expanded 原样落盘', () => {
  const current = { x: 10, y: 20, width: 340, height: 620 };
  assert.deepEqual(boundsToPersist({ current, stored: { height: 580 }, mode: 'expanded' }), current);
});

test('回归：旧调用（只传 collapsed 布尔）行为不变', () => {
  // 迁移期 main.js 可能还有没改到的调用点，行为必须与改造前逐字节一致
  const current = { x: 500, y: 200, width: 340, height: COLLAPSED_H };
  const stored = { x: 100, y: 100, width: 340, height: 640 };
  assert.deepEqual(
    boundsToPersist({ current, stored, collapsed: true }),
    boundsToPersist({ current, stored, mode: 'collapsed' })
  );
  assert.deepEqual(
    boundsToPersist({ current, stored, collapsed: false }),
    boundsToPersist({ current, stored, mode: 'expanded' })
  );
});

test('回归：expanded → list → collapsed → expanded 高度回到原值', () => {
  const userHeight = 640;
  let stored = { x: 100, y: 100, width: 340, height: userHeight };
  let cur = { x: 100, y: 100, width: 340, height: userHeight };

  // 切到列表：高度变，但落盘的仍是展开高度
  cur = { ...cur, ...boundsForMode({ mode: 'list', current: cur, rowCount: 4 }) };
  stored = boundsToPersist({ current: cur, stored, mode: 'list' });
  assert.equal(stored.height, userHeight, '列表态落盘不该冲掉展开高度');

  // 再切折叠
  cur = { ...cur, ...boundsForMode({ mode: 'collapsed', current: cur }) };
  stored = boundsToPersist({ current: cur, stored, mode: 'collapsed' });
  assert.equal(stored.height, userHeight);

  // 切回展开：必须拿回用户的高度
  cur = { ...cur, ...boundsForMode({ mode: 'expanded', current: cur, storedHeight: stored.height }) };
  assert.equal(cur.height, userHeight, '切回展开必须回到用户高度');
});

test('回归：三态间反复轮换不让高度逐次漂移', () => {
  const userHeight = 640;
  let stored = { x: 100, y: 100, width: 340, height: userHeight };
  let cur = { x: 100, y: 100, width: 340, height: userHeight };
  let mode = 'expanded';

  for (let i = 0; i < 5; i += 1) {
    mode = nextMode(mode);
    cur = {
      ...cur,
      ...boundsForMode({ mode, current: cur, storedHeight: stored.height, rowCount: 4 }),
    };
    stored = boundsToPersist({ current: cur, stored, mode });
    assert.equal(stored.height, userHeight, `第 ${i + 1} 次轮换（到 ${mode}）后展开高度漂了`);
    if (mode === 'expanded') assert.equal(cur.height, userHeight, `第 ${i + 1} 次回到展开态`);
  }
});

// —— 列表模式的手动缩放 ——

test('safeListHeight 接受列表态的紧凑高度', () => {
  // 与 safeExpandedHeight 分开的理由：那个下限是 MIN_H(360)，
  // 用它校验会把用户拖出来的 4 行窗口（138px）判为非法
  assert.equal(safeListHeight(LIST_MIN_H), LIST_MIN_H);
  assert.equal(safeListHeight(138), 138);
  assert.equal(safeListHeight(800), 800);
});

test('safeListHeight 拒绝比一行还矮的高度', () => {
  assert.equal(safeListHeight(LIST_MIN_H - 1), null);
  assert.equal(safeListHeight(10), null);
  assert.equal(safeListHeight(0), null);
});

test('safeListHeight 非法输入返回 null，而不是某个默认值', () => {
  // null 的语义是「从未手动调过，按行数自动定高」。给默认值等于替用户
  // 做了「他调过高度」的决定，自动定高就永久失效了
  for (const bad of [null, undefined, NaN, 'abc', -100, {}, []]) {
    assert.equal(safeListHeight(bad), null, `safeListHeight(${JSON.stringify(bad)})`);
  }
});

test('listHeight 未传 userHeight 时按行数算（原有行为不变）', () => {
  assert.equal(listHeight(4), LIST_HEAD_H + 4 * LIST_ROW_H + 2);
  assert.equal(listHeight(4, null), LIST_HEAD_H + 4 * LIST_ROW_H + 2);
  assert.equal(listHeight(4, undefined), LIST_HEAD_H + 4 * LIST_ROW_H + 2);
});

test('listHeight 有 userHeight 时完全听用户——自动定高彻底让位', () => {
  // 这是用户明确要求的语义：「你设成多高就一直是多高」
  assert.equal(listHeight(4, 500), 500, '比自动值高');
  assert.equal(listHeight(20, 138), 138, '比自动值低（20 行本该 554px）');
});

test('listHeight 的 userHeight 不受 LIST_MAX_ROWS 上限约束', () => {
  // 上限是给自动定高的（怕一切过去就顶满屏幕），用户自己拖的不该被截断
  const cap = listHeight(LIST_MAX_ROWS);
  assert.equal(listHeight(100, cap + 300), cap + 300);
});

test('listHeight 的 userHeight 非法时回落到按行数算', () => {
  assert.equal(listHeight(4, 10), LIST_HEAD_H + 4 * LIST_ROW_H + 2, '比一行还矮，不采信');
  assert.equal(listHeight(4, 'abc'), LIST_HEAD_H + 4 * LIST_ROW_H + 2);
});

test('listBounds 透传 userHeight', () => {
  const cur = { x: 100, y: 50, width: 340, height: 580 };
  assert.equal(listBounds(cur, 4, 500).height, 500);
  assert.equal(listBounds(cur, 4, null).height, listHeight(4));
});

test('boundsForMode 把 listHeight 传给列表态', () => {
  const cur = { x: 100, y: 50, width: 340, height: 580 };
  assert.equal(boundsForMode({ mode: 'list', current: cur, rowCount: 4, listHeight: 500 }).height, 500);
});

test('boundsForMode 的 listHeight 与 storedHeight 互不干扰', () => {
  // 两者必须分开传：混用会让列表态的紧凑高度冲掉展开态的高度
  const cur = { x: 100, y: 50, width: 340, height: 138 };
  assert.equal(
    boundsForMode({ mode: 'expanded', current: cur, storedHeight: 640, listHeight: 138 }).height,
    640,
    '展开态只看 storedHeight'
  );
  assert.equal(
    boundsForMode({ mode: 'list', current: cur, rowCount: 4, storedHeight: 640, listHeight: 138 }).height,
    138,
    '列表态只看 listHeight'
  );
});

// —— listHeightToPersist ——

test('listHeightToPersist 只在列表态给出高度', () => {
  const current = { x: 0, y: 0, width: 340, height: 300 };
  assert.equal(listHeightToPersist({ current, mode: 'list' }), 300);
  assert.equal(listHeightToPersist({ current, mode: 'expanded' }), null);
  assert.equal(listHeightToPersist({ current, mode: 'collapsed' }), null);
});

test('listHeightToPersist 高度不合法时返回 null（调用方跳过落盘）', () => {
  assert.equal(listHeightToPersist({ current: { height: 10 }, mode: 'list' }), null, '比一行还矮');
});

test('listHeightToPersist 拿不到当前矩形时用默认高度（normalizeRect 兜底）', () => {
  // normalizeRect 给缺失的 height 填 WIN_H，那是个合法的列表高度。
  // 这种输入只会出现在调用错误的情况下，返回一个合法值比返回 null 更安全 ——
  // 至少不会让配置里留下一个坏值
  assert.equal(listHeightToPersist({ current: null, mode: 'list' }), WIN_H);
});

test('listHeightToPersist 未知模式返回 null', () => {
  assert.equal(listHeightToPersist({ current: { height: 300 }, mode: 'garbage' }), null);
  assert.equal(listHeightToPersist({}), null);
});

test('回归：列表态拖高不会冲掉展开态高度——同一个坑的第三种形态', () => {
  // 折叠高度(40)、列表自动高度(138)、列表手动高度都不能进 bounds.height。
  // 前两个由 boundsToPersist 挡住，这一个靠独立字段
  const current = { x: 500, y: 200, width: 340, height: 300 };
  const stored = { x: 100, y: 100, width: 340, height: 640 };

  const persisted = boundsToPersist({ current, stored, mode: 'list' });
  assert.equal(persisted.height, 640, 'bounds.height 仍是展开高度');
  assert.equal(persisted.x, 500, '位置跟着走');

  const lh = listHeightToPersist({ current, mode: 'list' });
  assert.equal(lh, 300, '列表高度另存');
});

test('回归：拖过列表高度后，三态轮换各自拿回自己的高度', () => {
  const userExpanded = 640;
  const userList = 300;
  let cur = { x: 100, y: 100, width: 340, height: userExpanded };

  // 切到列表：用记住的列表高度，不是按行数算
  cur = { ...cur, ...boundsForMode({ mode: 'list', current: cur, rowCount: 4, listHeight: userList }) };
  assert.equal(cur.height, userList);

  // 切折叠
  cur = { ...cur, ...boundsForMode({ mode: 'collapsed', current: cur }) };
  assert.equal(cur.height, COLLAPSED_H);

  // 切回展开：拿回展开高度
  cur = { ...cur, ...boundsForMode({ mode: 'expanded', current: cur, storedHeight: userExpanded }) };
  assert.equal(cur.height, userExpanded);

  // 再切回列表：仍是用户设的列表高度
  cur = { ...cur, ...boundsForMode({ mode: 'list', current: cur, rowCount: 4, listHeight: userList }) };
  assert.equal(cur.height, userList, '列表高度不该被别的模式影响');
});

test('回归：列表态可缩放，但下限仍挡住比一行还矮的窗口', () => {
  assert.equal(resizableForMode('list'), true);
  assert.ok(
    minSizeForMode('list').minHeight >= LIST_MIN_H,
    '手动缩放的下限不该让用户拖出一个连一行都放不下的窗口'
  );
});

test('LIST_ROW_H 与 style.css 的 .list-row 约定一致', () => {
  // 这边做算术、那边做渲染，改一处要同步另一处，否则窗口高度与内容对不上：
  // 偏小会让最后一行被裁掉，偏大会在底部留一条空白
  assert.equal(LIST_ROW_H, 26);
  assert.equal(LIST_HEAD_H, 34);
});
