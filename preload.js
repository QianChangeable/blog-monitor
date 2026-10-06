'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Renderer is default-deny: it only ever sees these channels, never a path it
// could write to on its own. Every filesystem/process action stays in main.
contextBridge.exposeInMainWorld('blogWidget', {
  getState: () => ipcRenderer.invoke('app:state'),

  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  chooseHexoRoot: () => ipcRenderer.invoke('settings:chooseRoot'),

  openLive: () => ipcRenderer.invoke('live:open'),

  previewStatus: () => ipcRenderer.invoke('preview:status'),
  startPreview: () => ipcRenderer.invoke('preview:start'),
  stopPreview: () => ipcRenderer.invoke('preview:stop'),

  getBackgroundImage: () => ipcRenderer.invoke('appearance:getBackgroundImage'),
  chooseBackgroundImage: () => ipcRenderer.invoke('appearance:chooseBackgroundImage'),
  clearBackgroundImage: () => ipcRenderer.invoke('appearance:clearBackgroundImage'),
  setZoom: (value) => ipcRenderer.invoke('appearance:zoom', value),
  readActivity: (weeks) => ipcRenderer.invoke('activity:read', weeks),
  setSystemGlass: (value) => ipcRenderer.invoke('appearance:systemGlass', value),

  listPostDirectories: () => ipcRenderer.invoke('posts:directories'),
  createPost: (form) => ipcRenderer.invoke('post:create', form),
  listPosts: (dir) => ipcRenderer.invoke('post:list', dir),
  ensureImageDir: (dir, slug) => ipcRenderer.invoke('post:ensure-image-dir', { dir, slug }),
  saveImage: (payload) => ipcRenderer.invoke('post:save-image', payload),
  pickImage: () => ipcRenderer.invoke('post:pick-image'),
  previewImage: (payload) => ipcRenderer.invoke('image:preview', payload),
  getPreviewImage: () => ipcRenderer.invoke('image:preview-data'),
  revealPath: (target) => ipcRenderer.invoke('shell:showItem', target),

  publish: () => ipcRenderer.invoke('deploy:publish'),
  backupSource: (message) => ipcRenderer.invoke('deploy:backup', message),
  publishAndBackup: (message) => ipcRenderer.invoke('deploy:both', message),
  cancelDeploy: () => ipcRenderer.invoke('deploy:cancel'),
  onDeployEvent: (callback) => {
    const listener = (_event, payload) => {
      try {
        callback(payload);
      } catch (_) {
        // A renderer bug must not take the IPC channel down with it.
      }
    };
    ipcRenderer.on('deploy:event', listener);
    return () => ipcRenderer.removeListener('deploy:event', listener);
  },

  setAlwaysOnTop: (value) => ipcRenderer.invoke('window:pin', value),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  close: () => ipcRenderer.invoke('window:close')
});
