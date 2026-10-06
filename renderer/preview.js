'use strict';

// 图片预览窗口：只做三件事 —— 把图铺满显示、显示尺寸、能关掉。
//
// 曾经在这里做过 Shift+滚轮缩放，删掉了：按"每个 wheel 事件 ×1.1"的写法在触控板上
// 一次滑动会发几十个事件，倍率指数爆炸（"突然放大"），deltaY 的正负在密集事件里还会
// 抖动（"上下滚都是缩小"），触底后又被我 clamp 死（"缩小到最小就动不了"）。要做对得处理
// 事件累积、惯性和触底反馈，而真实需求只是"点开看清楚" —— 直接拖大窗口就够了，
// 那是系统级的缩放，稳当且没有边界情况。

const api = window.blogWidget;
const $ = (id) => document.getElementById(id);
let objectUrl = '';

async function loadImage() {
  const image = await api.getPreviewImage();
  if (!image || !image.ok || !image.bytes) {
    $('previewTitle').textContent = '没有可预览的图片';
    return;
  }

  const blob = new Blob([image.bytes], { type: image.type || 'image/png' });
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(blob);

  const img = $('previewImage');
  const name = image.name || '图片预览';
  document.title = name;
  $('previewTitle').textContent = name;
  // 尺寸要等图解码完才有，所以放到 load 里
  img.addEventListener('load', () => {
    $('previewTitle').textContent = `${name} · ${img.naturalWidth}×${img.naturalHeight}`;
  }, { once: true });
  img.src = objectUrl;
}

$('closeBtn').addEventListener('click', () => api.close());
// 点空白处也能关：只有点在图上才不关
$('previewStage').addEventListener('click', (event) => {
  if (event.target === $('previewStage')) api.close();
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') api.close();
});

loadImage();
