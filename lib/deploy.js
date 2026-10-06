'use strict';

const { spawn } = require('node:child_process');

const git = require('./git');
const fs = require('node:fs');
const path = require('node:path');

const hexo = require('./hexo');

// No output at all for this long means the step is stuck, not slow. `git push`
// over a blocked HTTPS host never times out on its own and prints nothing while
// it hangs, so an idle kill is the only way out.
const IDLE_MS = 60000;
const PROBE_IDLE_MS = 12000;
const KILL_GRACE_MS = 3000;
const OUTPUT_TAIL = 40;

function isWindows() {
  return process.platform === 'win32';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class DeployRunner {
  constructor({ getSettings, preview, onEvent } = {}) {
    this.getSettings = getSettings || (() => ({}));
    this.preview = preview || null;
    this.onEvent = onEvent || (() => {});
    this.child = null;
    this.running = false;
    this.task = null;
    this.cancelled = false;
  }

  emit(event) {
    try {
      this.onEvent(event);
    } catch (_) {
      // A renderer that went away must not break the pipeline.
    }
  }

  log(line) {
    this.emit({ type: 'log', line: String(line) });
  }

  status(text) {
    this.emit({ type: 'status', text });
  }

  setRunning(running, task = null) {
    this.running = running;
    this.task = running ? task : null;
    this.emit({ type: 'state', running, task: this.task });
  }

  cancel() {
    this.cancelled = true;
    this.log('—— 已请求中止 ——');
    this.kill(this.child);
  }

  kill(child) {
    if (!child || !child.pid) return;
    if (isWindows()) {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      return;
    }
    // Negative pid signals the whole process group, so an ssh or git child of
    // the pipeline dies with it.
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch (_) {
      try { child.kill('SIGTERM'); } catch (_) {}
    }
    setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    }, KILL_GRACE_MS).unref();
  }

  gitEnv() {
    // 唯一来源在 lib/git.js（activity 也用同一份）：那里的注释记着为什么必须继承
    // process.env —— 丢掉 HOME 会让 git 找不到提交身份，commit 直接 exit 128。
    return git.gitEnv();
  }

  // Resolves (never rejects) with { ok, code, error, output }.
  runStep({ title, display, file, args, options = {}, idleMs = IDLE_MS }) {
    return new Promise((resolve) => {
      this.status(title);
      this.log(`$ ${display}`);

      const output = [];
      let settled = false;
      let idleTimer = null;
      // The kill we send on idle makes `close` fire before the grace period is
      // over, so remember why we killed it — otherwise the step reports the
      // SIGTERM instead of the real reason.
      let timedOut = false;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(idleTimer);
        resolve({ output, ...result });
      };

      let child;
      try {
        child = spawn(file, args, {
          ...options,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: options.detached !== undefined ? options.detached : !isWindows()
        });
      } catch (error) {
        finish({ ok: false, code: null, error: error.message });
        return;
      }
      this.child = child;

      const armIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(async () => {
          timedOut = true;
          this.log(`—— ${Math.round(idleMs / 1000)}s 无任何输出，判定卡死，正在终止 ——`);
          this.kill(child);
          await delay(KILL_GRACE_MS);
          finish({ ok: false, code: null, error: 'idle-timeout' });
        }, idleMs);
      };
      armIdle();

      const onData = (chunk) => {
        armIdle();
        for (const line of String(chunk).split(/\r?\n/)) {
          if (!line.trim()) continue;
          output.push(line);
          if (output.length > OUTPUT_TAIL) output.shift();
          this.log(line);
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);

      child.once('error', (error) => finish({ ok: false, code: null, error: error.message }));
      child.once('close', (code, signal) => {
        if (this.child === child) this.child = null;
        if (timedOut) {
          finish({ ok: false, code, signal, error: 'idle-timeout' });
          return;
        }
        finish({ ok: code === 0, code, signal, error: code === 0 ? null : `exit ${code === null ? signal : code}` });
      });
    });
  }

  // -------------------------------------------------------------- pipeline

  readDeployUrl(root) {
    // Uses the site's own js-yaml — the widget deliberately carries no YAML
    // dependency of its own.
    try {
      const yaml = require(path.join(root, 'node_modules', 'js-yaml'));
      const doc = yaml.load(fs.readFileSync(path.join(root, '_config.yml'), 'utf8'));
      const deploy = doc && doc.deploy;
      if (!deploy) return null;
      const raw = deploy.repository || deploy.repo;
      if (typeof raw === 'string') return raw;
      if (raw && typeof raw === 'object') {
        const first = Object.values(raw)[0];
        if (typeof first === 'string') return first;
        if (first && typeof first.url === 'string') return first.url;
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  async probe(url, cwd) {
    const result = await this.runStep({
      title: '检查发布通道',
      display: `git ls-remote --heads ${url}`,
      file: 'git',
      args: ['ls-remote', '--heads', url],
      options: { cwd, env: this.gitEnv() },
      idleMs: PROBE_IDLE_MS
    });
    return result.ok;
  }

  async hexoStep(root, { title, display, args }, idleMs = IDLE_MS) {
    const spec = hexo.spawnSpec(root, args, { env: { BROWSER: 'none' } });
    return this.runStep({ title, display, file: spec.file, args: spec.args, options: spec.options, idleMs });
  }

  async publish() {
    const root = this.getSettings().hexoRoot;
    this.log('=== 发布到线上 ===');

    const url = this.readDeployUrl(root);
    if (url) {
      this.log(`发布目标：${url}`);
      if (!(await this.probe(url, root))) {
        if (this.cancelled) return { ok: false, error: 'cancelled' };
        this.log('✗ 发布通道不可达，已中止——public/ 和 .deploy_git 未被改动。');
        this.log('  GitHub 的 443 端口在部分网络下会被拦截；开代理，或把 _config.yml 的');
        this.log('  deploy.repository 临时换成 SSH 地址（git@github.com:...）后重试。');
        return { ok: false, error: '发布通道不可达（hexo d 会一直挂住）' };
      }
      this.log('发布通道正常。');
    } else {
      this.log('未能从 _config.yml 解析出 deploy 地址，跳过通道预检。');
    }

    // hexo clean deletes public/ and db.json. A running `hexo server` serves the
    // former and keeps regenerating into it, so publishing with it up can copy a
    // half-written tree into .deploy_git and push that.
    const previewWasRunning = this.preview ? (await this.preview.status()).running : false;
    if (previewWasRunning) {
      this.log('本地预览正在运行，先停掉（避免两个进程同时写 public/）。');
      try {
        await this.preview.stop();
      } catch (error) {
        this.log(`停止预览失败：${error.message}`);
      }
    }

    let result = { ok: true };
    try {
      const steps = [
        { title: '清理 public/ 与缓存', display: 'hexo clean', args: ['clean'] },
        { title: '生成静态站点', display: 'hexo generate', args: ['generate'] },
        { title: '推送到 Pages 仓库', display: 'hexo deploy', args: ['deploy'] }
      ];
      for (const step of steps) {
        if (this.cancelled) {
          result = { ok: false, error: 'cancelled' };
          break;
        }
        const stepResult = await this.hexoStep(root, step);
        if (!stepResult.ok) {
          this.log(`✗ ${step.display} 失败（${stepResult.error}）`);
          result = { ok: false, error: `${step.display} 失败（${stepResult.error}）` };
          break;
        }
      }
    } finally {
      if (previewWasRunning && !this.cancelled) {
        this.log('恢复本地预览…');
        try {
          await this.preview.start();
          this.log('预览已恢复，浏览器里刷新一下即可。');
        } catch (error) {
          this.log(`预览恢复失败：${error.message}`);
        }
      }
    }

    if (result.ok) {
      this.log('✓ 发布完成，打开线上地址。');
      this.emit({ type: 'open-live' });
    }
    return result;
  }

  async backup(message) {
    const root = this.getSettings().hexoRoot;
    const commitMessage = String(message == null ? '' : message).trim() || 'docs: update posts';
    this.log('=== 提交并推送源码 ===');
    this.log(`提交信息：${commitMessage}`);

    const gitStep = (title, display, args) => this.runStep({
      title,
      display,
      file: 'git',
      args,
      options: { cwd: root, env: this.gitEnv() }
    });

    const add = await gitStep('暂存改动', 'git add -A', ['add', '-A']);
    if (!add.ok) {
      this.log(`✗ git add 失败（${add.error}）`);
      return { ok: false, error: `git add 失败（${add.error}）` };
    }

    const commit = await this.runStep({
      title: '提交改动',
      display: `git commit -m "${commitMessage}"`,
      file: 'git',
      args: ['commit', '-m', commitMessage],
      options: { cwd: root, env: this.gitEnv() }
    });
    const nothingToCommit = commit.output.some((line) => /nothing to commit|no changes added to commit|nothing added to commit/i.test(line));
    if (!commit.ok && nothingToCommit) {
      this.log('没有需要提交的改动，只做 push。');
    } else if (!commit.ok) {
      // 没配提交身份时，git 只丢一句 "Author identity unknown" 加 exit 128，
      // 对用户毫无指向性。换成能照着做的说明。
      const noIdentity = commit.output.some((line) => (
        /author identity unknown|unable to auto-detect email address|empty ident name/i.test(line)
      ));
      if (noIdentity) {
        const hint = 'git 尚未配置提交身份，无法提交。请先在终端执行 git config --global user.name 与 user.email';
        this.log(`✗ ${hint}`);
        return { ok: false, error: hint };
      }
      this.log(`✗ git commit 失败（${commit.error}）`);
      return { ok: false, error: `git commit 失败（${commit.error}）` };
    }

    const push = await gitStep('推送到远端', 'git push', ['push']);
    if (!push.ok) {
      const noUpstream = push.output.some((line) => /has no upstream branch|no upstream/i.test(line));
      if (noUpstream) {
        this.log('远端没有对应的上游分支，改用 git push -u origin HEAD。');
        const retry = await gitStep('推送到远端（首次建立上游）', 'git push -u origin HEAD', ['push', '-u', 'origin', 'HEAD']);
        if (!retry.ok) {
          this.log(`✗ git push 失败（${retry.error}）`);
          return { ok: false, error: `git push 失败（${retry.error}）` };
        }
      } else {
        this.log(`✗ git push 失败（${push.error}）`);
        return { ok: false, error: `git push 失败（${push.error}）` };
      }
    }

    this.log('✓ 源码已推送到远端。');
    return { ok: true };
  }
}

module.exports = { DeployRunner };
