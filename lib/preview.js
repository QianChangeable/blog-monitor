'use strict';

const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const hexo = require('./hexo');

const START_TIMEOUT_MS = 40000;
const GRACE_MS = 6000;
const LOG_TAIL_LINES = 12;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A completed TCP handshake is the only honest "the server is serving" signal:
// hexo prints its banner before the listener is actually accepting.
function probePort(port, timeout = 700) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect({ host: '127.0.0.1', port });
  });
}

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      resolve({ ok: !error, stdout: String(stdout || '') });
    });
  });
}

// ---------------------------------------------------------------- discovery

async function findListenerPids(port) {
  if (process.platform === 'win32') {
    const { stdout } = await run('netstat', ['-ano', '-p', 'TCP']);
    const pids = new Set();
    for (const rawLine of stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!/LISTENING/i.test(line)) continue;
      const columns = line.split(/\s+/);
      const local = columns[1] || '';
      if (!local.endsWith(`:${port}`)) continue;
      const pid = columns[columns.length - 1];
      if (/^\d+$/.test(pid) && pid !== '0') pids.add(pid);
    }
    return [...pids];
  }
  const { stdout } = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  return [...new Set(stdout.split(/\s+/).filter(Boolean))];
}

async function commandLineOf(pid) {
  if (process.platform === 'win32') {
    const { stdout } = await run('powershell.exe', [
      '-NoProfile',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`
    ]);
    return stdout.trim();
  }
  const { stdout } = await run('ps', ['-ww', '-p', String(pid), '-o', 'command=']);
  return stdout.trim();
}

// Safety net mirroring shell/stop-preview.sh: a listener on the preview port is
// only ours to kill when its command line names hexo (or this Hexo root). An
// unrelated dev server on :4000 must survive.
async function isOursToKill(pid, hexoRoot) {
  const command = (await commandLineOf(pid)).toLowerCase();
  if (!command) return false;
  if (command.includes('hexo')) return true;
  const root = String(hexoRoot || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return Boolean(root) && command.replace(/\\/g, '/').includes(root);
}

async function killPid(pid, { group = false, force = false } = {}) {
  if (process.platform === 'win32') {
    await run('taskkill', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])]);
    return;
  }
  try {
    if (group) process.kill(-Number(pid), force ? 'SIGKILL' : 'SIGTERM');
    else process.kill(Number(pid), force ? 'SIGKILL' : 'SIGTERM');
  } catch (_) {
    // Already gone, or not ours to signal.
  }
}

// ---------------------------------------------------------------- manager

class PreviewManager {
  constructor({ getSettings, logFile } = {}) {
    this.getSettings = getSettings || (() => ({}));
    this.logFile = logFile || '';
    this.child = null;
    this.starting = false;
    this.spawnError = null;
  }

  async status() {
    const { port } = this.getSettings();
    const running = await probePort(port);
    return { running, port, starting: this.starting, logFile: this.logFile };
  }

  readLogTail() {
    if (!this.logFile) return '';
    try {
      const lines = fs.readFileSync(this.logFile, 'utf8').split(/\r?\n/).filter(Boolean);
      return lines.slice(-LOG_TAIL_LINES).join('\n');
    } catch (_) {
      return '';
    }
  }

  // A child that exits (or fails to spawn) is a definitive failure, not
  // something to keep waiting on until the timeout.
  async waitForPort(port, timeoutMs, child) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await probePort(port)) return true;
      if (this.spawnError) return false;
      if (child && child.exitCode !== null) return false;
      await delay(300);
    }
    return false;
  }

  async start() {
    const settings = this.getSettings();
    const { port } = settings;
    const root = settings.hexoRoot;

    if (!root || !fs.existsSync(root)) throw new Error(`找不到 Hexo 目录：${root || '(未设置)'}`);
    if (await probePort(port)) return { running: true, port, already: true };

    hexo.requireCli(root);

    // The server writes into a real file instead of a pipe: the widget may be
    // closed while the preview keeps running, and a pipe would then break under
    // the child and take the server down with it.
    let logFd = 'ignore';
    if (this.logFile) {
      try {
        fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
        logFd = fs.openSync(this.logFile, 'w');
      } catch (_) {
        logFd = 'ignore';
      }
    }

    const spec = hexo.spawnSpec(root, ['server', '-p', String(port)], {
      detach: process.platform !== 'win32',
      env: { BROWSER: 'none' }
    });
    this.starting = true;
    this.spawnError = null;
    try {
      this.child = spawn(spec.file, spec.args, { ...spec.options, stdio: ['ignore', logFd, logFd] });
      if (process.platform !== 'win32') this.child.unref();
      if (typeof logFd === 'number') fs.closeSync(logFd);

      const child = this.child;
      child.once('error', (error) => {
        this.spawnError = error;
        if (this.child === child) this.child = null;
      });
      child.once('exit', () => {
        if (this.child === child) this.child = null;
      });

      const listening = await this.waitForPort(port, START_TIMEOUT_MS, child);
      if (!listening) {
        const tail = this.readLogTail();
        await this.stop({ silent: true });
        const reason = this.spawnError
          ? `无法启动 hexo server：${this.spawnError.message}`
          : `启动超时，端口 ${port} 没有开始监听`;
        throw new Error(`${reason}${tail ? `\n${tail}` : ''}`);
      }
      return { running: true, port, started: true };
    } finally {
      this.starting = false;
    }
  }

  async stop({ silent = false } = {}) {
    const settings = this.getSettings();
    const { port } = settings;

    const myPid = this.child && this.child.pid ? String(this.child.pid) : '';
    const listeners = await findListenerPids(port);

    const targets = [];
    if (myPid) targets.push({ pid: myPid, group: process.platform !== 'win32' });
    for (const pid of listeners) {
      if (pid === myPid) continue;
      if (await isOursToKill(pid, settings.hexoRoot)) targets.push({ pid, group: false });
    }

    if (!targets.length) {
      const stillListening = await probePort(port);
      if (stillListening && !silent) {
        throw new Error(`端口 ${port} 被其他程序占用，已跳过（这里只停止本 Hexo 站点的预览）`);
      }
      this.child = null;
      return { running: stillListening, port, stopped: !stillListening };
    }

    for (const target of targets) await killPid(target.pid, { group: target.group, force: false });

    const deadline = Date.now() + GRACE_MS;
    while (Date.now() < deadline) {
      if (!(await probePort(port))) {
        this.child = null;
        return { running: false, port, stopped: true };
      }
      await delay(250);
    }

    // Escalate only after the graceful window, and only for the pids we had
    // already decided were ours.
    for (const target of targets) await killPid(target.pid, { group: false, force: true });
    await delay(400);

    const freed = !(await probePort(port));
    this.child = null;
    if (!freed && !silent) {
      throw new Error(`无法停止端口 ${port} 上的进程，请手动结束`);
    }
    return { running: !freed, port, stopped: freed };
  }
}

module.exports = { PreviewManager, findListenerPids, probePort };
