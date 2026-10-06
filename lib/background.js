'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FILE_NAME = 'background-image.png';
const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const MAX_SAVED_BYTES = 8 * 1024 * 1024;
const MAX_EDGE = 2000;

function backgroundImagePath(userDataPath) {
  return path.join(userDataPath, FILE_NAME);
}

// O_NOFOLLOW so a symlink cannot redirect the read somewhere else.
async function readRegularImage(filePath, limit) {
  const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > limit) {
      throw new Error('图片文件无效或过大');
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function getBackgroundImage(userDataPath) {
  try {
    return await readRegularImage(backgroundImagePath(userDataPath), MAX_SAVED_BYTES);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

// The picked image is copied into userData as a downscaled PNG, so the widget
// keeps working after the original is moved, renamed or deleted — and the
// payload that crosses IPC stays small.
async function importBackgroundImage(sourcePath, userDataPath, nativeImage) {
  const bytes = await readRegularImage(sourcePath, MAX_SOURCE_BYTES);
  let image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) throw new Error('不支持的图片格式');

  const { width, height } = image.getSize();
  if (width <= 0 || height <= 0) throw new Error('图片尺寸无效');
  if (width > MAX_EDGE || height > MAX_EDGE) {
    const scale = Math.min(MAX_EDGE / width, MAX_EDGE / height);
    image = image.resize({
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale))
    });
  }

  const png = image.toPNG();
  if (!png.length || png.length > MAX_SAVED_BYTES) throw new Error('图片转换后仍然过大');

  fs.mkdirSync(userDataPath, { recursive: true });
  const destination = backgroundImagePath(userDataPath);
  const temporary = path.join(userDataPath, `.background-image-${crypto.randomUUID()}.png`);
  try {
    await fs.promises.writeFile(temporary, png, { flag: 'wx', mode: 0o600 });
    await fs.promises.rename(temporary, destination);
  } finally {
    await fs.promises.unlink(temporary).catch((error) => {
      if (error && error.code !== 'ENOENT') throw error;
    });
  }

  // Bytes, not a data URL: Blink silently truncates CSS values set through
  // setProperty() at 2 MiB, which would leave a larger PNG rendering as
  // nothing at all. The renderer turns these bytes into a blob: URL instead.
  return png;
}

async function clearBackgroundImage(userDataPath) {
  try {
    await fs.promises.unlink(backgroundImagePath(userDataPath));
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
  }
}

module.exports = { backgroundImagePath, clearBackgroundImage, getBackgroundImage, importBackgroundImage };
