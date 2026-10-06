'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { shell } = require('electron');

const MAC_EDGE_APP = '/Applications/Microsoft Edge.app';

function windowsEdgePaths() {
  return [
    'C:\\Program Files (x86)\\Microsoft Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft Edge\\Application\\msedge.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : ''
  ].filter(Boolean);
}

// Detached + unref so the browser is not a child of the widget: closing the
// window or quitting must never take the browser page down with it.
function launch(file, args) {
  try {
    const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch (_) {
    return false;
  }
}

// `preferEdge` opens the local preview in Edge (the requested behaviour); the
// live site uses the OS default browser. Every Edge path falls back to
// shell.openExternal rather than failing the action.
async function open(url, { preferEdge = false } = {}) {
  if (preferEdge && process.platform === 'darwin' && fs.existsSync(MAC_EDGE_APP)) {
    if (launch('open', ['-a', 'Microsoft Edge', url])) return { browser: 'edge' };
  }

  if (preferEdge && process.platform === 'win32') {
    const exe = windowsEdgePaths().find((candidate) => fs.existsSync(candidate));
    if (exe && launch(exe, [url])) return { browser: 'edge' };
    // Edge registers an App Paths entry, so `start msedge` resolves without an
    // absolute path.
    if (launch('cmd.exe', ['/c', 'start', '', 'msedge', url])) return { browser: 'edge' };
  }

  await shell.openExternal(url);
  return { browser: 'default', fallback: preferEdge };
}

module.exports = { open };
