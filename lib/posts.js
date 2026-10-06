'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { DEFAULT_ABSTRACT } = require('./config');

// Posts live under source/_posts/, but not all in one folder: the site groups
// them into sibling directories (blog, LeetCode, diary) and sometimes one level
// deeper (diary/202510). The target folder is chosen per post, never assumed.
const POSTS_ROOT = path.join('source', '_posts');
const FALLBACK_DIR = 'blog';
const MAX_SCAN_DEPTH = 4;

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// Accepts what a human would type (2026-10-4, 2026/10/04 9:5, with or without
// seconds) and normalises to the exact shape Hexo writes itself. Empty = now.
function normalizeDate(input, now = new Date()) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return formatDate(now);
  const match = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (!match) return null;
  const [, year, month, day, hour = '0', minute = '0', second = '0'] = match;
  const [mo, d, h, mi, s] = [Number(month), Number(day), Number(hour), Number(minute), Number(second)];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  return `${year}-${pad(mo)}-${pad(d)} ${pad(h)}:${pad(mi)}:${pad(s)}`;
}

// ---------------------------------------------------------------- folder

// A folder name typed by a human ends up in a path, so it is normalised to
// forward slashes and each segment is checked — ".." can never climb out.
function normalizePostDir(value, fallback = FALLBACK_DIR) {
  const raw = String(value == null ? '' : value).trim().replace(/\\/g, '/');
  if (!raw) return fallback;
  const parts = raw.split('/').map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return fallback;
  for (const part of parts) {
    if (part === '.' || part === '..') throw new Error(`目录名不能是 ".."：${raw}`);
    if (/[<>:"|?*\u0000-\u001f]/.test(part)) throw new Error(`目录名含非法字符：${part}`);
  }
  return parts.join('/');
}

// Resolve inside source/_posts and prove it stayed there before anything is
// written — the normalisation above is the intent, this is the guarantee.
function resolvePostDir(hexoRoot, value) {
  const normalized = normalizePostDir(value);
  const base = path.resolve(hexoRoot, POSTS_ROOT);
  const target = path.resolve(base, ...normalized.split('/'));
  const relative = path.relative(base, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('目录必须位于 source/_posts 之内');
  }
  return { normalized, target };
}

// Every folder a post could go into, as source/_posts-relative paths ("blog",
// "diary/202510"), in tree order. Dot-directories are skipped; a folder is a
// legitimate target whether or not it already holds posts.
function listPostDirectories(hexoRoot, { maxDepth = MAX_SCAN_DEPTH } = {}) {
  const base = path.resolve(hexoRoot || '', POSTS_ROOT);
  const found = [];
  if (!hexoRoot) return found;

  const walk = (dir, prefix, depth) => {
    if (depth > maxDepth) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      found.push(relative);
      walk(path.join(dir, entry.name), relative, depth + 1);
    }
  };

  walk(base, '', 1);
  // Plain lexicographic order on the full path already reads as tree order,
  // because a child always shares its parent's prefix.
  return found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// ---------------------------------------------------------------- content

// Comma / CJK comma / 、 / semicolon / newline separated.
function parseList(input) {
  return String(input == null ? '' : input)
    .split(/[,，、;；\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

// YAML plain scalars break on these, so quote only when actually needed —
// keeps the front matter identical in style to the hand-written posts.
function yamlScalar(value) {
  const text = String(value);
  if (/^\s|\s$/.test(text) || /[:#\[\]{}&*!|>'"%@`,]/.test(text) || /^[-?]/.test(text)) {
    return JSON.stringify(text);
  }
  return text;
}

function buildFrontMatter(form, dateLine) {
  const lines = ['---', `title: ${yamlScalar(form.title)}`, `date: ${dateLine}`];

  const categories = parseList(form.categories);
  if (categories.length) {
    lines.push('categories:');
    for (const category of categories) lines.push(`- ${yamlScalar(category)}`);
  }

  const tags = parseList(form.tags);
  if (tags.length) {
    lines.push('tags:');
    for (const tag of tags) lines.push(`- ${yamlScalar(tag)}`);
  }

  const stickyRaw = String(form.sticky == null ? '' : form.sticky).trim();
  if (stickyRaw) {
    const sticky = Number(stickyRaw);
    if (!Number.isFinite(sticky)) throw new Error('置顶必须是数字（越大越靠前）');
    if (sticky !== 0) lines.push(`sticky: ${sticky}`);
  }

  lines.push('---', '');
  return lines.join('\n');
}

function buildContent(form) {
  const dateLine = normalizeDate(form.date);
  if (!dateLine) throw new Error('日期格式无法识别，请用 YYYY-MM-DD HH:mm:ss，或留空');

  const abstract = String(form.abstract == null ? '' : form.abstract).trim() || DEFAULT_ABSTRACT;

  // Same body shape as the existing posts: excerpt text, then the more marker
  // Fluid's index reads.
  return `${buildFrontMatter(form, dateLine)}\n${abstract}\n\n<!--more-->\n`;
}

// The filename is the title, with only the characters that cannot exist in a
// path replaced. CJK titles stay untouched (Git使用.md), spaces become the
// hyphens the existing posts already use (Hello-Git.md).
function fileNameFor(title) {
  const cleaned = String(title == null ? '' : title)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    // 全角变体先归一化（：／＊？＂＜＞｜ 在文件系统里合法，但混用很难看）
    .replace(/[：／＊？＂＜＞｜]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.\-\s]+|[.\-\s]+$/g, '')
    .slice(0, 80)
    .replace(/[.\-\s]+$/g, '');
  // Windows 保留了这些设备名（CON/PRN/AUX/NUL/COM1..9/LPT1..9），撞上就加后缀
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned)) return `${cleaned}-post.md`;
  return cleaned ? `${cleaned}.md` : '';
}

const POST_EXT = /\.md$/i;

// 图片目录的落点：source/img/<文章所在目录>/<文章名>/ —— 与仓库里
// img/blog/Hello-Git/、img/hot100/42/ 的现有结构一致。
function imageDirFor(hexoRoot, dir, slug) {
  return path.join(hexoRoot, 'source', 'img', dir, slug);
}

// 列出目录下的文章，并标出哪些还没有图片目录（给"补建"用）
function listPosts(hexoRoot, dir) {
  const { normalized, target } = resolvePostDir(hexoRoot, dir);
  let entries;
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: true, dir: normalized, posts: [] };
    throw error;
  }

  const posts = [];
  for (const entry of entries) {
    if (!entry.isFile() || !POST_EXT.test(entry.name)) continue;
    const slug = entry.name.replace(POST_EXT, '');
    posts.push({
      slug,
      file: entry.name,
      hasImageDir: fs.existsSync(imageDirFor(hexoRoot, normalized, slug))
    });
  }
  posts.sort((a, b) => a.slug.localeCompare(b.slug, 'zh'));
  return { ok: true, dir: normalized, posts };
}

// 给已有文章补建图片目录。只建空目录：不动文章、不改内容、不改配置。
function ensureImageDir(hexoRoot, dir, slug) {
  const { normalized, target } = resolvePostDir(hexoRoot, dir);
  const name = String(slug == null ? '' : slug).trim();
  if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) {
    throw new Error('文章名不合法');
  }
  if (!fs.existsSync(path.join(target, `${name}.md`))) {
    throw new Error(`找不到文章：${name}.md`);
  }

  const folder = path.resolve(imageDirFor(hexoRoot, normalized, name));
  const base = path.resolve(hexoRoot, 'source', 'img', normalized);
  // 规范化之后必须仍在这个目录内（文章名里带 .. 之类的一律拒绝）
  if (folder !== path.join(base, name) || !folder.startsWith(base + path.sep)) {
    throw new Error('文章名不合法');
  }

  const existed = fs.existsSync(folder);
  fs.mkdirSync(folder, { recursive: true });
  return {
    ok: true,
    dir: normalized,
    existed,
    imageDir: path.relative(hexoRoot, folder).split(path.sep).join('/')
  };
}

// 图片落盘。默认绝不覆盖：同名就让路（1.png → 1-2.png），返回实际用的名字。
// bytes 是从渲染层传过来的 Uint8Array。
function saveImage({ hexoRoot, dir, slug, name, bytes, append = false }) {
  const { normalized, target } = resolvePostDir(hexoRoot, dir);
  const post = String(slug == null ? '' : slug).trim();
  if (!post || post === '.' || post === '..' || /[\\/]/.test(post)) throw new Error('文章名不合法');
  if (!fs.existsSync(path.join(target, `${post}.md`))) throw new Error(`找不到文章：${post}.md`);

  const folder = path.resolve(imageDirFor(hexoRoot, normalized, post));
  const base = path.resolve(hexoRoot, 'source', 'img', normalized);
  if (folder !== path.join(base, post) || !folder.startsWith(base + path.sep)) {
    throw new Error('文章名不合法');
  }

  const payload = Buffer.from(bytes || []);
  if (!payload.length) throw new Error('没有收到图片数据');

  // 文件名沿用同一套非法字符规则；扩展名单独保留
  const raw = String(name == null ? '' : name).trim() || '1.png';
  const parsed = path.parse(raw);
  const ext = (parsed.ext || '.png').toLowerCase();
  const stem = String(parsed.name || '1')
    .replace(/[：／＊？＂＜＞｜]/g, '-')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.\-\s]+|[.\-\s]+$/g, '')
    .slice(0, 60) || 'image';

  fs.mkdirSync(folder, { recursive: true });

  let fileName = `${stem}${ext}`;
  let index = 2;
  while (fs.existsSync(path.join(folder, fileName))) {
    if (index > 999) throw new Error('同名图片太多了，换个名字');
    fileName = `${stem}-${index}${ext}`;
    index += 1;
  }
  fs.writeFileSync(path.join(folder, fileName), payload, { flag: 'wx' });

  const reference = `![${path.parse(fileName).name}](/img/${normalized}/${post}/${fileName})`;
  const result = {
    ok: true,
    fileName,
    renamed: fileName !== raw,
    relativePath: `source/img/${normalized}/${post}/${fileName}`,
    reference,
    appended: false
  };
  if (append) result.appended = appendImageReference(hexoRoot, normalized, post, reference);
  return result;
}

// 把引用追加到文章末尾：只在结尾补一个空行 + 一行引用，不动文章其它内容。
function appendImageReference(hexoRoot, dir, slug, reference) {
  const { target } = resolvePostDir(hexoRoot, dir);
  const file = path.join(target, `${slug}.md`);
  const text = fs.readFileSync(file, 'utf8');
  const needsBlank = !/\n\s*\n$/.test(text);
  fs.appendFileSync(file, `${needsBlank ? '\n\n' : ''}${reference}\n`, 'utf8');
  return true;
}

// 只读地读一下 post_asset_folder —— 只用于界面提示，绝不写配置
function assetFolderSetting(hexoRoot) {
  try {
    const text = fs.readFileSync(path.join(hexoRoot, '_config.yml'), 'utf8');
    const match = text.match(/^[ \t]*post_asset_folder:[ \t]*(\S+)/m);
    if (!match) return { ok: true, enabled: false, present: false };
    return { ok: true, enabled: /^true$/i.test(match[1]), present: true };
  } catch (error) {
    return { ok: false };
  }
}

function createPost({ hexoRoot, dir, assetFolder = false, ...form }) {
  const title = String(form.title == null ? '' : form.title).trim();
  if (!title) throw new Error('标题不能为空');

  const fileName = fileNameFor(title);
  if (!fileName) throw new Error('标题里没有可用作文件名的字符');

  const { normalized, target } = resolvePostDir(hexoRoot, dir);
  const file = path.join(target, fileName);

  // Never clobber an existing post: the widget is a scaffolder, not an editor.
  if (fs.existsSync(file)) {
    throw new Error(`已存在同名文章：${path.relative(hexoRoot, file).split(path.sep).join('/')}`);
  }

  fs.mkdirSync(target, { recursive: true });

  // wx: fail instead of overwriting if the file appeared between the check and
  // the write (another editor, a sync client).
  fs.writeFileSync(file, buildContent({ ...form, title }), { encoding: 'utf8', flag: 'wx' });

  // 图片目录照本仓库现成的约定：source/img/<文章目录>/<文章名>/
  // （例：img/blog/Hello-Git/1.png）。已存在就复用，多次创建同一篇的图不会报错。
  let assetDir = '';
  if (assetFolder) {
    const folder = imageDirFor(hexoRoot, normalized, path.basename(fileName, '.md'));
    fs.mkdirSync(folder, { recursive: true });
    assetDir = path.relative(hexoRoot, folder).split(path.sep).join('/');
  }

  return {
    file,
    dir: normalized,
    relativePath: path.relative(hexoRoot, file).split(path.sep).join('/'),
    assetDir
  };
}

module.exports = {
  FALLBACK_DIR,
  POSTS_ROOT,
  buildContent,
  createPost,
  fileNameFor,
  imageDirFor,
  listPosts,
  ensureImageDir,
  assetFolderSetting,
  saveImage,
  appendImageReference,
  listPostDirectories,
  normalizeDate,
  normalizePostDir,
  parseList,
  resolvePostDir
};
