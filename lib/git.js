'use strict';

const { spawn } = require('node:child_process');

// git 子进程的环境。必须继承 process.env —— 这里曾经是个"干净"的对象，把 HOME 一起
// 弄丢了，git 于是读不到 ~/.gitconfig 里的提交身份，commit 直接 exit 128；SSH_AUTH_SOCK
// 也一起丢，push 用不上 ssh-agent。deploy 与 activity 共用这一份，同样的坑不写第二遍。
function gitEnv() {
  return {
    ...process.env,
    // 覆盖这几项：让 git 立刻失败并给出可读信息，而不是卡在没人能回答的密码提示上。
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'echo',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
    GIT_PAGER: 'cat',
    GIT_EDITOR: 'true'
  };
}

// 跑一条 git 命令，永不 reject，返回 { ok, code, stdout, stderr }。
function runGit(args, { cwd, timeoutMs = 10000, maxBytes = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', args, { cwd, env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, code: null, stdout: '', stderr: error.message });
      return;
    }

    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (payload) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) { /* 已经退出了 */ }
      finish({ ok: false, code: null, stdout, stderr: stderr || 'git 超时' });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (stdout.length < maxBytes) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 8192) stderr += chunk.toString('utf8');
    });
    child.once('error', (error) => finish({ ok: false, code: null, stdout, stderr: error.message }));
    child.once('close', (code) => finish({ ok: code === 0, code, stdout, stderr }));
  });
}

module.exports = { gitEnv, runGit };
