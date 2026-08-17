'use strict';

const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const { createConfigStore, isConfigured } = require('./src/config');
const {
  collectWatchlist,
  collectDetail,
  collectNews,
  collectReports,
  collectKline,
  collectMinute5d,
  collectIndicators,
  collectFlow,
  collectMargin,
  collectFinance,
  collectLhb,
} = require('./src/stockService');
const { searchStocks } = require('./src/searchClient');
const { pollIntervalMs, localDateKey } = require('./src/marketTime');
const { createTradingCalendar } = require('./src/calendarClient');
const { createTradeStore } = require('./src/tradeStore');
const { realizedInRange } = require('./src/trades');
const { createAlertStore } = require('./src/alertStore');
const { evaluateAlerts, pruneFired } = require('./src/alertRules');
const layout = require('./src/windowLayout');
const edge = require('./src/edgeSnap');

let win = null;
let store = null;
let tray = null;

/**
 * 交易流水存储。与配置分开一个文件，理由见 src/tradeStore.js 的模块注释。
 * 在 whenReady 里创建（要等 app.getPath('userData') 可用）。
 */
let tradeStore = null;

/** 预警去重游标的存储。见 src/alertStore.js */
let alertStore = null;

/**
 * 上次跑预警的时间戳（毫秒）。
 *
 * 预警搭渲染层 get-watchlist 的便车（零新增请求、零新增定时器），但窗口被
 * win.hide() 藏起来后 Chromium 会节流甚至冻结渲染进程的定时器，便车就没了 ——
 * 而「藏起来也要提醒」恰恰是预警最重要的场景。保底定时器靠这个时间戳
 * 判断渲染层是否还活着，见 startAlertFallback。
 */
let lastAlertRunAt = 0;

/** 保底定时器的句柄。退出前清掉，避免 quit 过程中还在发请求 */
let alertFallbackTimer = null;

/**
 * 交易日历。进程级单例：内部按月缓存，多个窗口/多次刷新共用同一份，
 * 避免每次取详情都打深交所接口。失败会被它自己记下来，不会反复重试。
 */
const calendar = createTradingCalendar();

/**
 * 是否正在做程序化的高度调整。
 *
 * 自动调高会触发 'resized'，若照常落盘就会把「自动高度」写进配置，
 * 用户手动拖出来的高度（自动调整的下限）被冲掉，收起分组后就再也回不去。
 * 置位期间 persistBounds 直接返回，所以配置里的 height 只记录用户真正拖过的值。
 *
 * 用显式标记而不去赌 Electron 是否对程序化 setBounds 触发 resized ——
 * 两种行为下都正确。
 */
let autoResizing = false;

/**
 * 当前窗口模式：'expanded' | 'list' | 'collapsed'。以配置为准，启动时读入。
 *
 * 真相源在主进程：窗口尺寸由它改，托盘与右键菜单也能切。渲染层只持一份镜像，
 * 由 mode-changed 推送同步。
 */
let mode = 'expanded';

/**
 * 列表模式最近一次已知的行数（= 关注列表长度）。
 *
 * 记在这里是因为切模式的入口有好几个（托盘、右键菜单、快捷键），它们都不知道
 * 关注列表有多长 —— 那是渲染层的信息。渲染层每次画完列表会通过 set-list-height
 * 报过来，这里存下最后一个值，供不带 rowCount 的切换调用使用。
 */
let lastRowCount = 0;

const { WIN_W, MIN_W, MIN_H, COLLAPSED_H } = layout;

/**
 * 位置/尺寸变动后落盘，下次启动复原。
 *
 * 非展开态下当前高度不是展开高度（折叠是 40，列表是按行数算的），不能原样写进
 * 配置，否则展开高度就被冲掉了——boundsToPersist 负责保住它。
 *
 * 模块级函数而不是 createWindow 里的闭包：边缘吸附对齐后要显式调它一次
 * （见 updateSnap 末尾），那时不在 createWindow 的作用域里。
 *
 * @param {object} [rect] 要落盘的矩形。省略时取窗口当前位置。吸附对齐传显式值 ——
 *        那一刻 setBounds 才刚发出，getBounds 可能还是旧值
 */
function persistBounds(rect) {
  if (!win || win.isDestroyed()) return;
  // 自动调高引起的尺寸变化不落盘：配置里的 height 是「用户手动拖到多高」，
  // 它同时是自动调整的下限，被自动值覆盖后收起分组就回不到用户的高度了
  if (autoResizing) return;
  /**
   * 吸附/隐藏动画期间的位置不落盘 —— 这是整个边缘隐藏功能里最要紧的一条。
   *
   * 隐藏动画每帧都 setBounds，每帧都触发 moved。照常落盘会把「只露 6px」
   * 的屏幕外位置写进配置，下次启动窗口就开在屏幕外；而它是 frame:false +
   * skipTaskbar 的窗口，任务栏上没有入口，用户只能去删 config.json。
   *
   * snap.hidden 也要挡：藏着的时候收到的 moved 一定来自我们自己。
   *
   * 显式传 rect 的调用绕过这两道闸（那是吸附对齐后的**显示态**位置，
   * 正是该记住的东西），所以只在没传 rect 时才检查。
   */
  if (rect == null && (snap.moving || snap.hidden)) return;
  try {
    const current = edge.toRect(rect) || win.getBounds();
    const patch = {
      bounds: layout.boundsToPersist({ current, stored: store.load().bounds, mode }),
    };
    /**
     * 列表态下手动拖的高度记进独立字段。
     *
     * 一旦记上，listHeight 就成了列表态的权威高度 —— 自动定高（按行数）
     * 彻底让位，加减股票不再改变窗口尺寸。这是用户明确要求的语义：
     * 「你设成多高就一直是多高」。
     *
     * autoResizing 已经在上面挡掉了程序化调整，所以走到这里的一定是
     * 用户真的拖过边框（或吸附对齐 —— 那只改位置，不改高度）。
     */
    const lh = layout.listHeightToPersist({ current, mode });
    if (lh != null) patch.listHeight = lh;
    store.patch(patch);
  } catch {
    // 落盘失败不影响使用，静默跳过
  }
}

function createWindow() {
  const cfg = store.load();
  const { width: screenW } = screen.getPrimaryDisplay().workAreaSize;

  const iconPath = path.join(__dirname, 'build', 'icon.ico');
  const icon = fs.existsSync(iconPath) ? iconPath : undefined;

  // 记住的位置优先；首次运行贴右上角
  const saved = cfg.bounds;
  const expanded = saved || layout.defaultBounds(screenW);

  mode = cfg.mode;
  // 上次退出时不是展开态 → 直接以目标尺寸开窗，避免先闪一下大窗再缩回去。
  // 列表模式此刻还不知道关注列表有多长，按 watchlist 长度估——渲染层画完列表后
  // 会通过 set-list-height 报准确值，那时再微调
  lastRowCount = (cfg.watchlist || []).length;
  const bounds = layout.boundsForMode({
    mode,
    current: expanded,
    storedHeight: expanded.height,
    rowCount: lastRowCount,
    // 上次在列表态手动拖过的高度。为 null 时按行数自动定高
    listHeight: cfg.listHeight,
  });

  const minSize = layout.minSizeForMode(mode);

  /**
   * 开窗前把位置拉回屏幕内。
   *
   * persistBounds 会挡住隐藏位置落盘，但这里仍要兜一层：配置可能是旧版本写的、
   * 用户手改过的，或者上次贴的那块副屏已经拔掉了。窗口是 frame:false +
   * skipTaskbar 的，一旦开在屏幕外就没有任何入口能把它拖回来 —— 这是唯一
   * 必须靠自愈解决的失效模式，其余的（吸附不生效、隐藏不触发）都还留着出路。
   *
   * ensureVisible 只在露出不足时才改，位置正常的话原样返回。
   */
  const safeBounds =
    edge.ensureVisible({ bounds, workArea: workAreaFor(bounds) }) || bounds;

  win = new BrowserWindow({
    ...safeBounds,
    // 非展开态的最小高度必须放开：minHeight 还是 360 时构造函数里的 height=40
    // （或列表模式的 116）会被静默夹回 360，窗口开出来就是展开尺寸
    minWidth: minSize.minWidth,
    minHeight: minSize.minHeight,
    icon,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  if (cfg.opacity < 1) win.setOpacity(cfg.opacity);
  // 折叠与列表态的高度都是算出来的，与 setMode 里保持一致
  if (!layout.resizableForMode(mode)) win.setResizable(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 透明窗口里渲染层报错会导致整窗不可见，把错误转发到终端便于定位
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) console.error(`[renderer] ${sourceId}:${line} ${message}`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer] 进程异常退出:', details.reason);
  });

  win.on('moved', persistBounds);
  win.on('resized', persistBounds);

  /**
   * 拖完窗口后判吸附。
   *
   * 用 'moved' 而不是 'move'：后者在拖动过程中连续触发，每一帧都去 setBounds
   * 对齐会跟用户的拖动打架（窗口被反复拽回边上，拖不走）。'moved' 在松手后才来。
   *
   * resized 也要判：从边上把窗口拉宽会改变它离另一条边的距离，
   * 而且贴右边时改宽度必须重新对齐，否则右边框会离开屏幕边缘。
   */
  win.on('moved', updateSnap);
  win.on('resized', updateSnap);

  // 藏进托盘时停掉轮询：看不见的窗口不需要滑动，也别白烧 CPU。
  // 唤回时若还贴着边就重新开始
  win.on('hide', () => {
    clearSnapTimers();
    clearInterval(snap.pollTimer);
    snap.pollTimer = null;
  });
  win.on('show', () => {
    // 藏在屏幕外时被托盘唤回：先放回显示位置，否则用户点了「显示窗口」
    // 却什么都没看见（窗口确实 visible，只是在屏幕外）
    if (snap.hidden && snap.shown) {
      snap.hidden = false;
      applyBounds(snap.shown);
    }
    snap.graceUntil = Date.now() + edge.GRACE_MS;
    updateSnap();
  });

  win.webContents.on('context-menu', () => {
    const menu = Menu.buildFromTemplate([
      // 三个显式项而不是一个「切换」——菜单该让人直接选目标，
      // 在菜单里做轮换（点一次只能前进一格）是反直觉的
      ...modeMenuItems(),
      { type: 'separator' },
      { label: '刷新', click: () => win.webContents.send('refresh') },
      { label: '设置', click: () => win.webContents.send('open-settings') },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]);
    menu.popup({ window: win });
  });

  /**
   * 启动时若已经贴着边，直接进入吸附态（不必等用户拖一次）。
   *
   * 宽限期从这里开始计：上次退出时贴着边的话，此刻 updateSnap 会立刻判定为
   * 吸附并开始轮询；光标不在窗口上时 700ms 后就滑走了 —— 用户看到的是
   * 「双击图标，闪一下就没了」，十成会当成启动失败。
   */
  snap.graceUntil = Date.now() + edge.GRACE_MS;
  updateSnap();
}

/** 三种模式的菜单项。右键菜单与托盘菜单共用 */
function MODE_LABELS() {
  return { expanded: '完整', list: '列表', collapsed: '单行' };
}

function modeMenuItems() {
  const labels = MODE_LABELS();
  return layout.MODES.map((m) => ({
    label: labels[m],
    type: 'radio',
    checked: mode === m,
    click: () => setMode(m),
  }));
}

/**
 * 载入托盘图标。
 *
 * 用 fs.readFileSync + createFromBuffer 而不是 createFromPath：
 * 打包后资源在 app.asar 里，asar 路径只有 Electron 包装过的 fs 认得，
 * createFromPath 拿到的是空图，托盘会显示成一块空白。
 *
 * @returns {Electron.NativeImage | null} 载入失败返回 null
 */
function loadTrayIcon() {
  const read = (name) => {
    try {
      return nativeImage.createFromBuffer(fs.readFileSync(path.join(__dirname, 'assets', name)));
    } catch {
      return null;
    }
  };

  const base = read('tray-16.png');
  if (!base || base.isEmpty()) return null;
  // 高 DPI 屏用 2x，交给系统按缩放比例挑
  const hi = read('tray-32.png');
  if (hi && !hi.isEmpty()) base.addRepresentation({ scaleFactor: 2, buffer: hi.toPNG() });
  return base;
}

/** 窗口在显示与隐藏之间切换。隐藏时进程留驻，靠托盘唤回 */
function toggleWindow() {
  if (!win || win.isDestroyed()) {
    // 窗口被关掉过（有托盘时不随之退出），重建一个
    createWindow();
    refreshTrayMenu();
    return;
  }
  if (win.isVisible()) {
    win.hide();
  } else {
    win.show();
    // 隐藏期间 alwaysOnTop 可能被系统降级，重新置顶
    win.setAlwaysOnTop(true, 'screen-saver');
  }
  refreshTrayMenu();
}

/** 菜单项的文案随状态变（显示/隐藏、当前模式），每次变更后重建 */
function refreshTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  const visible = Boolean(win && !win.isDestroyed() && win.isVisible());
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: visible ? '隐藏窗口' : '显示窗口', click: toggleWindow },
      // 窗口藏着时切模式没有意义（用户看不到结果），整组禁用
      ...modeMenuItems().map((it) => ({ ...it, enabled: visible })),
      { type: 'separator' },
      { label: '刷新', click: () => win && !win.isDestroyed() && win.webContents.send('refresh') },
      {
        label: '设置',
        click: () => {
          if (!win || win.isDestroyed()) return;
          // 设置面板在窗口里，窗口藏着的话先唤出来
          if (!win.isVisible()) {
            win.show();
            win.setAlwaysOnTop(true, 'screen-saver');
            refreshTrayMenu();
          }
          win.webContents.send('open-settings');
        },
      },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ])
  );
}

/**
 * 建系统托盘图标。
 *
 * 窗口是 skipTaskbar 的无边框窗，任务栏上没有入口——藏起来之后
 * 只能靠托盘唤回，所以托盘建不起来时要保住窗口可见，
 * 否则用户会失去所有入口，只能从任务管理器结束进程。
 */
function createTray() {
  const icon = loadTrayIcon();
  if (!icon) {
    console.error('[tray] 图标载入失败，跳过托盘（运行 npm run icon 生成 assets/tray-*.png）');
    return;
  }
  try {
    tray = new Tray(icon);
  } catch (err) {
    console.error('[tray] 创建失败:', err && err.message);
    return;
  }
  tray.setToolTip('股票行情');
  // 左键单击切换显示，与常见挂件的习惯一致
  tray.on('click', toggleWindow);
  refreshTrayMenu();
}

/**
 * 切换窗口模式。
 *
 * 顺序很关键：**先** setMinimumSize 放开下限，**再** setBounds。
 * 反过来的话 setBounds({height: 40}) 会被 minHeight=360 静默夹回去，
 * 表现为「点了折叠没反应」——这是 Electron 的行为，不是计算错误。
 *
 * 列表模式让这个坑更隐蔽：它的高度介于 40 与 360 之间，股票少时（3 只 → 116px）
 * 被夹回 360，股票多时（14 只 → 400px）却正常，症状随关注列表长度变化。
 *
 * @param {string} next 目标模式
 * @param {number} [rowCount] 列表模式的行数。不传时沿用最近一次已知值
 * @returns {{ mode: string }}
 */
function setMode(next, rowCount) {
  const want = layout.resolveMode(next);
  if (!win || win.isDestroyed()) {
    mode = want;
    return { mode };
  }
  if (rowCount != null) lastRowCount = rowCount;
  // 幂等：同模式重复调用直接返回，避免白白触发一次 resized 引起重排。
  // saveSettings 那边会无条件调一次，靠这里挡掉
  if (want === mode) return { mode };

  const current = win.getBounds();
  // 切回展开时要用配置里记住的展开高度（而不是当前的 40 / 列表高度）；
  // 切回列表态则要用记住的列表高度。两者存在不同字段里，见 config.listHeight
  const cfg = store.load();
  const storedBounds = cfg.bounds;

  const minSize = layout.minSizeForMode(want);
  win.setMinimumSize(minSize.minWidth, minSize.minHeight);
  win.setBounds(
    layout.boundsForMode({
      mode: want,
      current,
      storedHeight: storedBounds && storedBounds.height,
      rowCount: lastRowCount,
      // 用户上次在列表态拖出来的高度。为 null 时按行数自动定高
      listHeight: cfg.listHeight,
    })
  );
  // 折叠态的高度由字号定死，拖它只会得到一条留白或被裁的空条；
  // 列表态可缩放（宽度决定名称显示多少字、高度决定显示几行）
  win.setResizable(layout.resizableForMode(want));

  mode = want;
  try {
    store.patch({ mode });
  } catch {
    // 落盘失败不影响本次切换
  }
  // 渲染层据此切换 DOM（三套互斥的布局）
  win.webContents.send('mode-changed', mode);
  refreshTrayMenu();

  /**
   * 切模式改的是高度，贴边的窗口要重新对齐 —— 尤其是贴顶部时：折叠成 40px
   * 后隐藏位置只需上移 34px，用旧的 shown（580 高）算出来的位置会把窗口
   * 送到屏幕外 500 多像素。
   *
   * setMode 里的 setBounds 不带 snap.moving 标记，所以它触发的 resized 已经
   * 会调一次 updateSnap；但 setResizable 之后再显式调一次更稳 —— 上面那次
   * 若因 autoResizing 被挡掉（saveSettings 路径下有可能），这里补上。
   */
  updateSnap();
  return { mode };
}

// —— 边缘吸附与自动隐藏 ——

/**
 * 吸附状态机。几何计算全在 src/edgeSnap.js（可单测），这里只管副作用：
 * setBounds、定时器、光标轮询。
 *
 * 状态组合只有三种合法形态，多余的组合都是 bug：
 *   edge=null                     未吸附。光标轮询不跑，定时器全空
 *   edge≠null, hidden=false       贴边显示中。轮询在跑，等鼠标离开
 *   edge≠null, hidden=true        已藏起来。轮询在跑，等鼠标碰触发带
 *
 * shown 是**显示态**的矩形，是这套机制的锚：藏起来时用它算触发带、唤回时回到它。
 * 它只在「吸附完成」和「用户拖动窗口」时更新 —— 隐藏动画期间的中间位置绝不能
 * 写进去，否则窗口会一格一格往屏幕外爬，再也回不来。
 */
const snap = {
  /** 当前吸附在哪条边。null = 未吸附 */
  edge: null,
  /** 显示态矩形（吸附对齐后的位置） */
  shown: null,
  /** 是否已经藏起来 */
  hidden: false,
  /** 光标轮询定时器 */
  pollTimer: null,
  /** 「鼠标离开后延迟隐藏」的定时器 */
  hideTimer: null,
  /** 滑动动画的定时器 */
  animTimer: null,
  /**
   * 程序化移动窗口中。与 autoResizing 同样的用途与理由（见那边的注释）：
   * 隐藏动画每帧都 setBounds，每帧都会触发 moved，照常落盘就把屏幕外的位置
   * 写进配置了 —— 下次启动窗口开在屏幕外，而它没有任务栏入口。
   */
  moving: false,
  /** 启动宽限期的截止时间戳。见 edgeSnap.GRACE_MS */
  graceUntil: 0,
};

/** 当前是否启用自动隐藏。配置项，默认关 —— 见 config 的 autoHide */
function autoHideEnabled() {
  try {
    return store.load().autoHide === true;
  } catch {
    return false;
  }
}

/** 窗口所在那块屏的工作区。多显示器下不能用主屏的 */
function workAreaFor(bounds) {
  try {
    return screen.getDisplayMatching(bounds).workArea;
  } catch {
    return null;
  }
}

function clearSnapTimers() {
  clearTimeout(snap.hideTimer);
  clearInterval(snap.animTimer);
  snap.hideTimer = null;
  snap.animTimer = null;
}

/**
 * 退出吸附态。
 *
 * **必须先把窗口移回显示位置**：藏着的时候用户去设置里关掉自动隐藏、或者切了模式，
 * 直接清状态会留下一个停在屏幕外、再也没有触发带能唤回的窗口。
 */
function releaseSnap() {
  const wasHidden = snap.hidden;
  const shown = snap.shown;
  clearSnapTimers();
  clearInterval(snap.pollTimer);
  snap.pollTimer = null;
  snap.edge = null;
  snap.hidden = false;
  snap.shown = null;
  if (wasHidden && shown && win && !win.isDestroyed()) applyBounds(shown);
}

/**
 * 程序化设置窗口位置，且不落盘。
 *
 * moving 标记的清除放在 setImmediate 里，与 autoResizing 同一个理由：
 * moved 事件多数情况下同步派发，但不同 Electron 版本上不保证。
 */
function applyBounds(rect) {
  if (!win || win.isDestroyed()) return;
  const r = edge.toRect(rect);
  if (!r) return;
  if (edge.sameRect(r, win.getBounds())) return;
  snap.moving = true;
  try {
    win.setBounds(r);
  } finally {
    setImmediate(() => {
      snap.moving = false;
    });
  }
}

/**
 * 滑动到目标位置。
 *
 * 动画纯粹是观感：一格跳过去会让「窗口消失了」和「窗口崩了」看起来一样。
 * 定时器而非 requestAnimationFrame —— 主进程里没有 rAF，而 130ms 的位移
 * 对帧率精度不敏感。
 *
 * 新动画开始前先清掉旧的：快速划进划出时两个动画会互相覆盖 setBounds，
 * 窗口在两个位置间抖动。
 *
 * @param {object} to 目标矩形
 * @param {Function} [done] 动画结束后调用（无论是走完还是被顶掉都不调 —— 被顶掉的
 *        那次由新动画的 done 负责收尾）
 */
function animateTo(to, done) {
  if (!win || win.isDestroyed()) return;
  const target = edge.toRect(to);
  if (!target) return;

  clearInterval(snap.animTimer);
  snap.animTimer = null;

  const from = win.getBounds();
  if (edge.sameRect(from, target)) {
    if (done) done();
    return;
  }

  const startedAt = Date.now();
  snap.animTimer = setInterval(() => {
    if (!win || win.isDestroyed()) {
      clearInterval(snap.animTimer);
      snap.animTimer = null;
      return;
    }
    const t = (Date.now() - startedAt) / edge.ANIM_MS;
    if (t >= 1) {
      clearInterval(snap.animTimer);
      snap.animTimer = null;
      applyBounds(target);
      if (done) done();
      return;
    }
    applyBounds(edge.lerpRect(from, target, edge.ease(t)));
  }, edge.ANIM_STEP_MS);
}

/** 藏起来。只在贴边显示中且那条边是虚拟桌面外沿时才会走到 */
function hideToEdge() {
  if (!win || win.isDestroyed() || !snap.edge || snap.hidden || !snap.shown) return;
  const wa = workAreaFor(snap.shown);
  const to = edge.hiddenBounds({ bounds: snap.shown, workArea: wa, edge: snap.edge });
  if (!to) return;
  snap.hidden = true;
  animateTo(to);
}

/** 滑回显示位置 */
function revealFromEdge() {
  if (!win || win.isDestroyed() || !snap.hidden || !snap.shown) return;
  snap.hidden = false;
  clearTimeout(snap.hideTimer);
  snap.hideTimer = null;
  animateTo(snap.shown);
}

/**
 * 光标轮询。
 *
 * 用轮询而不是 mouseenter/mouseleave：窗口藏到屏幕外之后渲染层收不到任何鼠标
 * 事件（那 6px 虽然可见，但 Chromium 的命中测试仍按窗口整体算，而且我们要在
 * 窗口**之外**的触发带上响应）。setIgnoreMouseEvents + 全屏透明层是另一条路，
 * 但那要多开一个窗口，成本高得多。
 *
 * 150ms × 一次 getCursorScreenPoint 的开销可以忽略，而且只在吸附态才跑。
 */
function pollCursor() {
  if (!win || win.isDestroyed() || !snap.edge || !snap.shown) return;
  // 拖动中不判：拖着窗口经过边缘时鼠标必然在窗口上，但松手前不该有任何吸附动作
  if (win.isDestroyed()) return;

  let cursor = null;
  try {
    cursor = screen.getCursorScreenPoint();
  } catch {
    return;
  }

  const wa = workAreaFor(snap.shown);

  if (snap.hidden) {
    const zone = edge.triggerZone({ shown: snap.shown, workArea: wa, edge: snap.edge });
    if (zone && edge.pointInRect(cursor, zone)) revealFromEdge();
    return;
  }

  // 显示中：鼠标离开窗口一段时间后藏起来。
  // 判定用放宽后的窗口矩形，避免贴边那一列像素上的抖动来回触发
  const area = edge.expandRect(snap.shown, edge.LEAVE_TOLERANCE);
  const inside = edge.pointInRect(cursor, area);

  if (inside) {
    clearTimeout(snap.hideTimer);
    snap.hideTimer = null;
    return;
  }

  // 启动宽限期内不藏：上次退出时贴着边，启动后立刻滑走会像启动失败
  if (Date.now() < snap.graceUntil) return;
  // 设置面板开着时不藏 —— 那时用户的手在键盘上，鼠标很可能不在窗口里，
  // 藏走会把他正在填的表单一起带出屏幕
  if (settingsOpen) return;
  if (snap.hideTimer) return;
  snap.hideTimer = setTimeout(() => {
    snap.hideTimer = null;
    hideToEdge();
  }, edge.HIDE_DELAY_MS);
}

function startCursorPoll() {
  if (snap.pollTimer) return;
  snap.pollTimer = setInterval(pollCursor, edge.POLL_MS);
}

/**
 * 窗口移动/尺寸变化后重新判定吸附。
 *
 * 由 moved / resized 调用。程序化移动（动画、模式切换的自动调高）必须挡掉，
 * 否则动画每一帧都会重新判定一次边缘，把中间位置当成新的 shown。
 */
function updateSnap() {
  if (!win || win.isDestroyed()) return;
  // 藏起来的时候收到 moved 一定是我们自己的动画（用户碰不到屏幕外的窗口），
  // 重新判定会把屏幕外的位置写进 shown
  if (snap.moving || snap.hidden || autoResizing) return;

  const bounds = win.getBounds();
  const wa = workAreaFor(bounds);
  const want = edge.detectEdge({ bounds, workArea: wa });

  if (!want) {
    if (snap.edge) releaseSnap();
    return;
  }

  const shown = edge.snapBounds({ bounds, workArea: wa, edge: want });
  if (!shown) return;

  snap.edge = want;
  snap.shown = shown;
  snap.hidden = false;
  clearSnapTimers();

  // 对齐贴边。这是用户能直接看到的那一下「啪」
  applyBounds(shown);
  /**
   * 对齐后的位置要落盘 —— applyBounds 带着 snap.moving 标记，它触发的 moved
   * 会被 persistBounds 挡掉，不显式记一次的话下次启动会回到用户松手时那个
   * 差几像素的位置，「贴边」看起来就没生效。
   *
   * 传显式矩形而不让它自己 getBounds：setBounds 才刚发出，读回来可能还是旧值。
   */
  persistBounds(shown);

  /**
   * 自动隐藏要同时满足三个条件，缺一个就只吸附不隐藏：
   *   1. 用户开了这个功能
   *   2. 那条边确实是虚拟桌面外沿（多屏时往内侧边藏 = 挪到隔壁屏中央）
   *   3. 窗口是可见的（藏在托盘里时轮询没有意义）
   */
  let displays = null;
  try {
    displays = screen.getAllDisplays();
  } catch {
    displays = null;
  }
  const canHide =
    autoHideEnabled() && edge.isOuterEdge({ shown, workArea: wa, edge: want, displays });

  if (canHide && win.isVisible()) startCursorPoll();
  else {
    clearInterval(snap.pollTimer);
    snap.pollTimer = null;
  }
}

/**
 * 自动隐藏开关变化后重新布置。
 *
 * 关掉时要把窗口放回来（releaseSnap 负责），开启时若当前已经贴边就直接开始轮询 ——
 * 不必让用户再拖一次窗口才生效。
 */
function applyAutoHideSetting() {
  if (!win || win.isDestroyed()) return;
  if (!autoHideEnabled()) {
    releaseSnap();
    return;
  }
  // 重新走一遍判定：它会按当前位置决定该不该开轮询
  const wasHidden = snap.hidden;
  snap.hidden = false;
  if (wasHidden && snap.shown) applyBounds(snap.shown);
  updateSnap();
}

/**
 * 设置面板是否开着。
 *
 * 只为「面板开着时不自动隐藏」这一件事存在：用户在填表单时手在键盘上，鼠标
 * 常常已经移出窗口，700ms 后窗口连着半填的表单一起滑出屏幕是很糟的体验。
 * 渲染层通过 set-settings-open 报过来。
 */
let settingsOpen = false;

/** IPC 统一返回 { ok, data?, error? } */
function ok(data) {
  return { ok: true, data };
}
function fail(err) {
  return { ok: false, error: String(err && err.message ? err.message : err) };
}

// —— 持仓来源的收口 ——

/**
 * 所有股票的实际生效持仓，形如 { [code]: {cost, shares} }。
 *
 * **流水优先，手填值降为回退**：某只股票记了流水就用回放推导的加权平均成本，
 * 忽略 watchlist 里手填的 cost/shares；没记流水的完全沿用原有行为。
 * 手填值不删 —— 用户清空流水后还能回落到它，旧版本也仍认得。
 *
 * 这是「持仓从哪来」的**唯一**出口。展开态盈亏、列表徽标、持仓汇总、
 * 预警的 profitPct 规则全都经过这里；任何地方绕过它直读 cfg.watchlist[].cost
 * 都会让两处显示不同的成本价。
 *
 * 返回整表而不是逐个查：collectWatchlist 要给整个关注列表算盈亏，
 * 逐只调用会把 trades.json 读上 N 遍。
 */
function holdingsFor() {
  try {
    return tradeStore ? tradeStore.allDerived() : {};
  } catch {
    // 流水文件读不了不该连带打掉行情：回落到手填值（覆盖表为空 = 全部回落）
    return {};
  }
}

/**
 * 单只股票的实际生效持仓，供 collectDetail 用。
 *
 * @returns {{cost, shares}|null} 既无流水又无手填时为 null
 */
function effectiveHolding(cfg, code) {
  const manual = (cfg.watchlist || []).find((w) => w.code === code) || null;
  const derived = holdingsFor();
  // 用 `in` 而非真值判断：流水显示已清仓时值是 {cost: null}，那也要生效，
  // 否则清仓后界面还挂着按旧成本算的浮动盈亏（那笔已落到「已实现」里）
  if (code in derived) return { ...manual, ...derived[code], fromTrades: true };
  return manual;
}

// —— 价格预警 ——

/**
 * 跑一遍预警并发通知。
 *
 * **挂在 get-watchlist 的返回路径上**而不是新起一路轮询：渲染层已经在按交易时段
 * 的节奏拉整个关注列表了（折叠态与列表态也拉），复用它等于零新增请求、
 * 零新增定时器，且天然覆盖所有窗口模式。
 *
 * 这层耦合要留意：预警的可靠性依赖「渲染层会持续调 get-watchlist」。若将来有人
 * 做了「某个模式下不拉 watchlist」这种看似合理的优化，预警会静默失效 ——
 * startAlertFallback 是第二道防线。
 *
 * 纯计算全在 alertRules.evaluateAlerts 里，这里只做三件副作用：
 * 发通知、写去重游标、记时间戳。
 *
 * @param {Array} items collectWatchlist 的结果
 */
function runAlerts(items) {
  lastAlertRunAt = Date.now();
  if (!alertStore) return;

  let cfg;
  try {
    cfg = store.load();
  } catch {
    return;
  }
  // 总开关关掉时仍然什么都不算：省掉一次文件读取。
  // 「关掉时仍算但不发通知」没有实际价值——没有别的地方消费这个结果
  if (!cfg.alerts || !cfg.alerts.enabled) return;

  const today = localDateKey();
  const state = alertStore.load();
  // 跨天重置：不用定时任务，每次算之前剔掉非今日的条目即可。
  // 顺带防止游标无限增长（用户改过很多次阈值的话历史键会累积）
  const fired = pruneFired(state.fired, today);

  const { alerts, nextFired } = evaluateAlerts({
    items,
    rulesByCode: cfg.alerts.rules,
    fired,
    today,
  });

  if (alerts.length === 0) {
    // prune 改动过游标（跨天了）也要落盘，否则每次启动都要重算一遍
    if (Object.keys(fired).length !== Object.keys(state.fired).length) {
      alertStore.save({ fired: nextFired });
    }
    return;
  }

  for (const a of alerts) notifyAlert(a);
  alertStore.save({ fired: nextFired });
}

/**
 * 发一条系统通知。
 *
 * 判 isSupported：Windows 上通知中心被组策略关掉时 new Notification 不抛错
 * 但也不显示，判一下至少能在终端留痕，便于排查「为什么没收到提醒」。
 *
 * 点击通知 → 唤出窗口、切到展开态、跳到那只股票。没有这个出口的话，
 * 用户看到通知还得自己回窗口里找是哪只触发了。
 */
function notifyAlert(a) {
  if (!Notification.isSupported()) {
    console.error('[alert] 系统不支持通知，跳过:', a.title);
    return;
  }
  const n = new Notification({ title: a.title, body: a.body, silent: false });
  n.on('click', () => {
    if (!win || win.isDestroyed()) {
      createWindow();
      refreshTrayMenu();
      return;
    }
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.setAlwaysOnTop(true, 'screen-saver');
    win.focus();
    // 折叠态与列表态都看不到详情，切过去才有意义
    setMode('expanded');
    win.webContents.send('alert-navigate', a.code);
  });
  n.show();
}

/** 保底定时器的检查间隔。空转成本可以忽略，真正的节流靠下面的时间戳判断 */
const ALERT_FALLBACK_MS = 30000;

/**
 * 保底轮询。
 *
 * 正常情况下预警搭渲染层的便车，这个定时器是空转的。但窗口藏进托盘后
 * Chromium 会节流甚至冻结渲染进程的定时器（backgroundThrottling 默认开），
 * 那时便车就没了。
 *
 * 所以只在「渲染层明显停了」时才自己拉一次：距上次跑预警超过 2 个轮询周期。
 *
 * 没有改用 webPreferences.backgroundThrottling:false —— 那会让整个渲染进程在
 * 窗口隐藏时继续满速跑所有定时器（K 线、新闻、五个分组），为了预警一件事
 * 付出全量代价，不划算。
 */
function startAlertFallback() {
  clearInterval(alertFallbackTimer);
  alertFallbackTimer = setInterval(async () => {
    let cfg;
    try {
      cfg = store.load();
    } catch {
      return;
    }
    if (!cfg.alerts || !cfg.alerts.enabled) return;
    if (!isConfigured(cfg)) return;

    const period = cfg.refreshMs > 0 ? cfg.refreshMs : pollIntervalMs();
    // 渲染层还在正常轮询，不必插手
    if (Date.now() - lastAlertRunAt < period * 2) return;

    try {
      const data = await collectWatchlist(cfg, {}, holdingsFor());
      runAlerts(data.items);
    } catch {
      // 预警取数失败不该有任何用户可见后果，静默跳过等下一轮
    }
  }, ALERT_FALLBACK_MS);
}

// —— IPC ——

ipcMain.handle('get-config', () => {
  try {
    return ok(store.load());
  } catch (err) {
    return fail(err);
  }
});

ipcMain.handle('save-config', (_e, cfg) => {
  try {
    const saved = store.save(cfg);
    if (win && !win.isDestroyed()) win.setOpacity(saved.opacity);
    // 自动隐藏开关可能刚被改。关掉时 applyAutoHideSetting 会把藏着的窗口放回来 ——
    // 少了这一步，用户在窗口藏着时关掉这个功能，窗口就永久留在屏幕外了
    applyAutoHideSetting();
    return ok(saved);
  } catch (err) {
    return fail(err);
  }
});

ipcMain.handle('patch-config', (_e, partial) => {
  try {
    const saved = store.patch(partial);
    // patch 也可能带 autoHide（设置面板里的勾选是即时生效的）
    if (partial && typeof partial === 'object' && 'autoHide' in partial) applyAutoHideSetting();
    return ok(saved);
  } catch (err) {
    return fail(err);
  }
});

/**
 * 渲染层报「设置面板开/关」。
 *
 * 只为一件事：面板开着时不自动隐藏。用户填表单时手在键盘上，鼠标常常已经移出
 * 窗口，700ms 后窗口连着半填的表单一起滑出屏幕 —— 而表单里可能有他刚敲了一半
 * 的股票代码和成本价。
 *
 * 状态放在主进程而不是「渲染层自己判断要不要报」：隐藏的决定权在主进程，
 * 它需要知道这个事实，而不是等渲染层来阻止。
 */
ipcMain.handle('set-settings-open', (_e, open) => {
  try {
    settingsOpen = open === true;
    // 关掉面板时，若鼠标已经在窗口外，让它按正常节奏进入隐藏倒计时（轮询会处理）。
    // 开着面板时把待执行的隐藏取消掉 —— 面板是刚打开的，倒计时可能已经在跑了
    if (settingsOpen) {
      clearTimeout(snap.hideTimer);
      snap.hideTimer = null;
      // 面板在藏起来的窗口里打开只能来自托盘菜单，先把窗口放回来
      if (snap.hidden) revealFromEdge();
    }
    return ok({ settingsOpen });
  } catch (err) {
    return fail(err);
  }
});

/** 当前吸附状态。给设置面板显示提示用（「已贴在右边」之类），也便于排查 */
ipcMain.handle('get-snap-state', () => {
  try {
    return ok({ edge: snap.edge, hidden: snap.hidden, autoHide: autoHideEnabled() });
  } catch (err) {
    return fail(err);
  }
});

// 关注列表行情快照（顶部下拉用）
ipcMain.handle('get-watchlist', async () => {
  try {
    const cfg = store.load();
    if (!isConfigured(cfg)) return { ok: false, needConfig: true, error: '尚未添加关注的股票' };
    // 持仓一律经 holdingsFor（流水优先），不直接采信 watchlist 里手填的值
    const data = await collectWatchlist(cfg, {}, holdingsFor());
    /**
     * 预警搭这趟车（见 runAlerts 的注释）。放在 return 之前、await 之后，
     * 拿到的是这一轮最新的整个关注列表 —— 预警必须对全部股票生效，
     * 而不只是当前选中那只。
     *
     * 不 await：通知与落盘不该拖慢行情返回。runAlerts 内部不抛错。
     */
    runAlerts(data.items);
    return ok(data);
  } catch (err) {
    return fail(err);
  }
});

// 单只股票：行情快照 + 当日分时
ipcMain.handle('get-detail', async (_e, code) => {
  try {
    const cfg = store.load();
    const target = code || cfg.selected;
    if (!target) return { ok: false, needConfig: true, error: '尚未选择股票' };
    // 持仓由 effectiveHolding 定（流水优先、手填回退），服务层不读配置也不读流水文件
    return ok(await collectDetail(target, {}, effectiveHolding(cfg, target), calendar));
  } catch (err) {
    return fail(err);
  }
});

// 单只股票：新闻 + 公告
ipcMain.handle('get-news', async (_e, code) => {
  try {
    const cfg = store.load();
    const target = code || cfg.selected;
    if (!target) return { ok: false, needConfig: true, error: '尚未选择股票' };
    return ok(await collectNews(target, cfg));
  } catch (err) {
    return fail(err);
  }
});

// 单只股票：日/周/月 K 线（含均线）
ipcMain.handle('get-kline', async (_e, code, params) => {
  try {
    const cfg = store.load();
    const target = code || cfg.selected;
    if (!target) return { ok: false, needConfig: true, error: '尚未选择股票' };
    return ok(await collectKline(target, params || {}));
  } catch (err) {
    return fail(err);
  }
});

// 单只股票：5 日连续分时
ipcMain.handle('get-minute5d', async (_e, code) => {
  try {
    const cfg = store.load();
    const target = code || cfg.selected;
    if (!target) return { ok: false, needConfig: true, error: '尚未选择股票' };
    return ok(await collectMinute5d(target));
  } catch (err) {
    return fail(err);
  }
});

ipcMain.handle('get-indicators', async (_e, code, params) => {
  try {
    const cfg = store.load();
    const target = code || cfg.selected;
    if (!target) return { ok: false, needConfig: true, error: '尚未选择股票' };
    return ok(await collectIndicators(target, params || {}));
  } catch (err) {
    return fail(err);
  }
});

ipcMain.handle('get-flow', async (_e, code, params) => {
  try {
    const cfg = store.load();
    const target = code || cfg.selected;
    if (!target) return { ok: false, needConfig: true, error: '尚未选择股票' };
    return ok(await collectFlow(target, params || {}));
  } catch (err) {
    return fail(err);
  }
});

// 单只股票：机构研报评级（与新闻页平级的独立区块）
ipcMain.handle('get-reports', async (_e, code, params) => {
  try {
    const cfg = store.load();
    const target = code || cfg.selected;
    if (!target) return { ok: false, needConfig: true, error: '尚未选择股票' };
    return ok(await collectReports(target, params || {}));
  } catch (err) {
    return fail(err);
  }
});

ipcMain.handle('get-margin', async (_e, code, params) => {
  try {
    const cfg = store.load();
    const target = code || cfg.selected;
    if (!target) return { ok: false, needConfig: true, error: '尚未选择股票' };
    return ok(await collectMargin(target, params || {}));
  } catch (err) {
    return fail(err);
  }
});

ipcMain.handle('get-finance', async (_e, code, params) => {
  try {
    const cfg = store.load();
    const target = code || cfg.selected;
    if (!target) return { ok: false, needConfig: true, error: '尚未选择股票' };
    return ok(await collectFinance(target, params || {}));
  } catch (err) {
    return fail(err);
  }
});

ipcMain.handle('get-lhb', async (_e, code, params) => {
  try {
    const cfg = store.load();
    const target = code || cfg.selected;
    if (!target) return { ok: false, needConfig: true, error: '尚未选择股票' };
    return ok(await collectLhb(target, params || {}));
  } catch (err) {
    return fail(err);
  }
});

// —— 价格预警的 IPC ——

ipcMain.handle('get-alerts', () => {
  try {
    return ok(store.load().alerts);
  } catch (err) {
    return fail(err);
  }
});

/**
 * 保存预警配置。
 *
 * 走 patch 而非 save：那边对 alerts 做了深合并，只提交 enabled 时不会
 * 把 rules 冲掉（见 config.js 的 patch）。
 */
ipcMain.handle('save-alerts', (_e, alerts) => {
  try {
    return ok(store.patch({ alerts }).alerts);
  } catch (err) {
    return fail(err);
  }
});

/**
 * 发一条测试通知。
 *
 * Windows 上通知可能被专注助手、系统通知设置或缺失的 AppUserModelID 静默吞掉。
 * 没有这个按钮，用户无法区分「规则没命中」与「通知发出去了但系统没显示」。
 */
ipcMain.handle('test-alert', () => {
  try {
    if (!Notification.isSupported()) {
      return { ok: false, error: '系统不支持通知' };
    }
    new Notification({
      title: '股票行情：测试通知',
      body: '能看到这条，说明通知通道正常。真实预警会写明是哪只股票触发了哪条规则。',
    }).show();
    return ok({ sent: true });
  } catch (err) {
    return fail(err);
  }
});

/**
 * 清空去重游标。
 *
 * 用途：改完规则想立刻重新收到提醒。规则的阈值变了本来就算新规则（ruleKey 含
 * value），但只改了「启用/停用」或想重新收一遍今天已提醒过的，就需要这个。
 */
ipcMain.handle('reset-alert-state', () => {
  try {
    return ok({ cleared: alertStore ? alertStore.clear() : false });
  } catch (err) {
    return fail(err);
  }
});

// —— 交易流水 ——

/**
 * 某只股票的流水与回放结果。
 *
 * 读操作宽容：代码非法或无记录时返回空列表 + 零值 summary，不报错 ——
 * 界面切到一只有问题的股票不该整块崩掉。写操作（下面三个）则严格。
 */
ipcMain.handle('get-trades', (_e, code) => {
  try {
    const target = code || store.load().selected;
    if (!target) return { ok: false, needConfig: true, error: '尚未选择股票' };
    return ok({ ...tradeStore.summaryFor(target), loadError: tradeStore.loadError });
  } catch (err) {
    return fail(err);
  }
});

ipcMain.handle('add-trade', (_e, code, trade) => {
  try {
    return ok(tradeStore.add(code, trade));
  } catch (err) {
    return fail(err);
  }
});

ipcMain.handle('remove-trade', (_e, code, tradeId) => {
  try {
    return ok(tradeStore.remove(code, tradeId));
  } catch (err) {
    return fail(err);
  }
});

// 设置面板整段保存
ipcMain.handle('save-trades', (_e, code, list) => {
  try {
    return ok(tradeStore.replaceFor(code, list));
  } catch (err) {
    return fail(err);
  }
});

/**
 * 已实现盈亏汇总。
 *
 * range='month' 只算当月，'all' 算全部。当月的判定用主进程的本地日期 ——
 * 渲染层与主进程理论上同一台机器，但把「今天是哪天」交给一处决定，
 * 免得跨零点时两边算出不同的月份。
 *
 * @param {{ range?: 'month'|'all', code?: string }} params
 *   给了 code 就只算那一只，否则算全部关注股票的合计
 */
ipcMain.handle('get-realized', (_e, params) => {
  try {
    const p = params || {};
    const range = p.range === 'month' ? 'month' : 'all';
    const today = localDateKey();

    if (p.code) {
      const { summary } = tradeStore.summaryFor(p.code);
      return ok({
        range,
        total: realizedInRange(summary, range, today),
        byMonth: summary.realizedByMonth,
        hasTrades: summary.lots.length > 0,
      });
    }

    const all = tradeStore.realizedAll();
    const total = range === 'month' ? all.byMonth[today.slice(0, 7)] || 0 : all.total;
    return ok({ range, total, byMonth: all.byMonth, byCode: all.byCode });
  } catch (err) {
    return fail(err);
  }
});

// 设置面板：搜索股票
ipcMain.handle('search-stocks', async (_e, keyword) => {
  try {
    return ok(await searchStocks(keyword));
  } catch (err) {
    return fail(err);
  }
});

// 当前时段建议的轮询间隔（渲染层据此定时）
ipcMain.handle('get-poll-interval', () => {
  try {
    const cfg = store.load();
    // 用户显式设置了间隔就用它，否则按时段自动
    return ok({ ms: cfg.refreshMs > 0 ? cfg.refreshMs : pollIntervalMs(), auto: cfg.refreshMs === 0 });
  } catch (err) {
    return fail(err);
  }
});

// —— 窗口模式（三态）——

ipcMain.handle('get-mode', () => {
  try {
    return ok({ mode });
  } catch (err) {
    return fail(err);
  }
});

/** @param {string} next 目标模式 @param {number} [rowCount] 列表行数 */
ipcMain.handle('set-mode', (_e, next, rowCount) => {
  try {
    return ok(setMode(next, rowCount));
  } catch (err) {
    return fail(err);
  }
});

// 按 expanded → list → collapsed → expanded 轮换。Ctrl+M / 双击标题栏走这条
ipcMain.handle('cycle-mode', (_e, rowCount) => {
  try {
    return ok(setMode(layout.nextMode(mode), rowCount));
  } catch (err) {
    return fail(err);
  }
});

/**
 * 列表模式按行数定高。
 *
 * 与 set-auto-height 分开：那个按**像素**（渲染层要等布局完成再量），
 * 这个按**行数**（数据到手就知道，少一帧抖动）。两者的几何规则也不同，
 * 合成一个 handler 会让参数语义变得含糊。
 */
ipcMain.handle('set-list-height', (_e, rowCount) => {
  try {
    if (rowCount != null) lastRowCount = rowCount;
    if (!win || win.isDestroyed() || mode !== 'list') return ok({ applied: false });

    /**
     * 用户手动拖过高度后就完全不再自动调整 —— listBounds 内部会优先用
     * userHeight，所以这里传进去即可；但更早返回能省掉一次 getBounds 与
     * setBounds 的判断，也让「为什么没生效」在日志里说得清
     */
    const userHeight = store.load().listHeight;
    if (userHeight != null) return ok({ applied: false, reason: 'user-sized', height: userHeight });

    const current = win.getBounds();
    const next = layout.listBounds(current, lastRowCount, null);
    if (next.height === current.height) return ok({ applied: false, height: current.height });

    // 与 set-auto-height 同一个理由：这是程序化调整，不该被当成
    // 「用户手动拖到多高」写进配置
    autoResizing = true;
    try {
      win.setBounds(next);
    } finally {
      setImmediate(() => {
        autoResizing = false;
      });
    }
    return ok({ applied: true, height: next.height });
  } catch (err) {
    return fail(err);
  }
});

/**
 * 旧通道，保留为薄封装。
 *
 * 成本一行，换来的是「preload 与 main 版本不匹配时不白屏」——
 * 打包后用户可能拿到混搭的资源。
 */
/**
 * 清掉「用户手动设的列表高度」，回到按行数自动定高。
 *
 * 「拖过就完全听用户」是不可逆的决定 —— 这是它的回退路径。清完立刻按当前
 * 行数调一次，用户不必再切一遍模式才看到效果。
 */
ipcMain.handle('reset-list-height', () => {
  try {
    store.patch({ listHeight: null });
    if (!win || win.isDestroyed() || mode !== 'list') return ok({ reset: true, applied: false });

    const next = layout.listBounds(win.getBounds(), lastRowCount, null);
    autoResizing = true;
    try {
      win.setBounds(next);
    } finally {
      setImmediate(() => {
        autoResizing = false;
      });
    }
    return ok({ reset: true, applied: true, height: next.height });
  } catch (err) {
    return fail(err);
  }
});

ipcMain.handle('set-collapsed', (_e, next) => {
  try {
    return ok(setMode(next ? 'collapsed' : 'expanded'));
  } catch (err) {
    return fail(err);
  }
});

/**
 * 按渲染层量出的内容高度调整窗口。
 *
 * 渲染层只报「内容需要多高」，是否照办、上下限怎么夹由这里决定 ——
 * 屏幕工作区与用户手动高度都只有主进程知道。
 *
 * 只在展开态生效：折叠态高度固定 40px、列表态由行数决定，两者都由
 * setMode / set-list-height 掌管，这里插一脚会把它们撑开。
 */
ipcMain.handle('set-auto-height', (_e, needed) => {
  try {
    if (!win || win.isDestroyed() || mode !== 'expanded') return ok({ applied: false });

    const current = win.getBounds();
    const stored = store.load().bounds;
    // 窗口所在那块屏的工作区（多显示器下不能用主屏的）
    const workArea = screen.getDisplayMatching(current).workArea;

    const next = layout.autoBounds({
      needed,
      userHeight: stored && stored.height,
      current,
      workArea,
    });

    // 高度与位置都没变就别调用 setBounds：每次调用都会触发一次 resized，
    // 白白引起重排
    if (next.height === current.height && next.y === current.y) {
      return ok({ applied: false, height: current.height });
    }

    autoResizing = true;
    try {
      win.setBounds(next);
    } finally {
      // resized 是同步派发的，但保险起见放在微任务后清标记，
      // 避免异步派发时漏掉一次拦截
      setImmediate(() => {
        autoResizing = false;
      });
    }
    return ok({ applied: true, height: next.height, y: next.y });
  } catch (err) {
    return fail(err);
  }
});

ipcMain.handle('open-external', (_e, url) => {
  if (url && /^https?:\/\//.test(url)) shell.openExternal(url);
  return ok(true);
});

ipcMain.handle('quit-app', () => {
  app.quit();
  return ok(true);
});

/**
 * 单实例锁。
 *
 * 必须在 app.whenReady() **之前**拿,且拿不到就什么都不做 —— 继续往下走会建
 * 第二个窗口、第二个 configStore,两个进程交替「读全量 → 合并 → 写全量」,
 * 后写的那个会静默丢掉前一个的改动(config.patch 不是原子的,也没有文件锁)。
 *
 * 顶层的 ipcMain.handle 注册留在外面不动:第二个实例马上就退出了,
 * 注册几个 handler 无害,把它们也包进来只是白添一层缩进。
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  /**
   * 第二次启动时用户的诉求就是「让我看到窗口」,所以三种状态都要处理:
   * 窗口被关掉过(有托盘时不随之退出)、最小化、以及藏在托盘里。
   */
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) {
      createWindow();
      refreshTrayMenu();
      return;
    }
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    // 长时间隐藏后 alwaysOnTop 可能被系统降级,重新置顶
    win.setAlwaysOnTop(true, 'screen-saver');
    win.focus();
    refreshTrayMenu();
  });

  app.whenReady().then(() => {
    // Windows 上不设 AppUserModelID 的话,系统通知可能不显示图标甚至整条被吞掉。
    // 与 package.json 的 build.appId 保持一致
    if (process.platform === 'win32') app.setAppUserModelId('com.local.stock-watch-widget');
    store = createConfigStore(app.getPath('userData'));
    tradeStore = createTradeStore(app.getPath('userData'));
    alertStore = createAlertStore(app.getPath('userData'));
    createWindow();
    createTray();
    // 只在窗口藏起来、渲染层定时器被冻结时才真正发请求，平时空转
    startAlertFallback();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  // 有托盘时窗口关掉不等于要退出——留驻等托盘唤回。
  // 没有托盘（图标缺失等）则照旧退出，否则会剩一个无任何入口的孤儿进程
  if (!tray || tray.isDestroyed()) app.quit();
});

app.on('before-quit', () => {
  // 不显式销毁的话，退出后托盘图标会残留在通知区域直到鼠标划过
  if (tray && !tray.isDestroyed()) {
    tray.destroy();
    tray = null;
  }
  // 退出过程中不该还在发行情请求
  clearInterval(alertFallbackTimer);
  alertFallbackTimer = null;
  // 光标轮询与滑动动画同理：quit 过程中还在 setBounds 会碰到已销毁的窗口
  clearSnapTimers();
  clearInterval(snap.pollTimer);
  snap.pollTimer = null;
});
