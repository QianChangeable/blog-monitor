'use strict';

const api = window.blogWidget;
const $ = (id) => document.getElementById(id);

const POLL_MS = 5000;
const CUSTOM_DIR = '__custom__';
const MAX_LOG_LINES = 400;
// 左下角胶囊切换的三个页面。设置不在这里 —— 它是底部齿轮打开的独立面板。
// label 是胶囊与菜单里的短标签（太长会被省略号截断），title 是完整名，只做提示
const VIEWS = [
  { id: 'home', label: '主页', title: '主页', icon: 'icon-house' },
  { id: 'create', label: '新建', title: '新建文章', icon: 'icon-doc' },
  { id: 'deploy', label: '发布', title: '发布与备份', icon: 'icon-publish' }
];

let currentView = 'home';
let viewMenuOpen = false;

let settings = null;
let lastRealDir = 'blog';
let previewRunning = false;
let previewBusy = false;
let deployRunning = false;
let backgroundActive = false;
let backgroundSource = '';
let backgroundObjectUrl = null;
let toastTimer = null;

// --------------------------------------------------------------------- ui

function hideToast() {
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = null;
  $('toast').className = 'toast hidden';
}

function showToast(message, kind = 'info', ms = 4200) {
  const toast = $('toast');
  toast.textContent = message;
  toast.className = `toast${kind === 'info' ? '' : ` ${kind}`}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ms);
}

// 底栏状态行。除了常驻状态，还有一类"确认一下就消失"的提示（已保存 / 已刷新）：
// 那些用 setTransientStatus，几秒后自动切回空闲状态。错误不自动消失 —— 用户需要看到它。
let statusRevertTimer = null;

function idleStatus() {
  return previewRunning ? '本地预览运行中' : '就绪';
}

function setStatusLine(message, isError = false) {
  clearTimeout(statusRevertTimer);
  statusRevertTimer = null;
  const line = $('statusText');
  line.textContent = message;
  line.classList.toggle('error', isError);
}

// 标题栏的置顶开关：先应用（界面即时反映），再走现有的保存链路记住它。
function syncPinButton() {
  const button = $('pinBtn');
  if (!button) return;
  const on = !!(settings && settings.alwaysOnTop === true);
  button.classList.toggle('is-active', on);
  button.setAttribute('aria-pressed', String(on));
  button.title = on ? '取消置顶' : '置顶（浮在其他窗口上方）';
}

async function toggleAlwaysOnTop() {
  const button = $('pinBtn');
  const next = !(settings && settings.alwaysOnTop === true);
  if (button) button.disabled = true;
  try {
    if (typeof api.setAlwaysOnTop !== 'function') {
      // 这条通道在主进程里：只按 Cmd+R 重载渲染层是拿不到的
      showToast('置顶需要重启应用\n（改过 main.js / preload.js 后 Cmd+R 不够）', 'error', 8000);
      return;
    }
    const applied = await api.setAlwaysOnTop(next);
    if (!applied || !applied.ok) {
      showToast(`切换置顶失败：${(applied && applied.error) || '未知原因'}`, 'error', 8000);
      return;
    }
    settings = { ...settings, alwaysOnTop: applied.alwaysOnTop === true };
    syncPinButton();
    await persistSettings();
  } catch (error) {
    showToast(`切换置顶失败：${(error && error.message) || error}`, 'error', 8000);
  } finally {
    if (button) button.disabled = false;
  }
}

function setTransientStatus(message, holdMs = 2000) {
  setStatusLine(message);
  statusRevertTimer = setTimeout(() => {
    statusRevertTimer = null;
    // 这几秒里如果开始部署了，就别把部署提示抢掉
    if (!deployRunning) setStatusLine(idleStatus());
  }, holdMs);
}

// 只在预览状态真的变化时才动底栏状态文字。否则 5 秒一次的轮询会把
// "已保存"、保存失败的红字等提示在几秒内抹掉，用户根本看不到。
let lastPreviewKey = null;

function setPreviewUI({ running, starting }) {
  const key = `${Boolean(running)}|${Boolean(starting)}`;
  const changed = key !== lastPreviewKey;
  lastPreviewKey = key;
  previewRunning = Boolean(running);
  const toggle = $('previewToggle');
  toggle.checked = previewRunning;
  toggle.disabled = previewBusy || deployRunning || Boolean(starting);
  $('liveDot').classList.toggle('live', previewRunning);
  $('liveDot').title = previewRunning ? '本地预览运行中' : '本地预览未运行';
  $('statusLine').classList.toggle('is-running', previewRunning);
  // 颜色直接写内联：那条 .is-running .status-dot 的规则同样"写对了却不生效"，
  // 为它继续排查不划算（按钮那次已经耗了三轮）。内联一定生效。
  $('statusDot').style.background = previewRunning ? 'var(--accent)' : '';
  $('statusDot').title = previewRunning ? '本地预览运行中' : '本地预览未运行';
  $('quickMeta').textContent = previewRunning ? '运行中' : '已停止';

  if (previewBusy) $('previewDesc').textContent = '处理中…';
  else if (previewRunning) $('previewDesc').textContent = settings ? settings.previewUrl : '';
  else $('previewDesc').textContent = '停止状态';

  if (!deployRunning && changed) setStatusLine(previewRunning ? '本地预览运行中' : '就绪');
}

// ------------------------------------------------------------ post folder

function usingCustomDir() {
  return $('dirSelect').value === CUSTOM_DIR;
}

function effectiveDir() {
  return usingCustomDir() ? $('dirInput').value.trim() : $('dirSelect').value;
}

function updatePathHint() {
  const dir = effectiveDir() || '…';
  $('pathHint').textContent = `source/_posts/${dir}/<标题>.md`;
}

// The select and the free-text input are two views of one choice: a folder that
// already exists, or one you are about to create (diary/202610).
function syncDirUI() {
  const custom = usingCustomDir();
  $('dirSelect').classList.toggle('hidden', custom);
  $('dirInput').classList.toggle('hidden', !custom);
  if (custom) {
    if (!$('dirInput').value.trim()) $('dirInput').value = lastRealDir;
    $('dirInput').focus();
  }
  updatePathHint();
}

// Options are rebuilt on every scan. The current choice is kept even when it is
// not in the scan result, so a folder that vanished does not silently change
// the target.
function renderDirOptions(directories) {
  const select = $('dirSelect');
  const wanted = (select.value && select.value !== CUSTOM_DIR ? select.value : '') || lastRealDir;
  const dirs = [...new Set([...(directories || []), wanted].filter(Boolean))]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  select.textContent = '';
  for (const dir of dirs) {
    const option = document.createElement('option');
    option.value = dir;
    option.textContent = dir;
    select.appendChild(option);
  }
  const custom = document.createElement('option');
  custom.value = CUSTOM_DIR;
  custom.textContent = '自定义…';
  select.appendChild(custom);

  const known = dirs.includes(wanted);
  select.value = known ? wanted : CUSTOM_DIR;
  if (known) lastRealDir = wanted;
  syncDirUI();
}

async function refreshDirOptions() {
  const result = await api.listPostDirectories();
  renderDirOptions(result.ok ? result.directories : []);
}

// 逐字段回填。主进程没给这个字段时（例如它是旧版本、或 settings.json 缺键）
// 就保持输入框原样 —— 直接 `.value = undefined` 会在框里显示字面量 "undefined"，
// 用户一点保存就把它存成真的文案。
function fillInput(id, value) {
  if (value === undefined || value === null) return;
  $(id).value = String(value);
}

function applySettings(next) {
  settings = next;
  backgroundSource = next.backgroundImageSource || '';
  if (next.postsDir) lastRealDir = next.postsDir;
  lastSavedRoot = next.hexoRoot;
  $('liveUrlText').textContent = next.liveUrl;
  fillInput('liveUrlInput', next.liveUrl);
  fillInput('hexoRootInput', next.hexoRoot);
  fillInput('portInput', next.port);
  $('edgeBrowserInput').checked = next.edgeBrowser;
  $('openAfterCreateInput').checked = next.openAfterCreate;
  fillInput('typedContentInput', next.typedContent);
  fillInput('sayTextInput', next.sayText);
  fillInput('signatureTextInput', next.signatureText);
  syncPinButton();
  applyTexts();
  showTypedSpeed(next.typedSpeed);
  $('systemGlassInput').checked = next.systemGlass;
  applyAlpha(next.backgroundImageAlpha);
  applyGlass(next.glassOpacity);
  applyDepth(next.glassBlur);
  applyZoom(Math.round((Number(next.zoomFactor) || 1) * 100));
  lastTypedSignature = typedSignature();
  startTyped();
  refreshSettingsSummaries();
  if (!next.valid) setStatusLine(next.validError, true);
}

function basename(target) {
  const parts = String(target || '').split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(target || '');
}

// The right-hand summary on each settings card (the reference's
// .settings-section-summary): a compact restatement of the card's state.
function refreshSettingsSummaries() {
  if (!settings) return;
  $('siteSummary').textContent = `${basename(settings.hexoRoot)} · ${settings.port}`;
  $('lookSummary').textContent = backgroundActive ? `背景图 开 · ${$('alphaInput').value}%` : '背景图 关';
  $('behaviorSummary').textContent = `${settings.edgeBrowser ? 'Edge' : '默认浏览器'} · ${settings.openAfterCreate ? '自动打开' : '不打开'}`;
  $('typedSummary').textContent = typedStrings()[0];
  $('typedSpeedMeta').textContent = `${typedSpeed()}ms`;
}

function resetForm() {
  $('titleInput').value = '';
  $('dateInput').value = '';
  $('categoriesInput').value = '';
  $('tagsInput').value = '';
  $('stickyInput').value = '';
  $('abstractInput').value = '';
}

// ------------------------------------------------------------ modules/nav

function isExpanded(toggle) {
  return toggle.getAttribute('aria-expanded') === 'true';
}

// Both the main-panel modules and the settings cards collapse the same way:
// .hidden drives .accordion-animated-container's grid-template-rows, so the
// height animates without anyone measuring it.
function wireCollapse(toggleId, bodyId) {
  const toggle = $(toggleId);
  toggle.addEventListener('click', () => {
    const expand = !isExpanded(toggle);
    toggle.setAttribute('aria-expanded', String(expand));
    $(bodyId).classList.toggle('hidden', !expand);
    const card = toggle.closest('.settings-collapsible-group') || toggle.closest('.module');
    if (card) card.classList.toggle('expanded', expand);
  });
}

// The gear opens the settings panel above the content; it expands downwards and
// pushes everything below it down, exactly like the reference.
function setSettingsPanelOpen(open) {
  $('settingsPanel').classList.toggle('hidden', !open);
  $('settingsBtn').classList.toggle('active', open);
}

function openSettingsPanel() {
  setSettingsPanelOpen(true);
}

function toggleSettingsPanel() {
  setSettingsPanelOpen($('settingsPanel').classList.contains('hidden'));
}

// --------------------------------------------------------------- 页面切换
//
// 左下角胶囊在三个页面之间切换。做法照 token-monitor 的 viewSwitcher：
// 悬停箭头即展开、420ms 长按展开、鼠标移开后 160ms 收起、方向键/Home/End 在项间移动、
// 点标签去往下一个页面；悬停刚展开的那一次 click 要被吞掉，否则会立刻又关掉。
// 区别只有一处：参考每次都重建切换器 DOM（它的页面列表是动态的），这边页面固定，
// 标记写在 HTML 里，这里只切状态。

function viewById(id) {
  return VIEWS.find((view) => view.id === id) || VIEWS[0];
}

function viewElement(id) {
  return document.querySelector(`.view[data-view="${id}"]`);
}

function setView(id, { focusDisclosure = false } = {}) {
  const next = viewById(id);
  currentView = next.id;
  for (const view of VIEWS) {
    const element = viewElement(view.id);
    if (element) element.classList.toggle('hidden', view.id !== next.id);
  }
  $('panel').scrollTop = 0;
  // 新建页的头（目录 + 模式按钮）在滚动区之外，所以显隐要跟着视图走
  $('createHead').classList.toggle('hidden', next.id !== 'create');
  renderPill();
  // 进新建页时刷新两处依赖目录的东西。挂在这里而不是菜单项点击里：胶囊标签
  // 循环切页（主页→新建）、程序里跳转也都会经过 setView，挂在菜单项上会漏。
  if (next.id === 'create') {
    refreshDirOptions();
    setCreateMode(createMode);
    clearPastedImage();
  }
  if (focusDisclosure) requestAnimationFrame(() => $('viewDisclosure').focus());
}

function renderPill() {
  const current = viewById(currentView);
  const next = viewById(VIEWS[(VIEWS.indexOf(current) + 1) % VIEWS.length]);

  $('viewPillLabel').textContent = current.label;
  const currentButton = $('viewCurrent');
  currentButton.title = `下一个：${next.title}`;
  currentButton.setAttribute('aria-label', currentButton.title);

  const icon = $('viewIcon');
  for (const view of VIEWS) icon.classList.remove(view.icon);
  icon.classList.add(current.icon);

  for (const item of document.querySelectorAll('.view-switcher-menu-item')) {
    const isCurrent = item.dataset.view === current.id;
    item.classList.toggle('is-current', isCurrent);
    item.setAttribute('aria-checked', String(isCurrent));
    if (isCurrent) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
    item.tabIndex = viewMenuOpen && isCurrent ? 0 : -1;
  }
}

function updateViewMenuState({ focusMenu = false, focusDisclosure = false } = {}) {
  $('viewSwitcher').classList.toggle('is-open', viewMenuOpen);
  $('viewMenu').classList.toggle('hidden', !viewMenuOpen);
  $('viewMenu').setAttribute('aria-hidden', String(!viewMenuOpen));
  $('viewDisclosure').setAttribute('aria-expanded', String(viewMenuOpen));
  renderPill();
  if (focusMenu) requestAnimationFrame(() => $('viewMenu').querySelector('.is-current')?.focus());
  if (focusDisclosure) requestAnimationFrame(() => $('viewDisclosure').focus());
}

function setViewSwitcherOpen(open, options = {}) {
  const nextOpen = Boolean(open);
  if (viewMenuOpen === nextOpen && !options.focusMenu && !options.focusDisclosure) return;
  viewMenuOpen = nextOpen;
  updateViewMenuState(options);
}

function closeViewMenu() {
  setViewSwitcherOpen(false);
}

// 菜单里的键盘导航：Esc 关闭并把焦点还给箭头，方向键/Home/End 在项间移动
function handleViewMenuKeydown(event) {
  const items = Array.from($('viewMenu').querySelectorAll('.view-switcher-menu-item'));
  if (event.key === 'Escape') {
    event.preventDefault();
    setViewSwitcherOpen(false, { focusDisclosure: true });
    return;
  }
  const direction = event.key === 'ArrowDown' || event.key === 'ArrowRight'
    ? 1
    : (event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 0);
  if (!direction && event.key !== 'Home' && event.key !== 'End') return;
  event.preventDefault();
  const currentIndex = Math.max(0, items.indexOf(document.activeElement));
  const nextIndex = event.key === 'Home'
    ? 0
    : (event.key === 'End' ? items.length - 1 : (currentIndex + direction + items.length) % items.length);
  items[nextIndex]?.focus();
}

function wireViewSwitcher() {
  const currentButton = $('viewCurrent');
  currentButton.addEventListener('click', () => {
    setViewSwitcherOpen(false);
    const index = VIEWS.findIndex((view) => view.id === currentView);
    setView(VIEWS[(index + 1) % VIEWS.length].id);
  });
  // 长按展开去掉了：它会让"按得稍久一点的一次普通点击"顺手把菜单弹出来 ——
  // 用户反馈的"切换页面后没移开鼠标却自动展开"就是这个。现在只有点箭头才开合。

  // 箭头：点击才开合 —— 不做悬停展开。悬停展开是我上一轮加错的：鼠标路过就会弹出，
  // 而且一旦"打开过"，之后每次划过都会弹。参考也是纯点击驱动的。
  const disclosure = $('viewDisclosure');
  disclosure.addEventListener('click', () => {
    setViewSwitcherOpen(!viewMenuOpen, { focusMenu: !viewMenuOpen });
  });

  for (const item of $('viewMenu').querySelectorAll('.view-switcher-menu-item')) {
    item.addEventListener('click', () => {
      setViewSwitcherOpen(false);
      setView(item.dataset.view);
    });
  }
  $('viewMenu').addEventListener('keydown', handleViewMenuKeydown);
}

// ------------------------------------------------------------- background

function applyAlpha(value) {
  const alpha = clampNumber(value, 0, 100, APPEARANCE_DEFAULTS.backgroundImageAlpha);
  $('shell').style.setProperty('--background-image-alpha', String(alpha / 100));
  $('alphaValue').textContent = `${alpha}%`;
  $('alphaInput').value = String(alpha);
  refreshSettingsSummaries();
}

// The PNG arrives as bytes and is shown through a blob: URL. A data: URL is not
// an option: Blink silently truncates CSS values set via setProperty() at
// 2 MiB, which corrupts the url("data:…") value and renders nothing.
function applyBackgroundImage(bytes) {
  const buffer = bytes instanceof Uint8Array && bytes.byteLength > 0 ? bytes : null;
  backgroundActive = buffer !== null;

  if (backgroundObjectUrl) {
    URL.revokeObjectURL(backgroundObjectUrl);
    backgroundObjectUrl = null;
  }

  const shell = $('shell');
  if (backgroundActive) {
    backgroundObjectUrl = URL.createObjectURL(new Blob([buffer], { type: 'image/png' }));
    shell.style.setProperty('--custom-background-image', `url("${backgroundObjectUrl}")`);
  } else {
    shell.style.removeProperty('--custom-background-image');
  }
  shell.classList.toggle('has-custom-background', backgroundActive);
  $('clearBgBtn').classList.toggle('hidden', !backgroundActive);
  // 显示选中那张图的完整路径（老数据没有记录时退回"已设置"）。整行放不下就省略号截断，
  // 完整路径挂在 title 上。
  const description = backgroundActive ? (backgroundSource || '已设置') : '未设置';
  $('bgDesc').textContent = description;
  $('bgDesc').title = backgroundActive ? backgroundSource : '';
  refreshSettingsSummaries();
}

async function loadBackgroundImage() {
  const result = await api.getBackgroundImage();
  applyBackgroundImage(result && result.ok ? result.bytes : null);
  if (result && !result.ok) showToast(`背景图读取失败：${result.error}`, 'error', 6000);
}

async function chooseBackgroundImage() {
  const result = await api.chooseBackgroundImage();
  if (!result.ok) {
    if (!result.canceled) showToast(result.error, 'error', 7000);
    return;
  }
  backgroundSource = result.source || '';
  applyBackgroundImage(result.bytes);
  showToast('背景图已更新', 'ok');
}

async function clearBackgroundImage() {
  const result = await api.clearBackgroundImage();
  if (!result.ok) {
    showToast(result.error, 'error', 6000);
    return;
  }
  backgroundSource = '';
  applyBackgroundImage(null);
  showToast('背景图已清除', 'ok');
}

// ----------------------------------------------------------------- 外观
//
// 玻璃 / 深度 / 缩放的语义与取值公式都对齐 token-monitor：
//   玻璃 → --glass-alpha（面板底色的透明度）
//   深度 → --line-alpha / --line-strong-alpha / --control-alpha（发丝线与控件的"厚度"）
//   缩放 → 主进程的 webContents.setZoomFactor（渲染层改不了自己的缩放级别）
//
// 参考的渲染层也自带一份默认值常量（defaultAppearance），这里同样放一份，
// 供"重置"按钮使用；改主进程 DEFAULTS 时记得同步。
const APPEARANCE_DEFAULTS = { backgroundImageAlpha: 28, glassOpacity: 68, glassBlur: 32, zoomPercent: 100 };

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function applyGlass(value) {
  const opacity = clampNumber(value, 0, 100, APPEARANCE_DEFAULTS.glassOpacity);
  const root = document.documentElement.style;
  root.setProperty('--glass-alpha', (opacity / 100).toFixed(2));
  // 底色不透明时，.shell 背后那层 blur 完全透不出来 —— 白算一遍还得占一张
  // 合成 surface（实测 ~16MB GPU）。参数本身留在 CSS 的 --glass-blur 里。
  root.setProperty('--glass-filter', opacity >= 100 ? 'none' : 'var(--glass-blur)');
  $('glassValue').textContent = String(opacity);
  $('glassInput').value = String(opacity);
}

function applyDepth(value) {
  const depth = clampNumber(value, 0, 100, APPEARANCE_DEFAULTS.glassBlur) / 100;
  const root = document.documentElement.style;
  root.setProperty('--line-alpha', (0.1 + depth * 0.09).toFixed(3));
  root.setProperty('--line-strong-alpha', (0.18 + depth * 0.14).toFixed(3));
  root.setProperty('--control-alpha', (0.03 + depth * 0.045).toFixed(3));
  $('depthValue').textContent = String(Math.round(depth * 100));
  $('blurInput').value = String(Math.round(depth * 100));
}

function applyZoom(value) {
  const percent = clampNumber(value, 70, 160, APPEARANCE_DEFAULTS.zoomPercent);
  $('zoomValue').textContent = `${percent}%`;
  $('zoomInput').value = String(percent);
  if (api.setZoom) api.setZoom(percent / 100);
}

// -------------------------------------------------------------- 活动热力图
//
// 数据来自 hexoRoot 那个仓库的 git log。网格几何（cell 11 + gap 2 → pitch 13、
// 圆角 3、底部 16px 放月份标签）照参考的 .home-activity-canvas 来。
// 参考按当日次数分 4 级深浅，这里不分 —— 博客的提交"有就行"，统一一个颜色。
// 参考还有悬停辉光、亮层、拖拽横向滚动和自绘浮层，那属于它首页那套交互，这里没搬，
// 悬停改用 SVG 原生的 <title>。
const ACTIVITY_CELL = 11;
const ACTIVITY_GAP = 2;
const ACTIVITY_RADIUS = 3;
const ACTIVITY_DAY_MS = 86400000;
const SVG_NS = 'http://www.w3.org/2000/svg';

function svgNode(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function renderActivity(data) {
  const svg = $('activitySvg');
  const empty = $('activityEmpty');
  svg.textContent = '';

  if (!data || !data.ok) {
    svg.classList.add('hidden');
    empty.textContent = (data && data.error) || '暂时读不到提交记录';
    empty.classList.remove('hidden');
    return;
  }
  svg.classList.remove('hidden');
  empty.classList.add('hidden');

  const pitch = ACTIVITY_CELL + ACTIVITY_GAP;
  const startMs = Date.parse(`${data.from}T00:00:00Z`);
  const endMs = Date.parse(`${data.to}T00:00:00Z`);
  const totalDays = Math.round((endMs - startMs) / ACTIVITY_DAY_MS) + 1;
  const weeks = Math.ceil(totalDays / 7);
  const gridHeight = 7 * pitch - ACTIVITY_GAP;
  const width = weeks * pitch - ACTIVITY_GAP;
  const height = gridHeight + 16;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));

  const months = [];
  for (let index = 0; index < totalDays; index += 1) {
    const day = new Date(startMs + index * ACTIVITY_DAY_MS);
    const key = day.toISOString().slice(0, 10);
    const col = Math.floor(index / 7);
    const row = day.getUTCDay();
    const count = data.byDay[key] || 0;

    const rect = svgNode('rect', {
      class: count ? 'heat has-commit' : 'heat',
      x: col * pitch,
      y: row * pitch,
      width: ACTIVITY_CELL,
      height: ACTIVITY_CELL,
      rx: ACTIVITY_RADIUS
    });
    // 数据挂在格子上供悬停提示读取。不用原生 <title>：那会和自绘提示同时弹出来。
    rect.dataset.date = key;
    rect.dataset.count = String(count);
    svg.appendChild(rect);

    // 月份标签挂在"包含 1 号的那一列"上，参考就是这么定的
    if (day.getUTCDate() === 1) months.push({ col, label: `${day.getUTCMonth() + 1}月` });
  }

  for (const { col, label } of months) {
    const text = svgNode('text', {
      class: 'heat-month',
      x: col * pitch,
      y: gridHeight + 12,
      'text-anchor': 'start'
    });
    text.textContent = label;
    svg.appendChild(text);
  }
}

// 悬停提示。位置算法照参考的 moveHomeActivityTooltip：居中对齐到格子正上方，
// 左右越界就贴边；上方空间不够才翻到格子下面。
const ACTIVITY_TOOLTIP_GAP = 9;
const ACTIVITY_TOOLTIP_PAD = 6;

function hideActivityTooltip() {
  $('activityTooltip').classList.remove('visible');
}

function moveActivityTooltip(cell) {
  const tooltip = $('activityTooltip');
  const cellRect = cell.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const desiredX = cellRect.left + cellRect.width / 2;
  const x = Math.max(
    ACTIVITY_TOOLTIP_PAD + tooltipRect.width / 2,
    Math.min(window.innerWidth - ACTIVITY_TOOLTIP_PAD - tooltipRect.width / 2, desiredX)
  );
  const aboveY = cellRect.top - tooltipRect.height - ACTIVITY_TOOLTIP_GAP;
  const belowY = cellRect.bottom + ACTIVITY_TOOLTIP_GAP;
  const y = aboveY >= ACTIVITY_TOOLTIP_PAD
    ? aboveY
    : Math.min(window.innerHeight - ACTIVITY_TOOLTIP_PAD - tooltipRect.height, belowY);
  tooltip.style.transform = `translate(${x}px, ${y}px) translate(-50%, 0)`;
}

function setupActivityHover() {
  const svg = $('activitySvg');
  const tooltip = $('activityTooltip');

  svg.addEventListener('pointerover', (event) => {
    const cell = event.target.closest('rect.heat');
    if (!cell || !cell.dataset.date) return;
    $('activityTooltipCount').textContent = cell.dataset.count;
    $('activityTooltipDate').textContent = cell.dataset.date;
    // 先显示再量尺寸，否则第一次定位时 tooltipRect 还是 0
    tooltip.classList.add('visible');
    moveActivityTooltip(cell);
  });

  svg.addEventListener('pointerleave', hideActivityTooltip);
  // fixed 定位的提示在页面滚动后会与格子错位，直接收掉
  $('panel').addEventListener('scroll', hideActivityTooltip, { passive: true });
}


function applyActivityMeta(result) {
  if (!result || !result.ok) {
    $('activityMeta').textContent = '不可用';
    $('activityCaption').textContent = '';
    return;
  }
  // 标题行只留最要紧的一句：之前写成"活跃 15 天 · 61 次"太长，被挤到把 caret 都压住了。
  // 总数挪到网格下面那行小字里。
  $('activityMeta').textContent = result.total ? `活跃 ${result.activeDays} 天` : '暂无提交';
  $('activityCaption').textContent = result.total
    ? `${result.from} ~ ${result.to} · 共 ${result.total} 次提交`
    : `${result.from} ~ ${result.to} 期间没有提交`;
}

// 活动热力图的统计范围。weeks 是按周对齐的窗口长度，所以各档取的是覆盖该跨度所需的周数。
const ACTIVITY_RANGES = [
  // 默认档：20 周。为什么不是 21：窗口左端要再对齐到周日，21 周会溢出成 22 列（284px），
  // 而 20 周最坏是 21 列 = 21×13−2 = 271px，正好卡进 300px 默认窗口的 272px 可用宽度。
  // 所以打开就是 7 行 × 21 列，不用左右滑；下面是手动切换的四个跨度。
  { label: '近期', weeks: 20 },
  { label: '本月', weeks: 5 },
  { label: '季度', weeks: 14 },
  { label: '半年', weeks: 27 },
  { label: '一年', weeks: 53 }
];
let activityRange = 0; // 默认"近期"（21 周）

function syncActivityRangeButton() {
  const range = ACTIVITY_RANGES[activityRange];
  const button = $('activityRangeBtn');
  button.textContent = range.label;
  button.title = `当前：${range.label}（点击切换）`;
}

async function cycleActivityRange() {
  activityRange = (activityRange + 1) % ACTIVITY_RANGES.length;
  syncActivityRangeButton();
  const button = $('activityRangeBtn');
  button.disabled = true;
  try {
    await loadActivity();
  } finally {
    button.disabled = false;
  }
}

async function loadActivity() {
  const result = await api.readActivity(ACTIVITY_RANGES[activityRange].weeks);
  applyActivityMeta(result);
  renderActivity(result);
}

// ------------------------------------------------------------- 打字机
//
// 对标 Hexo 主题（Fluid）里的 typed.js —— 同样的 typeSpeed / cursorChar / loop
// 语义，参数名都对齐 _config.fluid.yml 的 fun_features.typing。逻辑只有几十行，
// 自己实现，不为它引一个依赖。
// 速度 / 光标 / 循环都固定，取值对齐 Hexo 主题 _config.fluid.yml 的
// fun_features.typing（typeSpeed: 70、cursorChar: "_"、loop: false）。
const TYPED_SPEED_FALLBACK = 70;
const TYPED_BACK_DELAY = 1500;
const typedState = { timer: null, strings: [], index: 0, position: 0, deleting: false };
let lastTypedSignature = '';

// 打印速度：数字越大越慢，与主题的 typeSpeed 同义
function typedSpeed() {
  const value = Number(settings && settings.typedSpeed);
  return Number.isFinite(value) ? Math.max(10, Math.min(400, Math.round(value))) : TYPED_SPEED_FALLBACK;
}

// 滑块旁边的数值。拖动时立刻反映（这是"待保存"的值，点保存才生效）。
function showTypedSpeed(value) {
  const speed = Math.max(10, Math.min(400, Math.round(Number(value) || TYPED_SPEED_FALLBACK)));
  $('typedSpeedInput').value = String(speed);
  $('typedSpeedValue').textContent = `${speed}ms`;
  syncTypedSaveButton();
}

function typedStrings() {
  const text = String((settings && settings.typedContent) || '').trim();
  return [text || '"可花谢花开，终有梦醒时分."'];
}

function stopTyped() {
  if (typedState.timer) clearTimeout(typedState.timer);
  typedState.timer = null;
}

function startTyped() {
  stopTyped();
  typedState.strings = typedStrings();
  typedState.index = 0;
  typedState.position = 0;
  typedState.deleting = false;
  typedStep();
}

function typedStep() {
  const strings = typedState.strings;
  if (!strings.length) return;

  const current = strings[typedState.index % strings.length];
  $('typedText').textContent = current.slice(0, typedState.position);

  if (!typedState.deleting) {
    if (typedState.position < current.length) {
      typedState.position += 1;
      typedState.timer = setTimeout(typedStep, typedSpeed());
      return;
    }
    // loop 固定为 false（与主题一致）：打完最后一条就停下，光标继续闪
    const isLast = typedState.index >= strings.length - 1;
    if (isLast) return;
    typedState.deleting = true;
    typedState.timer = setTimeout(typedStep, TYPED_BACK_DELAY);
    return;
  }

  if (typedState.position > 0) {
    typedState.position -= 1;
    typedState.timer = setTimeout(typedStep, typedSpeed());
    return;
  }
  typedState.deleting = false;
  typedState.index += 1;
  typedState.timer = setTimeout(typedStep, typedSpeed());
}

function typedSignature() {
  return [String((settings && settings.typedContent) || ''), typedSpeed()].join('\u0000');
}

// ------------------------------------------------------- publish / backup

function appendDeployLog(line) {
  const el = $('deployLog');
  el.textContent += (el.textContent ? '\n' : '') + line;
  const lines = el.textContent.split('\n');
  if (lines.length > MAX_LOG_LINES) el.textContent = lines.slice(-MAX_LOG_LINES).join('\n');
  el.scrollTop = el.scrollHeight;
}

function setDeployUI(running, task) {
  deployRunning = Boolean(running);
  $('publishBtn').disabled = deployRunning;
  $('backupBtn').disabled = deployRunning;
  $('bothBtn').disabled = deployRunning;
  $('cancelDeployBtn').classList.toggle('hidden', !deployRunning);
  $('previewToggle').disabled = deployRunning || previewBusy;

  if (deployRunning) {
    const labels = { publish: '正在发布…', backup: '正在备份…', both: '正在发布并备份…' };
    const text = labels[task] || '运行中…';
    $('deployStatus').textContent = text;
  }
}

function onDeployEvent(event) {
  if (!event || typeof event !== 'object') return;
  switch (event.type) {
    case 'log':
      appendDeployLog(event.line);
      break;
    case 'status':
      $('deployStatus').textContent = event.text;
      break;
    case 'state':
      setDeployUI(event.running, event.task);
      break;
    case 'done': {
      const text = event.ok ? '完成' : `失败：${event.error || '未知错误'}`;
      $('deployStatus').textContent = text;
      showToast(
        event.ok ? '任务完成' : `任务失败：${event.error || '未知错误'}`,
        event.ok ? 'ok' : 'error',
        event.ok ? 3200 : 9000
      );
      // The publish pipeline may have stopped and restarted the preview.
      refreshStatus();
      // 备份就是往这个仓库提交，成功之后活动图应当立刻反映出来
      if (event.ok) loadActivity();
      break;
    }
    default:
      break;
  }
}

async function runDeploy(action) {
  if (deployRunning) return;
  $('deployLog').textContent = '';
  setDeployUI(true, action);
  try {
    const message = $('commitMessageInput').value;
    if (action === 'publish') await api.publish();
    else if (action === 'backup') await api.backupSource(message);
    else await api.publishAndBackup(message);
  } finally {
    setDeployUI(false, null);
  }
}

// ---------------------------------------------------------------- actions

async function openLive() {
  const result = await api.openLive();
  if (!result.ok) showToast(result.error, 'error', 6000);
}

async function togglePreview(want) {
  previewBusy = true;
  setPreviewUI({ running: previewRunning });
  try {
    const result = want ? await api.startPreview() : await api.stopPreview();
    if (!result.ok) {
      showToast(result.error, 'error', 8000);
      setStatusLine(result.error.split('\n')[0], true);
    } else if (want) {
      const where = result.opened === 'edge' ? 'Edge' : '默认浏览器';
      showToast(`本地预览已启动，已用 ${where} 打开 ${settings.previewUrl}`, 'ok');
    } else {
      showToast('本地预览已停止', 'ok');
    }
    if (result.preview) setPreviewUI(result.preview);
    else await refreshStatus();
  } finally {
    previewBusy = false;
    setPreviewUI({ running: previewRunning });
  }
}

// 把分段控件的指示块推到第 index 档。
//
// 原本是靠 CSS 变量 --period-index 驱动 .tab-indicator 的 transform，但实测「设了
// 变量、指示块却纹丝不动」（计算值是 matrix(1,0,0,1,0,0)）。与其继续排查变量为什么
// 没生效，不如直接写 transform —— 一样有 220ms 过渡，一样能用。
function moveTabIndicator(navId, index) {
  const nav = $(navId);
  const indicator = nav && nav.querySelector('.tab-indicator');
  if (!indicator) return;
  indicator.style.transform = `translate3d(calc(${index} * (100% + 2px)), 0, 0)`;
}

// ---------------------------------------------------- 新建页的三个模式
//
// 目录统一置顶，下面三个按钮切换这一页显示哪块（照参考的 .tabs 分段控件）。

const CREATE_MODES = [
  { id: 'post', module: 'moduleCreate' },
  { id: 'image', module: 'modulePasteImage' }
];
let createMode = 'post';

function setCreateMode(id) {
  const next = CREATE_MODES.find((mode) => mode.id === id) || CREATE_MODES[0];
  createMode = next.id;
  moveTabIndicator('createTabs', CREATE_MODES.findIndex((mode) => mode.id === next.id));
  for (const tab of $('createTabs').querySelectorAll('.tab')) {
    const active = tab.dataset.mode === next.id;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-pressed', String(active));
  }
  for (const mode of CREATE_MODES) {
    const element = $(mode.module);
    if (element) element.classList.toggle('hidden', mode.id !== next.id);
  }
  if (next.id === 'image') loadPastePosts();
}

// ---------------------------------------------------- 粘贴图片
//
// 只接粘贴（Cmd+V）：焦点在输入框里时让给输入框，其余情况落到这个模块。
// 落盘在主进程，默认不覆盖同名文件。

let pastedImage = null; // { file, ext, url }

function pasteDir() {
  // 目录统一用新建页顶部那一个
  return $('dirSelect').value || String((settings && settings.postsDir) || '');
}

async function loadPastePosts() {
  const select = $('pastePostSelect');
  select.textContent = '';
  const dir = pasteDir();
  if (!dir || typeof api.listPosts !== 'function') return;
  const result = await api.listPosts(dir);
  if (!result || !result.ok) return;
  for (const post of result.posts || []) {
    const option = document.createElement('option');
    option.value = post.slug;
    option.textContent = post.slug;
    select.append(option);
  }
  syncPasteButton();
}

// 有图可存时按钮变绿（配合 styles.css 里的 #pasteSaveBtn.is-ready）。
// 注意：验证这一条**别信 getComputedStyle** —— 无头环境里它的读数和实际渲染不一致，
// 我为此白改了三轮。直接截图看。
function syncPasteButton() {
  const ready = !!pastedImage && !!$('pastePostSelect').value;
  const button = $('pasteSaveBtn');
  button.disabled = !ready;
  button.classList.toggle('is-ready', ready);
}

function clearPastedImage() {
  if (pastedImage && pastedImage.url) URL.revokeObjectURL(pastedImage.url);
  pastedImage = null;
  const preview = $('pastePreview');
  preview.classList.add('hidden');
  preview.removeAttribute('src');
  $('pasteHint').classList.remove('hidden');
  $('pasteClearBtn').classList.add('hidden');
  $('pasteMeta').textContent = 'Cmd+V';
  syncPasteButton();
}

function acceptPastedImage(file) {
  clearPastedImage();
  const ext = file.type === 'image/jpeg' ? '.jpg'
    : file.type === 'image/gif' ? '.gif'
      : file.type === 'image/webp' ? '.webp' : '.png';
  pastedImage = { file, ext, url: URL.createObjectURL(file) };

  const preview = $('pastePreview');
  preview.src = pastedImage.url;
  preview.classList.remove('hidden');
  $('pasteHint').classList.add('hidden');
  $('pasteClearBtn').classList.remove('hidden');
  preview.title = '点击在独立窗口中预览';
  if (!$('pasteNameInput').value.trim()) $('pasteNameInput').value = `1${ext}`;
  $('pasteMeta').textContent = `${Math.max(1, Math.round(file.size / 1024))} KB · ${ext.slice(1).toUpperCase()}`;
  syncPasteButton();
}

// 从磁盘选图：拿到字节后造一个 File，交给和"粘贴"完全相同的那条链路 ——
// 预览、改名、选文章、保存、追加引用都不用再写一遍。
const IMAGE_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml'
};

async function pickImageFromDisk() {
  const button = $('pastePickBtn');
  if (typeof api.pickImage !== 'function') {
    showToast('选择文件需要重启应用\n（改过 main.js / preload.js 后 Cmd+R 不够）', 'error', 8000);
    return;
  }
  button.disabled = true;
  try {
    const result = await api.pickImage();
    if (!result || result.canceled) return;
    if (!result.ok) {
      showToast(`选择图片失败：${result.error || '未知原因'}`, 'error', 8000);
      return;
    }
    const ext = String(result.name || '').split('.').pop().toLowerCase();
    const file = new File([result.bytes], result.name || `image.${ext}`, {
      type: IMAGE_MIME[ext] || 'image/png'
    });
    acceptPastedImage(file);
    // 文件名默认用选中的那个，而不是 1.png
    const stem = String(result.name || '').replace(/\.[^.]+$/, '');
    if (stem) $('pasteNameInput').value = `${stem}.${ext || 'png'}`;
  } catch (error) {
    showToast(`选择图片失败：${(error && error.message) || error}`, 'error', 8000);
  } finally {
    button.disabled = false;
  }
}

async function savePastedImage() {
  if (!pastedImage) return;
  const slug = $('pastePostSelect').value;
  const dir = pasteDir();
  if (!dir || !slug) {
    showToast('先选目录和文章', 'error');
    return;
  }

  const button = $('pasteSaveBtn');
  button.disabled = true;
  try {
    const bytes = new Uint8Array(await pastedImage.file.arrayBuffer());
    const result = await api.saveImage({
      dir,
      slug,
      name: $('pasteNameInput').value.trim() || `1${pastedImage.ext}`,
      bytes,
      // 开关决定要不要动文章；关掉时只落盘，引用放进提示里让你自己复制
      append: $('pasteAppendInput').checked
    });
    if (!result.ok) {
      showToast(result.error, 'error', 8000);
      return;
    }
    showToast(
      `已保存 ${result.relativePath}`
        + (result.renamed ? `\n（同名已存在，改用 ${result.fileName}）` : '')
        + (result.appended ? '\n引用已追加到文章末尾' : `\n未追加，引用：${result.reference}`),
      'ok'
    );
    clearPastedImage();
  } catch (error) {
    // 读字节或 IPC 失败时别静默：以前异常被 Promise 吞掉，界面上毫无反应
    showToast(`保存图片失败：${(error && error.message) || error}`, 'error', 8000);
  } finally {
    syncPasteButton();
  }
}

async function createPost() {
  const title = $('titleInput').value.trim();
  if (!title) {
    showToast('标题不能为空', 'error');
    $('titleInput').focus();
    return;
  }
  const dir = effectiveDir();
  if (!dir) {
    showToast('请选择或填写目录', 'error');
    $('dirSelect').focus();
    return;
  }

  const button = $('createBtn');
  button.disabled = true;
  try {
    const result = await api.createPost({
      title,
      dir,
      date: $('dateInput').value,
      categories: $('categoriesInput').value,
      tags: $('tagsInput').value,
      sticky: $('stickyInput').value,
      abstract: $('abstractInput').value,
      // 图片文件夹是每篇的选择，不是全局设置 —— 勾了就在文章旁建同名目录
      assetFolder: $('assetFolderInput').checked
    });
    if (!result.ok) {
      showToast(result.error, 'error', 8000);
      return;
    }
    showToast(
      `已创建 ${result.relativePath}`
        + (result.assetDir ? `\n图片目录：${result.assetDir}` : '')
        + (result.opened ? '' : '\n（未能自动打开，请手动打开）'),
      'ok'
    );
    resetForm();
    if (result.dir) {
      settings.postsDir = result.dir;
      lastRealDir = result.dir;
      // Rescan: a folder the post just created now belongs in the list.
      await refreshDirOptions();
    }
    $('titleInput').focus();
  } finally {
    button.disabled = false;
  }
}

// 与参考一致：改动即保存，面板里没有"保存"按钮。
// 文本类字段防抖（避免每个键都打一次 IPC，也避免输到一半的路径被判非法）；
// 开关和滑块在 change（松手/切换）时落盘。校验失败只走底部状态行，不弹 toast——
// 否则在输入框里打字时会被错误提示刷屏。
const SAVE_DEBOUNCE_MS = 700;
let saveTimer = null;
let lastSaveError = '';
// 只有 Hexo 根目录真的变了才重扫文章目录：否则在输入框里打字的过程中，
// 半截路径会让扫描返回空列表，把目录下拉清空。
let lastSavedRoot = '';

function settingsPatchFromUI() {
  return {
    hexoRoot: $('hexoRootInput').value,
    liveUrl: $('liveUrlInput').value,
    port: Number($('portInput').value),
    edgeBrowser: $('edgeBrowserInput').checked,
    openAfterCreate: $('openAfterCreateInput').checked,
    backgroundImageAlpha: Number($('alphaInput').value),
    glassOpacity: Number($('glassInput').value),
    glassBlur: Number($('blurInput').value),
    zoomFactor: Number($('zoomInput').value) / 100,
    systemGlass: $('systemGlassInput').checked,
    // 用已保存的值：这两项要点「保存」才生效，别的字段自动保存时不该把它们一并写进去
    typedContent: settings ? settings.typedContent : $('typedContentInput').value,
    typedSpeed: settings ? settings.typedSpeed : Number($('typedSpeedInput').value),
    sayText: settings ? settings.sayText : $('sayTextInput').value.trim(),
    signatureText: settings ? settings.signatureText : $('signatureTextInput').value.trim(),
    // 用已保存的值：置顶由标题栏按钮直接改，别的字段保存时不该把它覆盖掉
    alwaysOnTop: settings ? settings.alwaysOnTop === true : false
  };
}

async function persistSettings() {
  clearTimeout(saveTimer);
  const result = await api.saveSettings(settingsPatchFromUI());
  if (!result.ok) {
    lastSaveError = result.error || '保存失败';
    setStatusLine(lastSaveError, true);
    return false;
  }
  lastSaveError = '';
  // 只更新本地副本与摘要，不回写输入框——否则打字打到一半会被覆盖、光标跳走。
  settings = { ...settings, ...result.settings };
  const signature = typedSignature();
  if (signature !== lastTypedSignature) {
    // 只有打字机相关的项变了才重启动画；否则在别的字段里打字会一直重置它
    lastTypedSignature = signature;
    startTyped();
  }
  refreshSettingsSummaries();
  syncTypedSaveButton();
  setTransientStatus('已保存');
  if (settings.hexoRoot !== lastSavedRoot) {
    lastSavedRoot = settings.hexoRoot;
    await refreshDirOptions();
  }
  return true;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistSettings, SAVE_DEBOUNCE_MS);
}

// 滑块当前待保存的速度
function pendingTypedSpeed() {
  const parsed = Number($('typedSpeedInput').value);
  return Number.isFinite(parsed) ? Math.max(10, Math.min(400, Math.round(parsed))) : TYPED_SPEED_FALLBACK;
}

// 草稿与已保存值是否不同（参考的 hubDraftHasChanges）
function typedDraftHasChanges() {
  if (!settings) return false;
  const content = $('typedContentInput').value;
  const contentChanged = content !== settings.typedContent
    && !(content === '' && settings.typedContent == null);
  const sayChanged = $('sayTextInput').value.trim() !== String(settings.sayText || '').trim();
  const signatureChanged = $('signatureTextInput').value.trim() !== String(settings.signatureText || '').trim();
  return contentChanged || sayChanged || signatureChanged || pendingTypedSpeed() !== typedSpeed();
}

// 打字机上方小字 + 底部署名：留空就整行不显示
function applyTexts() {
  const say = String((settings && settings.sayText) || '').trim();
  const signature = String((settings && settings.signatureText) || '').trim();
  $('heroLabel').textContent = say;
  $('heroLabel').classList.toggle('hidden', say === '');
  $('signature').textContent = signature;
  $('signature').classList.toggle('hidden', signature === '');
}

let typedSaveBusy = false;

// 没有改动就保持禁用（参考的 syncHubSaveButton：disabled = busy || !draftHasChanges）
function syncTypedSaveButton() {
  const button = $('saveTypedBtn');
  if (!button) return;
  button.disabled = typedSaveBusy || !typedDraftHasChanges();
  if (typedSaveBusy) button.setAttribute('aria-busy', 'true');
  else button.removeAttribute('aria-busy');
}

// 「保存」按钮：把文案与打印速度提升为"已保存"，再走与自动保存完全相同的那条路径。
async function saveTypedSettings() {
  const button = $('saveTypedBtn');
  if (!settings || button.disabled) return;

  const nextContent = $('typedContentInput').value;
  const nextSpeed = pendingTypedSpeed();
  const nextSay = $('sayTextInput').value.trim();
  const nextSignature = $('signatureTextInput').value.trim();
  const previous = {
    typedContent: settings.typedContent,
    typedSpeed: settings.typedSpeed,
    sayText: settings.sayText,
    signatureText: settings.signatureText
  };

  settings = { ...settings, typedContent: nextContent, typedSpeed: nextSpeed, sayText: nextSay, signatureText: nextSignature };
  applyTexts();
  typedSaveBusy = true;
  syncTypedSaveButton();
  try {
    const ok = await persistSettings();
    if (ok) {
      flashTypedSaved(button);
    } else {
      // 保存失败就别把草稿当成"已保存"，否则按钮会被错误地禁掉、没法重试
      settings = { ...settings, ...previous };
    }
  } finally {
    typedSaveBusy = false;
    syncTypedSaveButton();
  }
}

let typedSavedTimer = null;

function flashTypedSaved(button) {
  if (!button) return;
  button.textContent = '已保存';
  clearTimeout(typedSavedTimer);
  typedSavedTimer = setTimeout(() => {
    button.textContent = '保存';
  }, 1200);
}

// --------------------------------------------------------------- lifecycle

async function refreshStatus() {
  if (previewBusy) return;
  try {
    setPreviewUI(await api.previewStatus());
  } catch (_) {
    // Main process is going away; nothing useful to show.
  }
}

// 底栏的刷新按钮：把主进程的状态整体重读一遍（设置、预览、文章目录、背景图）。
async function refreshAll() {
  const button = $('refreshBtn');
  if (button.disabled) return;
  button.disabled = true;
  button.classList.add('is-refreshing');
  try {
    const state = await api.getState();
    applyNativeMaterial(state.nativeMaterial);
    applySettings(state.settings);
    renderDirOptions(state.postDirs);
    setPreviewUI(state.preview);
    await loadBackgroundImage();
    await loadActivity();
    button.classList.remove('is-refreshing');
    button.classList.add('is-refreshed');
    setTransientStatus('已刷新');
    setTimeout(() => button.classList.remove('is-refreshed'), 1200);
  } catch (_) {
    button.classList.remove('is-refreshing');
    setStatusLine('刷新失败', true);
  } finally {
    button.disabled = false;
  }
}

function wire() {
  $('liveBtn').addEventListener('click', openLive);

  $('previewToggle').addEventListener('change', (event) => {
    togglePreview(event.target.checked);
  });

  $('createBtn').addEventListener('click', createPost);
  $('dirSelect').addEventListener('change', loadPastePosts);
  $('pasteZone').addEventListener('click', () => $('pasteZone').focus());
  $('pastePickBtn').addEventListener('click', pickImageFromDisk);
  // 点缩略图 → 单开一个预览窗口（原地放大小窗口里看不清）
  $('pastePreview').addEventListener('click', async (event) => {
    event.stopPropagation();
    if (!pastedImage) return;
    if (typeof api.previewImage !== 'function') {
      showToast('图片预览需要重启应用\n（改过 main.js / preload.js 后 Cmd+R 不够）', 'error', 8000);
      return;
    }
    try {
      const bytes = new Uint8Array(await pastedImage.file.arrayBuffer());
      const result = await api.previewImage({ bytes, name: pastedImage.file.name, type: pastedImage.file.type });
      if (!result || !result.ok) showToast(`打开预览失败：${(result && result.error) || '未知原因'}`, 'error', 8000);
    } catch (error) {
      showToast(`打开预览失败：${(error && error.message) || error}`, 'error', 8000);
    }
  });
  $('pasteClearBtn').addEventListener('click', (event) => {
    // 别让点清除顺带把焦点/点击冒泡回粘贴区
    event.stopPropagation();
    event.preventDefault();
    clearPastedImage();
  });
  // Esc 也能清除（只在真的粘了图时接管，不干扰别的 Esc 用途）
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !pastedImage) return;
    clearPastedImage();
  });
  for (const tab of $('createTabs').querySelectorAll('.tab')) {
    tab.addEventListener('click', () => setCreateMode(tab.dataset.mode));
  }
  $('pastePostSelect').addEventListener('change', syncPasteButton);
  $('pasteSaveBtn').addEventListener('click', savePastedImage);
  // 只接粘贴：焦点在输入框/文本域/下拉里时让给它们，其余落到本模块
  document.addEventListener('paste', (event) => {
    if (currentView !== 'create') return;
    const tag = event.target && event.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const items = [...((event.clipboardData && event.clipboardData.items) || [])];
    const item = items.find((entry) => String(entry.type).startsWith('image/'));
    if (!item) return;
    const file = item.getAsFile();
    if (!file) return;
    event.preventDefault();
    acceptPastedImage(file);
  });
  $('titleInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') createPost();
  });

  $('dirSelect').addEventListener('change', () => {
    if (!usingCustomDir()) lastRealDir = $('dirSelect').value;
    syncDirUI();
  });
  $('dirInput').addEventListener('input', updatePathHint);

  $('publishBtn').addEventListener('click', () => runDeploy('publish'));
  $('backupBtn').addEventListener('click', () => runDeploy('backup'));
  $('bothBtn').addEventListener('click', () => runDeploy('both'));
  $('cancelDeployBtn').addEventListener('click', () => api.cancelDeploy());
  $('clearLogBtn').addEventListener('click', () => { $('deployLog').textContent = ''; });
  api.onDeployEvent(onDeployEvent);

  // 折叠只留给设置卡 —— 主面板现在是页面，不再有可折叠的模块
  wireCollapse('settingsSiteToggle', 'settingsSiteBody');
  wireCollapse('settingsLookToggle', 'settingsLookBody');
  setupActivityHover();
  wireCollapse('settingsTypedToggle', 'settingsTypedBody');
  wireCollapse('settingsBehaviorToggle', 'settingsBehaviorBody');

  wireViewSwitcher();
  $('settingsBtn').addEventListener('click', toggleSettingsPanel);
  $('refreshBtn').addEventListener('click', refreshAll);
  $('activityRangeBtn').addEventListener('click', cycleActivityRange);
  syncActivityRangeButton();
  // 边打字边预览，保存按钮的可用状态同步跟着变
  for (const id of ['sayTextInput', 'signatureTextInput']) {
    $(id).addEventListener('input', () => {
      applyTexts();
      syncTypedSaveButton();
    });
  }
  document.addEventListener('click', (event) => {
    if (viewMenuOpen && !$('viewSwitcher').contains(event.target)) closeViewMenu();
  });

  $('chooseBgBtn').addEventListener('click', chooseBackgroundImage);
  $('clearBgBtn').addEventListener('click', clearBackgroundImage);

  // 自动保存
  for (const id of ['hexoRootInput', 'liveUrlInput', 'portInput']) {
    $(id).addEventListener('input', scheduleSave);
  }
  for (const id of ['edgeBrowserInput', 'openAfterCreateInput']) {
    $(id).addEventListener('change', () => persistSettings());
  }
  // 透明度：拖动时实时预览，松手才落盘
  $('alphaInput').addEventListener('input', (event) => applyAlpha(event.target.value));
  $('alphaInput').addEventListener('change', () => persistSettings());
  $('resetAlphaButton').addEventListener('click', () => {
    applyAlpha(APPEARANCE_DEFAULTS.backgroundImageAlpha);
    persistSettings();
  });

  // 系统毛玻璃：这项不只是存个值，主进程要立刻给窗口补上/摘掉材质，
  // 所以走专用通道而不是普通保存。响应里的 nativeMaterial 决定渲染层要不要
  // 保留自己那层 backdrop-filter（有原生材质时那才是重复叠加）。
  $('systemGlassInput').addEventListener('change', async () => {
    const wanted = $('systemGlassInput').checked;
    const result = await api.setSystemGlass(wanted);
    if (!result || !result.ok) {
      $('systemGlassInput').checked = !wanted;
      setStatusLine('切换毛玻璃失败', true);
      return;
    }
    settings = { ...settings, ...(result.settings || {}), systemGlass: wanted };
    applyNativeMaterial(result.nativeMaterial);
    setTransientStatus(wanted ? '已启用系统毛玻璃' : '已关闭系统毛玻璃');
  });

  // 外观三件套：拖动实时预览，松手落盘（与背景透明度同一套约定）
  $('glassInput').addEventListener('input', (event) => applyGlass(event.target.value));
  $('glassInput').addEventListener('change', () => persistSettings());
  $('blurInput').addEventListener('input', (event) => applyDepth(event.target.value));
  $('blurInput').addEventListener('change', () => persistSettings());
  $('zoomInput').addEventListener('input', (event) => applyZoom(event.target.value));
  $('zoomInput').addEventListener('change', () => persistSettings());

  // 重置按钮：拨回默认值并立即生效落盘 —— 这张卡没有保存按钮，实时就是它的约定
  $('resetGlassButton').addEventListener('click', () => {
    applyGlass(APPEARANCE_DEFAULTS.glassOpacity);
    persistSettings();
  });
  $('resetDepthButton').addEventListener('click', () => {
    applyDepth(APPEARANCE_DEFAULTS.glassBlur);
    persistSettings();
  });
  $('resetZoomButton').addEventListener('click', () => {
    applyZoom(APPEARANCE_DEFAULTS.zoomPercent);
    persistSettings();
  });

  $('saveTypedBtn').addEventListener('click', saveTypedSettings);
  $('typedContentInput').addEventListener('input', () => syncTypedSaveButton());
  $('typedContentInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') saveTypedSettings();
  });
  // 拖动时只更新旁边的数值（待保存），点「保存」才真正生效并入盘
  $('typedSpeedInput').addEventListener('input', (event) => {
    $('typedSpeedValue').textContent = `${event.target.value}ms`;
    syncTypedSaveButton();
  });
  // 重置按钮：把滑块拨回默认值。同样只是"待保存"，点「保存」才入盘。
  $('resetTypedSpeed').addEventListener('click', () => showTypedSpeed(TYPED_SPEED_FALLBACK));

  $('browseBtn').addEventListener('click', async () => {
    const result = await api.chooseHexoRoot();
    if (result.ok) {
      $('hexoRootInput').value = result.path;
      persistSettings();
    }
  });
  // 提示框点一下就能关掉
  $('toast').addEventListener('click', hideToast);
  // 窗口被遮挡时 Chromium 会大幅推迟后台页面的定时器（最长约一分钟一次），
  // 那种情况下 9 秒的自动消失会被拖成"好像一直不消失"。所以回到前台时
  // 直接把已经过期的提示收掉，不再依赖那个被压住的定时器。
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && toastTimer) hideToast();
  });
  window.addEventListener('focus', () => {
    if (toastTimer) hideToast();
  });

  $('minBtn').addEventListener('click', () => api.minimize());
  $('pinBtn').addEventListener('click', toggleAlwaysOnTop);
  $('closeBtn').addEventListener('click', async () => {
    const result = await api.close();
    if (result && !result.ok) showToast(result.error, 'error', 6000);
  });

  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    // Escape must not interrupt a running pipeline.
    if (deployRunning) return;
    if (viewMenuOpen) {
      closeViewMenu();
      return;
    }
    api.close();
  });
}

// 窗口自己带原生材质（macOS 的 vibrancy / Windows 的 acrylic），也就是说窗口后面
// 已经有一次系统级模糊了。这时外层的 Chromium backdrop-filter 是重复劳动，而且它
// 需要在窗口重新可见时重新采样背景 —— 那一帧就是你看到的"变灰再变回来"。
// 参考在自己的原生材质模式下也是直接把这层去掉的。
function applyNativeMaterial(hasNativeMaterial) {
  document.documentElement.classList.toggle('native-material', hasNativeMaterial === true);
}

async function init() {
  wire();
  const state = await api.getState();
  applyNativeMaterial(state.nativeMaterial);
  applySettings(state.settings);
  $('abstractInput').placeholder = `不填则用 ${state.abstract}`;
  renderDirOptions(state.postDirs);
  setPreviewUI(state.preview);
  setView('home');
  loadBackgroundImage();
  loadActivity();
  if (!state.settings.valid) {
    showToast(`请先在「设置」里选择 Hexo 目录\n${state.settings.hexoRoot}`, 'error', 9000);
  }
  setInterval(refreshStatus, POLL_MS);
}

init();
