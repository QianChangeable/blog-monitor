'use strict';

const git = require('./git');

const DAY_MS = 86400000;
// 网格跨度：26 周（半年），和参考首页展示的区间差不多
const WEEKS = 26;

// 本机日历的 YYYY-MM-DD。必须用本机时区：git log --date=short 输出的就是本机日期，
// 用 UTC 算"今天"会在东八区傍晚之后差一天（本机已是次日、UTC 还没到），
// 于是当天那笔提交落在网格之外 —— 元信息说 15 天、格子里只有 14 个。
function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// 网格按周日起列（GitHub 那种）。窗口右端是本机今天、左端回到 WEEKS 周前那一周的周日。
// 日期加减一律走 setDate：跨夏令时那天按毫秒减会差一小时，进而差一天。
function windowRange(now, weeks = WEEKS) {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  start.setDate(start.getDate() - (weeks * 7 - 1));
  start.setDate(start.getDate() - start.getDay());
  return { from: formatLocalDate(start), to: formatLocalDate(end) };
}

function describeGitFailure(stderr) {
  const text = String(stderr || '');
  if (/not a git repository/i.test(text)) return '这个目录不是 git 仓库';
  if (/ENOENT|command not found/i.test(text)) return '找不到 git 命令';
  if (/超时/.test(text)) return '读取提交记录超时';
  return text.trim().split('\n')[0] || 'git log 失败';
}

// 读 hexoRoot 那个仓库的提交记录，按天汇总。
// 用 %cd（提交日期）而不是 %ad，好和 --since 的过滤口径一致。
async function readActivity(root, { now = new Date(), timeoutMs = 10000, weeks = WEEKS } = {}) {
  const { from, to } = windowRange(now, weeks);
  const result = await git.runGit(
    ['log', `--since=${from}T00:00:00`, '--date=short', '--pretty=format:%cd'],
    { cwd: root, timeoutMs }
  );
  if (!result.ok) return { ok: false, error: describeGitFailure(result.stderr), from, to };

  const byDay = {};
  for (const line of result.stdout.split('\n')) {
    const day = line.trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    byDay[day] = (byDay[day] || 0) + 1;
  }

  // 窗口外的日期一律剔除（例如系统时钟偏了、或提交日期在未来）：
  // 否则元信息的"活跃 N 天"会比网格里画出来的格子多，两边对不上。
  for (const day of Object.keys(byDay)) {
    if (day < from || day > to) delete byDay[day];
  }

  const counts = Object.values(byDay);
  return {
    ok: true,
    from,
    to,
    byDay,
    activeDays: counts.length,
    total: counts.reduce((sum, value) => sum + value, 0)
  };
}

module.exports = { readActivity };
