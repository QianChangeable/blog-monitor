'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The CLI that ships with the site's own node_modules. Resolved per call, so a
// reinstall is picked up without restarting the widget.
function cliPath(root) {
  return path.join(root, 'node_modules', 'hexo-cli', 'bin', 'hexo');
}

function requireCli(root) {
  const cli = cliPath(root);
  if (!fs.existsSync(cli)) {
    throw new Error(`在 ${root} 找不到 hexo，请先在该目录执行 npm install`);
  }
  return cli;
}

const NODE_NAME = process.platform === 'win32' ? 'node.exe' : 'node';

function findOnPath(name) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (_) {
      // 目录不存在或没有权限，继续找
    }
  }
  return null;
}

function newestNvmNode() {
  const root = process.env.NVM_DIR
    ? path.join(process.env.NVM_DIR, 'versions', 'node')
    : path.join(os.homedir(), '.nvm', 'versions', 'node');
  let versions = [];
  try {
    versions = fs.readdirSync(root).filter((name) => /^v\d+\./.test(name));
  } catch (_) {
    return null;
  }
  versions.sort((a, b) => {
    const pa = a.slice(1).split('.').map(Number);
    const pb = b.slice(1).split('.').map(Number);
    for (let i = 0; i < 3; i += 1) {
      if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
    }
    return 0;
  });
  for (const version of versions.reverse()) {
    const candidate = path.join(root, version, 'bin', NODE_NAME);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// 找一个真正的 node 可执行文件。
//
// 为什么非找不可：process.execPath 是 .app 包里的 Electron 二进制。哪怕加了
// ELECTRON_RUN_AS_NODE=1 让它跑成 Node，macOS 仍会把这个进程登记成一个应用
// （LaunchServices 里会出现 com.github.Electron），并因此给它一个 Dock 图标；
// 而它没有图标资源，显示出来就是那个写着 exec 的通用占位图标。
// 换成真实 node 后，进程不在任何 .app 包内，macOS 不会给它 Dock 图标。
function resolveNodeBinary() {
  const fromNpm = process.env.npm_node_execpath;
  if (fromNpm && fs.existsSync(fromNpm)) return fromNpm;

  const onPath = findOnPath(NODE_NAME);
  if (onPath) return onPath;

  if (process.platform === 'darwin') {
    for (const candidate of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  return newestNvmNode();
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// One place decides how the site's tooling is launched, for both the preview
// server and the publish pipeline — the two must not drift.
//
// ELECTRON_RUN_AS_NODE turns this app's own binary into a plain Node runtime:
// process.execPath is Electron itself, so without it every spawn would boot a
// second Electron instance (Dock icon, GPU process, wrong argv) and depend on
// node being on PATH. On POSIX the shell wrapper raises the descriptor limit
// hexo-server's watcher needs, and `exec` keeps the pid — and the process group
// — equal to the one we record, so a single group kill stops everything.
function spawnSpec(root, args, { detach = false, env = {} } = {}) {
  const cli = requireCli(root);
  const baseEnv = { ...process.env, ...env };
  const quotedCli = shellQuote(cli);
  const quotedArgs = args.map(shellQuote).join(' ');
  const wrap = (binary) => `ulimit -n 10240 2>/dev/null || true; exec ${shellQuote(binary)} ${quotedCli} ${quotedArgs}`;

  const node = resolveNodeBinary();

  if (process.platform === 'win32') {
    // Windows 没有 Dock 概念，但用真实 node 仍然更干净（不必把它变成 Node 模式）
    return node
      ? { file: node, args: [cli, ...args], options: { cwd: root, env: baseEnv, windowsHide: true } }
      : { file: process.execPath, args: [cli, ...args], options: { cwd: root, env: { ...baseEnv, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true } };
  }

  if (node) {
    return { file: '/bin/sh', args: ['-c', wrap(node)], options: { cwd: root, env: baseEnv, detached: detach } };
  }

  // 兜底：确实找不到 node 时，用自身二进制以 Node 模式跑。功能上没问题，
  // 代价是 macOS 会多出一个 Dock 图标（见上面 resolveNodeBinary 的说明）。
  return {
    file: '/bin/sh',
    args: ['-c', wrap(process.execPath)],
    options: { cwd: root, env: { ...baseEnv, ELECTRON_RUN_AS_NODE: '1' }, detached: detach }
  };
}

module.exports = { cliPath, requireCli, shellQuote, spawnSpec };
