'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Fallback excerpt body. It is written verbatim when the field is left empty,
// exactly like the `<!--more-->` posts already in source/_posts/.
const DEFAULT_ABSTRACT = '可花谢花开，终有梦醒时分.';

// Windows keeps the blog on a second drive (the shell/stop-preview.sh fallback
// accepts /mnt/f/Hexo, F:/Hexo), so the guess differs per platform. Both are
// just defaults — the settings card lets you pick the real directory.
const DEFAULTS = Object.freeze({
  hexoRoot: process.platform === 'win32' ? 'F:\\Hexo' : path.join(os.homedir(), 'Coding', 'Hexo'),
  liveUrl: 'https://qianchangeable.github.io/',
  port: 4000,
  edgeBrowser: true,
  openAfterCreate: true,
  postsDir: 'blog',
  backgroundImageAlpha: 28,
  // 选中那张图的原始路径。背景图本体是拷进 userData 的副本，
  // 这个字段只用来在设置里显示"你选的是哪张"，由主进程在选图/清除时写。
  backgroundImageSource: '',
  // 打字机。默认值对齐 Hexo 主题 _config.fluid.yml 的 fun_features.typing
  // （typeSpeed: 70、cursorChar: "_"、loop: false）；双引号与你 index.slogan.text 一致
  typedContent: '"可花谢花开，终有梦醒时分."',
  typedSpeed: 70,
  sayText: 'SAY',
  signatureText: 'Qian_Chang',
  alwaysOnTop: false,
  // 外观三件套，语义与 token-monitor 一致：
  // 玻璃 → 面板底色的透明度；深度 → 发丝线与控件的"厚度"；缩放 → 整个界面的缩放
  glassOpacity: 68,
  glassBlur: 32,
  zoomFactor: 1,
  // 是否使用 macOS/Windows 的原生毛玻璃材质。
  // macOS 26（Darwin 25）上旧材质有已知问题（窗口可能"只呈现材质、页面内容没上来"，
  // 表现为切回窗口时先闪一片灰），所以那里默认关闭，由页面自己画底色。
  systemGlass: !(process.platform === 'darwin' && Number.parseInt(os.release(), 10) >= 25)
});

const SETTINGS_FILE = 'settings.json';

function read(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, SETTINGS_FILE), 'utf8'));
    return merge(DEFAULTS, raw);
  } catch (_) {
    return { ...DEFAULTS };
  }
}

function write(dir, settings) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, SETTINGS_FILE), `${JSON.stringify(settings, null, 2)}\n`);
}

// Coerce instead of trust: settings.json is hand-editable and a stray string
// port would otherwise reach net.connect().
function merge(current, patch) {
  const next = { ...DEFAULTS, ...current };
  if (!patch || typeof patch !== 'object') return next;
  if (typeof patch.hexoRoot === 'string' && patch.hexoRoot.trim()) next.hexoRoot = patch.hexoRoot.trim();
  if (typeof patch.liveUrl === 'string' && patch.liveUrl.trim()) next.liveUrl = patch.liveUrl.trim();
  if (typeof patch.postsDir === 'string' && patch.postsDir.trim()) next.postsDir = patch.postsDir.trim();
  for (const key of ['typedContent']) {
    if (typeof patch[key] === 'string') next[key] = patch[key];
  }
  const glassOpacity = Number(patch.glassOpacity);
  if (Number.isFinite(glassOpacity)) next.glassOpacity = Math.max(0, Math.min(100, Math.round(glassOpacity)));
  const glassBlur = Number(patch.glassBlur);
  if (Number.isFinite(glassBlur)) next.glassBlur = Math.max(0, Math.min(100, Math.round(glassBlur)));
  if (typeof patch.systemGlass === 'boolean') next.systemGlass = patch.systemGlass;
  const zoomFactor = Number(patch.zoomFactor);
  if (Number.isFinite(zoomFactor)) next.zoomFactor = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Number(zoomFactor.toFixed(2))));

  const typedSpeed = Number(patch.typedSpeed);
  if (Number.isFinite(typedSpeed)) next.typedSpeed = Math.max(10, Math.min(400, Math.round(typedSpeed)));
  if (typeof patch.backgroundImageSource === 'string') next.backgroundImageSource = patch.backgroundImageSource;
  const alpha = Number(patch.backgroundImageAlpha);
  if (Number.isFinite(alpha)) next.backgroundImageAlpha = Math.max(0, Math.min(100, Math.round(alpha)));
  const port = Number(patch.port);
  if (Number.isInteger(port)) next.port = port;
  if (typeof patch.edgeBrowser === 'boolean') next.edgeBrowser = patch.edgeBrowser;
  if (typeof patch.openAfterCreate === 'boolean') next.openAfterCreate = patch.openAfterCreate;
  return next;
}

function validate(settings) {
  const root = settings && settings.hexoRoot;
  if (!root) return { ok: false, error: '请先选择 Hexo 目录' };
  let stat = null;
  try {
    stat = fs.statSync(root);
  } catch (_) {
    stat = null;
  }
  if (!stat || !stat.isDirectory()) return { ok: false, error: `Hexo 目录不存在：${root}` };
  if (!/^https?:\/\//i.test(String(settings.liveUrl || ''))) {
    return { ok: false, error: '线上地址必须以 http:// 或 https:// 开头' };
  }
  if (!Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535) {
    return { ok: false, error: '端口必须是 1 - 65535 之间的整数' };
  }
  return { ok: true };
}

function previewUrl(settings) {
  return `http://localhost:${settings.port}/`;
}

// What the renderer is allowed to see. No secrets here, but keeping one
// projection means a future field cannot leak by accident.
// 缩放范围（与 token-monitor 的 ZOOM_LIMITS 一致）
const ZOOM_MIN = 0.7;
const ZOOM_MAX = 1.6;

function publicSettings(settings) {
  const check = validate(settings);
  return {
    hexoRoot: settings.hexoRoot,
    liveUrl: settings.liveUrl,
    port: settings.port,
    edgeBrowser: settings.edgeBrowser,
    openAfterCreate: settings.openAfterCreate,
    postsDir: settings.postsDir || DEFAULTS.postsDir,
    typedContent: settings.typedContent == null ? DEFAULTS.typedContent : String(settings.typedContent),
    typedSpeed: Number.isFinite(Number(settings.typedSpeed))
      ? Math.max(10, Math.min(400, Math.round(Number(settings.typedSpeed))))
      : DEFAULTS.typedSpeed,
    sayText: settings.sayText,
    signatureText: settings.signatureText,
    alwaysOnTop: settings.alwaysOnTop === true,
    glassOpacity: Number.isFinite(Number(settings.glassOpacity))
      ? Math.max(0, Math.min(100, Math.round(Number(settings.glassOpacity))))
      : DEFAULTS.glassOpacity,
    glassBlur: Number.isFinite(Number(settings.glassBlur))
      ? Math.max(0, Math.min(100, Math.round(Number(settings.glassBlur))))
      : DEFAULTS.glassBlur,
    systemGlass: settings.systemGlass == null ? DEFAULTS.systemGlass : Boolean(settings.systemGlass),
    zoomFactor: Number.isFinite(Number(settings.zoomFactor))
      ? Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Number(Number(settings.zoomFactor).toFixed(2))))
      : DEFAULTS.zoomFactor,
    backgroundImageSource: settings.backgroundImageSource == null ? '' : String(settings.backgroundImageSource),
    backgroundImageAlpha: Number.isFinite(Number(settings.backgroundImageAlpha))
      ? Math.max(0, Math.min(100, Math.round(Number(settings.backgroundImageAlpha))))
      : DEFAULTS.backgroundImageAlpha,
    previewUrl: previewUrl(settings),
    valid: check.ok,
    validError: check.ok ? '' : check.error
  };
}

module.exports = {
  ZOOM_MIN,
  ZOOM_MAX,
  DEFAULT_ABSTRACT,
  DEFAULTS,
  merge,
  previewUrl,
  publicSettings,
  read,
  validate,
  write
};
