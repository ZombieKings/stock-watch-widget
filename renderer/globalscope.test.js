'use strict';

/**
 * 卫兵测试：renderer/ 下的脚本不得有顶层符号重名。
 *
 * 为什么需要这个：那些文件是普通 <script>（非 ESM），**共享同一个全局作用域**。
 * 两个文件各自 `const fmtPrice = ...` 会抛
 * "Identifier 'fmtPrice' has already been declared"，而且那是**解析期**错误 ——
 * 后加载的整个文件一行都不执行，window.StockXxx 变成 undefined。
 *
 * 最坑的是：普通单测发现不了。node 里每个文件是独立的模块作用域，撞不上；
 * 各文件自己的测试照样全绿，只有真在浏览器里加载才会挂。透明窗口下渲染层
 * 报错的表现是「整窗不可见」，排查成本很高。
 *
 * 所以这里静态扫描源码而不是 require 它们 —— require 走的正是那个撞不上的
 * 模块作用域，验不出问题。
 *
 * 已经踩过的实例（见 groups.js 文件末尾注释）：
 *   叫 `api` → 与 preload 的 contextBridge window.api 冲突
 *   叫 `API` → 与 candle.js 的顶层 const API 冲突
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;

/** 参与扫描的文件：真正会被 index.html 以 <script> 加载的那些 */
function scriptFiles() {
  return fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
    .sort();
}

/**
 * 抽出一个文件的顶层声明名。
 *
 * 判据是「行首没有缩进」—— 本项目所有 renderer 脚本都是 2 空格缩进的常规风格，
 * 顶层声明一律顶格。这个近似足够挡住实际会犯的错（在文件里加一个顶格的
 * 辅助函数），不必为此引入一个 AST 解析器。
 */
function topLevelNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^class\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  return names;
}

test('renderer/ 各脚本之间没有顶层符号重名', () => {
  const owners = new Map();
  const clashes = [];

  for (const file of scriptFiles()) {
    const src = fs.readFileSync(path.join(DIR, file), 'utf8');
    for (const name of topLevelNames(src)) {
      if (owners.has(name)) clashes.push(`${name}（${owners.get(name)} ↔ ${file}）`);
      else owners.set(name, file);
    }
  }

  assert.deepEqual(
    clashes,
    [],
    `顶层符号重名会让后加载的文件在解析期整体失效：\n  ${clashes.join('\n  ')}\n` +
      '解法：给新文件的顶层符号加专属前缀（见 groups.js / indchart.js / listview.js 的做法）'
  );
});

test('顶层符号不得叫 api —— 会与 preload 暴露的 window.api 冲突', () => {
  /**
   * 这个名字上面那条测试覆盖不到：window.api 来自 preload 的 contextBridge，
   * 不是任何一个 renderer 文件声明的，两两对比撞不出来。
   *
   * 只查小写 `api`。大写 `API` 是 candle.js 的导出对象名，既存且在用 ——
   * 它由上面那条两两对比的测试守着（新文件不能再叫这个名），不必在这里禁掉。
   */
  const found = [];
  for (const file of scriptFiles()) {
    const src = fs.readFileSync(path.join(DIR, file), 'utf8');
    if (topLevelNames(src).has('api')) found.push(file);
  }
  assert.deepEqual(found, [], `这些文件的顶层 api 会与 window.api 冲突：${found.join(', ')}`);
});

test('每个脚本都做了双导出（node 单测 + 浏览器全局）', () => {
  // renderer.js 是入口，不导出任何东西；其余都是被它调用的库
  const entry = 'renderer.js';
  for (const file of scriptFiles()) {
    if (file === entry) continue;
    const src = fs.readFileSync(path.join(DIR, file), 'utf8');
    assert.match(src, /module\.exports\s*=/, `${file} 缺少 module.exports（node 单测拿不到）`);
    assert.match(src, /window\.Stock\w+\s*=/, `${file} 缺少 window.Stock* 挂载（浏览器里拿不到）`);
  }
});

test('index.html 加载了 renderer/ 下的每一个脚本', () => {
  // 新加了文件却忘了在 index.html 里引，症状是「函数明明写了却 undefined」，
  // 而单测全绿 —— 与重名那个坑同源，都是「node 能跑、浏览器不能」
  const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
  const missing = scriptFiles().filter((f) => !html.includes(`src="${f}"`));
  assert.deepEqual(missing, [], `这些脚本没有被 index.html 引入：${missing.join(', ')}`);
});

test('index.html 里 axis.js 先于用它的 chart.js / candle.js 加载', () => {
  // axis.js 提供刻度几何，被后两者在顶层直接引用。顺序反了会 ReferenceError
  const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
  const at = (f) => html.indexOf(`src="${f}"`);
  assert.ok(at('axis.js') >= 0, 'axis.js 应被引入');
  assert.ok(at('axis.js') < at('chart.js'), 'axis.js 必须先于 chart.js');
  assert.ok(at('axis.js') < at('candle.js'), 'axis.js 必须先于 candle.js');
});

test('renderer.js 最后加载——它是入口，依赖前面所有库', () => {
  const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
  const at = (f) => html.indexOf(`src="${f}"`);
  const entryAt = at('renderer.js');
  for (const file of scriptFiles()) {
    if (file === 'renderer.js') continue;
    assert.ok(at(file) < entryAt, `${file} 必须先于 renderer.js 加载`);
  }
});

test('renderer.js 里 $(...) 引用的每个 DOM id 都在 index.html 中存在', () => {
  /**
   * $ 是 getElementById 的简写，取不到时返回 null，紧接着的 .textContent 赋值
   * 就抛 TypeError。透明窗口下渲染层抛错的表现是「整窗不可见」，
   * 而单测（不加载 HTML）照样全绿 —— 又一个「node 能跑、浏览器不能」的坑。
   *
   * 改 HTML 时漏改 renderer.js（或反之）会走到这里。
   */
  const js = fs.readFileSync(path.join(DIR, 'renderer.js'), 'utf8');
  const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');

  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  // 只匹配字面量参数：$(spec.bodyEl) 那种动态取值查不了，
  // 它们的值来自 GROUP_SPECS，由各分组自己的测试覆盖
  const used = new Set([...js.matchAll(/\$\(['"]([A-Za-z][\w-]*)['"]\)/g)].map((m) => m[1]));

  const missing = [...used].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, [], `renderer.js 引用了不存在的 id：${missing.join(', ')}`);
});

test('GROUP_SPECS 里登记的元素 id 也都存在', () => {
  // 这些是上一条测试匹配不到的动态引用（$(spec.bodyEl) 之类），
  // 但值本身是写在 renderer.js 里的字面量，可以单独扫出来
  const js = fs.readFileSync(path.join(DIR, 'renderer.js'), 'utf8');
  const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

  const keys = ['hintEl', 'bodyEl', 'sectionEl'];
  const missing = [];
  for (const key of keys) {
    for (const m of js.matchAll(new RegExp(`${key}:\\s*'([^']+)'`, 'g'))) {
      if (!htmlIds.has(m[1])) missing.push(`${key}: ${m[1]}`);
    }
  }
  assert.deepEqual(missing, [], `GROUP_SPECS 引用了不存在的 id：\n  ${missing.join('\n  ')}`);
});
