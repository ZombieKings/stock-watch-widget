'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// 安全桥接：只暴露必要接口，渲染层拿不到 Node/fs/net
contextBridge.exposeInMainWorld('api', {
  // 配置
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),
  patchConfig: (partial) => ipcRenderer.invoke('patch-config', partial),
  // 数据
  getWatchlist: () => ipcRenderer.invoke('get-watchlist'),
  getDetail: (code) => ipcRenderer.invoke('get-detail', code),
  getNews: (code) => ipcRenderer.invoke('get-news', code),
  getKline: (code, params) => ipcRenderer.invoke('get-kline', code, params),
  getMinute5d: (code) => ipcRenderer.invoke('get-minute5d', code),
  getIndicators: (code, params) => ipcRenderer.invoke('get-indicators', code, params),
  getFlow: (code, params) => ipcRenderer.invoke('get-flow', code, params),
  getReports: (code, params) => ipcRenderer.invoke('get-reports', code, params),
  getMargin: (code, params) => ipcRenderer.invoke('get-margin', code, params),
  getFinance: (code, params) => ipcRenderer.invoke('get-finance', code, params),
  getLhb: (code, params) => ipcRenderer.invoke('get-lhb', code, params),
  searchStocks: (keyword) => ipcRenderer.invoke('search-stocks', keyword),
  getPollInterval: () => ipcRenderer.invoke('get-poll-interval'),
  // 交易流水。持仓有流水时由它推导，手填的 cost/shares 降为回退
  getTrades: (code) => ipcRenderer.invoke('get-trades', code),
  addTrade: (code, trade) => ipcRenderer.invoke('add-trade', code, trade),
  removeTrade: (code, tradeId) => ipcRenderer.invoke('remove-trade', code, tradeId),
  saveTrades: (code, list) => ipcRenderer.invoke('save-trades', code, list),
  getRealized: (params) => ipcRenderer.invoke('get-realized', params),
  // 价格预警
  getAlerts: () => ipcRenderer.invoke('get-alerts'),
  saveAlerts: (alerts) => ipcRenderer.invoke('save-alerts', alerts),
  testAlert: () => ipcRenderer.invoke('test-alert'),
  resetAlertState: () => ipcRenderer.invoke('reset-alert-state'),
  // 交互
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  quitApp: () => ipcRenderer.invoke('quit-app'),
  // 窗口模式（三态：expanded / list / collapsed）
  getMode: () => ipcRenderer.invoke('get-mode'),
  setMode: (mode, rowCount) => ipcRenderer.invoke('set-mode', mode, rowCount),
  cycleMode: (rowCount) => ipcRenderer.invoke('cycle-mode', rowCount),
  // 列表模式按行数定高。与 setAutoHeight 分开——那个按像素，这个按行数。
  // 用户手动拖过高度后主进程会忽略它（listHeight 成为权威值）
  setListHeight: (rowCount) => ipcRenderer.invoke('set-list-height', rowCount),
  // 清掉手动设的列表高度，回到按行数自动定高
  resetListHeight: () => ipcRenderer.invoke('reset-list-height'),
  // 窗口高度自适应：渲染层报内容所需高度，主进程决定实际尺寸（仅展开态）
  setAutoHeight: (needed) => ipcRenderer.invoke('set-auto-height', needed),
  // 主进程右键菜单推送
  onRefresh: (cb) => ipcRenderer.on('refresh', () => cb()),
  onOpenSettings: (cb) => ipcRenderer.on('open-settings', () => cb()),
  // 模式由主进程掌握（托盘与右键菜单也能切），变更后推给渲染层同步 DOM
  onModeChanged: (cb) => ipcRenderer.on('mode-changed', (_e, v) => cb(v)),
  /**
   * 点了预警通知后主进程要求切到某只股票。
   * 与 onModeChanged 同样是「主进程决定、渲染层跟随」的单向推送
   */
  onAlertNavigate: (cb) => ipcRenderer.on('alert-navigate', (_e, code) => cb(code)),
});
