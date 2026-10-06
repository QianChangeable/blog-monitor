'use strict';

const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } = require('electron');

const activity = require('./lib/activity');
const background = require('./lib/background');
const browser = require('./lib/browser');
const config = require('./lib/config');
const posts = require('./lib/posts');
const { DeployRunner } = require('./lib/deploy');
const { PreviewManager } = require('./lib/preview');

// Keep userData stable and ASCII — Electron would otherwise derive it from
// package.json's productName ("Hexo 控制台"). Resolved in whenReady() rather
// than at module scope, where app.getPath() is not guaranteed.
app.setName('hexo-blog-widget');

let win = null;
let previewWindow = null;
let previewPayload = null;

// 到底要不要用 macOS 的原生毛玻璃材质。
//
// macOS 26（Tahoe，Darwin 25）上有个实测过的坑：窗口可能"只呈现了原生材质、页面内容还没
// 上来"，那一片就是灰的 —— 表现成"从别的窗口切回来时变灰再变回来"。
// Electron 自己的 issue 与别家应用（如 hermes-agent）的修法一致：Darwin 25+ 干脆不要
// vibrancy。token-monitor 在你这台机器上之所以没事，是因为它挂的是自建的原生 Liquid Glass
// 视图（macarlLiquidGlass 原生模块），并把 vibrancy 置空 —— 我们没有那个原生模块，
// 所以走"不要材质、由页面自己画"这条路。
const DARWIN_MAJOR = process.platform === 'darwin' ? Number.parseInt(os.release(), 10) : 0;
// 材质本身是否可用（Windows 用 acrylic；macOS 用 vibrancy）。
// "要不要用"由设置 systemGlass 决定，这里只回答"能不能"。
const NATIVE_MATERIAL_AVAILABLE = process.platform === 'win32' || process.platform === 'darwin';

function wantsNativeMaterial() {
  return Boolean(NATIVE_MATERIAL_AVAILABLE && settings && settings.systemGlass);
}

// 应用图标。两个平台要的东西不一样：
//   Windows —— 多尺寸 .ico（直接塞 jpg 小尺寸会糊）
//   macOS   —— 已经按 Apple 图标网格切好的 PNG：1024 画布、形状 824、超椭圆连续圆角、
//              四周留透明边距。直接给方形原图的话 Dock 里就是个直角方块，macOS 不会
//              替你套圆角。
// macOS 非打包运行时 Dock 图标来自 Electron 本体，还得在 ready 之后用 app.dock.setIcon。
const APP_ICON = path.join(
  __dirname,
  'renderer',
  process.platform === 'win32' ? 'app-icon.ico' : 'app-icon-mac.png'
);

// Dock 图标只用得到 256px：Dock 最大画到 128pt，Retina 下就是 256 个像素。
// 这不是"顺手缩一下"—— 直接 createFromPath 那张 1024×1024 再交给 app.dock.setIcon，
// 解码出来的位图会一直挂在主进程里。实测主进程 83MB → 54MB（只改这一处）。
// 1024 的原图留着不动，打包脚本还要拿它生成 .icns。
const DOCK_ICON_PX = 256;

// BrowserWindow 的 icon 在 macOS 上是被忽略的（Dock 图标走 app.dock.setIcon），
// 但传进去的 nativeImage 照样会被解码并留在主进程。所以只在 Windows 上挂。
function windowIconOption() {
  return process.platform === 'darwin' ? {} : { icon: APP_ICON };
}

let settingsDir = '';
let settings = { ...config.DEFAULTS };

const preview = new PreviewManager({
  getSettings: () => settings,
  logFile: ''
});

const deploy = new DeployRunner({
  getSettings: () => settings,
  preview,
  onEvent: (event) => {
    // Handled in main: the renderer should not be the thing that decides to
    // open a browser.
    if (event.type === 'open-live') {
      browser.open(settings.liveUrl).catch(() => {});
      return;
    }
    if (win && !win.isDestroyed()) win.webContents.send('deploy:event', event);
  }
});

function nativeMaterialOptions() {
  return process.platform === 'win32'
    ? { backgroundMaterial: 'acrylic' }
    : { vibrancy: 'hud', visualEffectState: 'active' };
}

// 运行时切换材质（设置里的开关）。窗口是先建后用，所以这里必须能即时补上/摘掉。
function applyNativeMaterialSetting() {
  if (!win || win.isDestroyed() || !NATIVE_MATERIAL_AVAILABLE) return;
  if (process.platform === 'darwin') {
    win.setVibrancy(wantsNativeMaterial() ? 'hud' : null);
  } else if (process.platform === 'win32') {
    win.setBackgroundMaterial(wantsNativeMaterial() ? 'acrylic' : 'none');
  }
}

function clampZoom(value) {
  const next = Number(value);
  if (!Number.isFinite(next)) return 1;
  return Math.max(config.ZOOM_MIN, Math.min(config.ZOOM_MAX, Number(next.toFixed(2))));
}

function createWindow() {
  const material = wantsNativeMaterial() ? nativeMaterialOptions() : {};

  win = new BrowserWindow({
    // 默认尺寸：打开即 300×460，需要更大自己拖
    width: 300,
    height: 460,
    // 可以一直缩到 240×140：那个尺寸下只留标题栏 + 打字机 + 底栏（布局有适配）
    minWidth: 240,
    minHeight: 140,
    frame: false,
    transparent: true,
    maximizable: false,
    fullscreenable: false,
    show: false,
    backgroundColor: '#00000000',
    title: 'Hexo 控制台',
    ...windowIconOption(),
    ...material,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // 窗口被别的窗口盖住时，macOS/Chromium 会把它当作 occluded 并对渲染层降频、
      // 挂起合成。切回来时毛玻璃材质与 backdrop-filter 需要重新合成，中间会闪出
      // 一两帧未模糊的"灰"状态；被压住的定时器同理（提示框因此像是不消失）。
      // 这个窗口本来就要一直显示状态，关掉降频代价可以忽略。
      //
      // 曾经怀疑这行是内存大头，实测不是：真正撑大 GPU 进程的是「常驻的光标闪烁
      // 动画 + 内层十几层 backdrop-filter」（见 styles.css），那两个删掉之后，
      // 这一行开着和关掉都是 ~53MB GPU、总量 146MB 上下，差别落在噪声里。
      // 所以照旧保留 —— 遮挡时不让合成器挂起，就不会有切回来的灰闪。
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });

  // The window is a control panel, never a browser.
  // 启动时套用保存的界面缩放（渲染层还没跑起来，只能在这里落）
  win.webContents.setZoomFactor(clampZoom(settings.zoomFactor));

  // 上次退出时是置顶的，这次开窗就还是置顶
  if (settings.alwaysOnTop === true) {
    win.setAlwaysOnTop(true, 'floating');
    if (typeof win.setVisibleOnAllWorkspaces === 'function') {
      win.setVisibleOnAllWorkspaces(true, { skipTransformProcessType: true });
    }
  }

  // 关掉主窗口就等于退出程序（仪表板若还开着，也不会留下一个没有主窗口的进程）
  win.on('closed', () => {
    win = null;
    app.quit();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
}

// Rescanned rather than cached: a folder created in an editor while the widget
// is open must show up the next time the post card is opened.
function listPostDirs() {
  try {
    return posts.listPostDirectories(settings.hexoRoot);
  } catch (_) {
    return [];
  }
}

// One deploy task at a time: the pipeline owns public/, .deploy_git and the
// working tree, so overlapping runs would race each other.
async function runDeployTask(task, work) {
  if (deploy.running) return { ok: false, error: '已有发布或备份任务在运行' };
  deploy.cancelled = false;
  deploy.setRunning(true, task);
  try {
    const result = await work();
    deploy.emit({ type: 'done', ok: Boolean(result && result.ok), error: (result && result.error) || '' });
    return { ok: Boolean(result && result.ok), error: (result && result.error) || '' };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    deploy.log(`✗ ${message}`);
    deploy.emit({ type: 'done', ok: false, error: message });
    return { ok: false, error: message };
  } finally {
    deploy.setRunning(false, null);
    deploy.cancelled = false;
  }
}

function registerIpc() {
  // 活动热力图：读 hexoRoot 那个仓库的提交记录
  ipcMain.handle('activity:read', async (_event, weeks) => {
    const check = config.validate(settings);
    if (!check.ok) return { ok: false, error: check.error };
    // 只接受一个合理区间：界面给的是预设档位，但主进程不该无条件相信渲染层
    const span = Number.isFinite(Number(weeks)) ? Math.max(4, Math.min(60, Math.round(Number(weeks)))) : undefined;
    return activity.readActivity(settings.hexoRoot, span ? { weeks: span } : {});
  });

  ipcMain.handle('app:state', async () => ({
    settings: config.publicSettings(settings),
    abstract: config.DEFAULT_ABSTRACT,
    platform: process.platform,
    // 渲染层据此决定要不要保留自己那层 backdrop-filter（有原生材质时才是重复叠加）
    nativeMaterial: wantsNativeMaterial(),
    postDirs: listPostDirs(),
    preview: await preview.status()
  }));

  ipcMain.handle('posts:directories', async () => {
    const check = config.validate(settings);
    if (!check.ok) return { ok: false, error: check.error, directories: [] };
    return { ok: true, directories: listPostDirs() };
  });

  ipcMain.handle('settings:save', async (_event, patch) => {
    const next = config.merge(settings, patch);
    const check = config.validate(next);
    if (!check.ok) return { ok: false, error: check.error };
    settings = next;
    config.write(settingsDir, settings);
    return { ok: true, settings: config.publicSettings(settings) };
  });

  ipcMain.handle('settings:chooseRoot', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: '选择 Hexo 站点目录',
      defaultPath: settings.hexoRoot,
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
    return { ok: true, path: result.filePaths[0] };
  });

  ipcMain.handle('live:open', async () => {
    try {
      await browser.open(settings.liveUrl);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: `打开失败：${error.message}` };
    }
  });

  ipcMain.handle('preview:status', () => preview.status());

  ipcMain.handle('preview:start', async () => {
    const check = config.validate(settings);
    if (!check.ok) return { ok: false, error: check.error, preview: await preview.status() };
    try {
      // Status first so the switch flips the moment the port answers; the Edge
      // launch is fire-and-forget and must not hold the toggle.
      const result = await preview.start();
      await browser.open(config.previewUrl(settings), { preferEdge: settings.edgeBrowser });
      return { ok: true, opened: settings.edgeBrowser ? 'edge' : 'default', preview: result };
    } catch (error) {
      await preview.stop({ silent: true }).catch(() => {});
      return { ok: false, error: error.message || String(error), preview: await preview.status() };
    }
  });

  ipcMain.handle('preview:stop', async () => {
    try {
      return { ok: true, preview: await preview.stop() };
    } catch (error) {
      return { ok: false, error: error.message || String(error), preview: await preview.status() };
    }
  });

  ipcMain.handle('post:list', async (_event, dir) => {
    const check = config.validate(settings);
    if (!check.ok) return { ok: false, error: check.error };
    try {
      const result = posts.listPosts(settings.hexoRoot, dir || settings.postsDir);
      // 顺带把 post_asset_folder 的当前值读给界面（只读，不改配置）
      return { ...result, assetFolder: posts.assetFolderSetting(settings.hexoRoot) };
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('post:ensure-image-dir', async (_event, payload) => {
    const check = config.validate(settings);
    if (!check.ok) return { ok: false, error: check.error };
    try {
      return posts.ensureImageDir(
        settings.hexoRoot,
        (payload && payload.dir) || settings.postsDir,
        payload && payload.slug
      );
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  });

  // 从磁盘挑一张图：返回文件名 + 字节，渲染层自己造 File/预览，
  // 后面"改名 / 选文章 / 保存"整条链路和粘贴进来的图完全一致。
  // 图片预览窗口：和仪表板同一套做法（单开一个窗口）。字节留在主进程内存里
  // 由预览窗口来取 —— 不落临时文件，窗口一关就清掉。
  ipcMain.handle('image:preview', async (_event, payload) => {
    try {
      const bytes = payload && payload.bytes ? new Uint8Array(payload.bytes) : null;
      if (!bytes || !bytes.length) return { ok: false, error: '没有图片数据' };
      previewPayload = {
        bytes,
        name: String((payload && payload.name) || '图片预览'),
        type: String((payload && payload.type) || 'image/png')
      };
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }

    if (previewWindow && !previewWindow.isDestroyed()) {
      previewWindow.reload(); // 重新拉一次 image:preview-data
      previewWindow.setAlwaysOnTop(true, 'screen-saver');
      previewWindow.show();
      previewWindow.focus();
      return { ok: true, focused: true };
    }

    const material = wantsNativeMaterial() ? nativeMaterialOptions() : {};
    previewWindow = new BrowserWindow({
      width: 900,
      height: 640,
      minWidth: 320,
      minHeight: 220,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      title: '图片预览',
      ...windowIconOption(),
      show: false,
      ...material,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    });
    // 主窗口可能是置顶的（floating）。同层级时"点谁谁在上"，预览照样会被盖住，
    // 所以预览窗口用更高的 screen-saver 层级，确保它一定浮在主窗口之上。
    previewWindow.setAlwaysOnTop(true, 'screen-saver');
    if (typeof previewWindow.setVisibleOnAllWorkspaces === 'function') {
      previewWindow.setVisibleOnAllWorkspaces(true, { skipTransformProcessType: true });
    }
    previewWindow.once('ready-to-show', () => previewWindow.show());
    previewWindow.on('closed', () => {
      previewWindow = null;
      previewPayload = null;
    });
    previewWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await previewWindow.loadFile(path.join(__dirname, 'renderer', 'preview.html'));
    return { ok: true };
  });

  ipcMain.handle('image:preview-data', () => (previewPayload ? { ok: true, ...previewPayload } : { ok: false }));

  ipcMain.handle('post:pick-image', async (event) => {
    const { dialog } = require('electron');
    const target = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(target || undefined, {
      title: '选择图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] }]
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
    try {
      const file = result.filePaths[0];
      const bytes = require('node:fs').readFileSync(file);
      return { ok: true, name: path.basename(file), bytes: new Uint8Array(bytes) };
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('post:save-image', async (_event, payload) => {
    const check = config.validate(settings);
    if (!check.ok) return { ok: false, error: check.error };
    try {
      return posts.saveImage({ hexoRoot: settings.hexoRoot, ...(payload || {}) });
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('post:create', async (_event, form) => {
    const check = config.validate(settings);
    if (!check.ok) return { ok: false, error: check.error };
    let created = null;
    try {
      created = posts.createPost({ hexoRoot: settings.hexoRoot, ...(form || {}) });
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }

    // Remember the folder, so the next post defaults to where this one went.
    if (settings.postsDir !== created.dir) {
      settings = config.merge(settings, { postsDir: created.dir });
      config.write(settingsDir, settings);
    }

    let opened = false;
    if (settings.openAfterCreate) {
      // shell.openPath resolves to '' on success and to a message on failure.
      const failure = await shell.openPath(created.file);
      opened = !failure;
    }
    return { ok: true, relativePath: created.relativePath, dir: created.dir, file: created.file, opened };
  });

  ipcMain.handle('deploy:publish', () => runDeployTask('publish', () => deploy.publish()));

  ipcMain.handle('deploy:backup', (_event, message) => runDeployTask('backup', () => deploy.backup(message)));

  ipcMain.handle('deploy:both', (_event, message) => runDeployTask('both', async () => {
    const published = await deploy.publish();
    if (!published.ok) return published;
    return deploy.backup(message);
  }));

  ipcMain.handle('deploy:cancel', () => {
    if (!deploy.running) return { ok: false, error: '当前没有任务' };
    deploy.cancel();
    return { ok: true };
  });

  // The image crosses IPC as raw bytes on purpose — see the note in
  // lib/background.js about Blink truncating long CSS values.
  ipcMain.handle('appearance:getBackgroundImage', async () => {
    try {
      return { ok: true, bytes: await background.getBackgroundImage(settingsDir) };
    } catch (error) {
      return { ok: false, error: error.message || String(error), bytes: null };
    }
  });

  ipcMain.handle('appearance:chooseBackgroundImage', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: '选择背景图',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
    try {
      const source = result.filePaths[0];
      const bytes = await background.importBackgroundImage(source, settingsDir, nativeImage);
      // 记下原图路径，供设置里显示（图片本体是 userData 里的副本）
      settings = { ...settings, backgroundImageSource: source };
      config.write(settingsDir, settings);
      return { ok: true, bytes, source };
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  });

  // 缩放由主进程落在 webContents 上（渲染层改不了自己的缩放级别）
  ipcMain.handle('appearance:systemGlass', async (_event, value) => {
    settings = { ...settings, systemGlass: Boolean(value) };
    config.write(settingsDir, settings);
    applyNativeMaterialSetting();
    return { ok: true, nativeMaterial: wantsNativeMaterial(), settings: config.publicSettings(settings) };
  });

  ipcMain.handle('appearance:zoom', async (_event, value) => {
    const next = Math.max(config.ZOOM_MIN, Math.min(config.ZOOM_MAX, Number(Number(value).toFixed(2))));
    if (!Number.isFinite(next)) return { ok: false, error: '缩放值无效' };
    if (win && !win.isDestroyed()) win.webContents.setZoomFactor(next);
    return { ok: true, zoomFactor: next };
  });

  ipcMain.handle('appearance:clearBackgroundImage', async () => {
    try {
      await background.clearBackgroundImage(settingsDir);
      settings = { ...settings, backgroundImageSource: '' };
      config.write(settingsDir, settings);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('shell:showItem', async (_event, target) => {
    if (typeof target === 'string' && target) shell.showItemInFolder(target);
    return { ok: true };
  });

  // 这两个通道是"哪个窗口点的就作用在哪个窗口"。
  // 之前写死了主窗口：仪表板的 × 会去 app.quit()（整个程序跟着退），
  // 仪表板的 − 会去最小化主窗口。
  const windowFromEvent = (event) => BrowserWindow.fromWebContents(event.sender);

  // 置顶开关：只作用在调用方窗口上。持久化交给渲染层走它自己的 settings 保存链路，
  // 这里不碰配置文件，免得两处各写一份。
  //
  // 两个关键点照参考来：
  //   1. setAlwaysOnTop 要带层级参数 —— 只传 true 在 macOS 上常常浮不到最前；
  //   2. 同时 setVisibleOnAllWorkspaces，否则切到别的桌面/全屏 app 就看不见了。
  ipcMain.handle('window:pin', (event, value) => {
    const target = BrowserWindow.fromWebContents(event.sender);
    if (!target || target.isDestroyed()) return { ok: false, error: '窗口不可用' };
    try {
      const on = value === undefined ? !target.isAlwaysOnTop() : value === true;
      target.setAlwaysOnTop(on, 'floating');
      if (typeof target.setVisibleOnAllWorkspaces === 'function') {
        target.setVisibleOnAllWorkspaces(on, { skipTransformProcessType: true });
      }
      return { ok: true, alwaysOnTop: target.isAlwaysOnTop() };
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('window:minimize', (event) => {
    const target = windowFromEvent(event);
    if (target && !target.isDestroyed()) target.minimize();
    return { ok: true };
  });

  ipcMain.handle('window:close', (event) => {
    const target = windowFromEvent(event);
    // 图片预览只是个临时的子窗口，关掉它而已，不该退出程序
    if (target && target !== win) {
      if (!target.isDestroyed()) target.close();
      return { ok: true };
    }
    // 主窗口：A deploy owns public/ and .deploy_git; quitting mid-pipeline would
    // leave those half-written.
    if (deploy.running) {
      deploy.cancel();
      return { ok: false, error: '正在发布，已请求中止，请稍候再退出' };
    }
    app.quit();
    return { ok: true };
  });
}

// Only one instance may own the settings file and the preview toggle.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    settingsDir = app.getPath('userData');
    settings = config.read(settingsDir);
    preview.logFile = path.join(settingsDir, 'preview.log');
    registerIpc();
    // 非打包运行时 Dock 图标是 Electron 的原子图，必须显式换掉（打包后由 .app 决定）。
    // 先缩到 Dock 真正要的尺寸：原图解码后是 1024×1024 的位图，留着它主进程要多背
    // 几十 MB（见 DOCK_ICON_PX 那段注释）。
    if (process.platform === 'darwin' && app.dock) {
      const icon = nativeImage
        .createFromPath(APP_ICON)
        .resize({ width: DOCK_ICON_PX, height: DOCK_ICON_PX });
      if (!icon.isEmpty()) app.dock.setIcon(icon);
    }
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());

  // Deliberately no shutdown hook for the preview: it is a detached process, so
  // closing the control panel leaves the site running. Reopening the widget
  // shows the switch already on, and turning it off stops that server.
}
