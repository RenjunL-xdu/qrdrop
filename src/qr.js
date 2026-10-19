import { qrcode } from "../vendor/qrcode.mjs";
import { bytesToBinaryString } from "./protocol.js";

const quietZone = 4;
let scratchCanvas = null;
let scratchContext = null;

export function makeQR(frameBytes, version) {
  const code = qrcode(version, "M");
  code.addData(bytesToBinaryString(frameBytes), "Byte");
  code.make();
  return code;
}

export function qrMatrix(frameBytes, version) {
  const code = makeQR(frameBytes, version);
  const modules = code.getModuleCount();
  const total = modules + quietZone * 2;
  const matrix = new Uint8Array(total * total);
  for (let y = 0; y < modules; y++) {
    for (let x = 0; x < modules; x++) {
      if (code.isDark(y, x)) {
        matrix[(y + quietZone) * total + (x + quietZone)] = 1;
      }
    }
  }
  return { matrix, modules, total, version };
}

export function renderQRToCanvas(canvas, frameBytes, version) {
  const { matrix, modules, total } = qrMatrix(frameBytes, version);
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("浏览器无法创建二维码画布");

  if (!scratchCanvas) {
    scratchCanvas = document.createElement("canvas");
    scratchContext = scratchCanvas.getContext("2d", { alpha: false });
  }
  scratchCanvas.width = total;
  scratchCanvas.height = total;

  const image = scratchContext.createImageData(total, total);
  for (let i = 0; i < matrix.length; i++) {
    const color = matrix[i] ? 12 : 255;
    const offset = i * 4;
    image.data[offset] = color;
    image.data[offset + 1] = color;
    image.data[offset + 2] = color;
    image.data[offset + 3] = 255;
  }
  scratchContext.putImageData(image, 0, 0);

  const scale = Math.max(2, Math.floor(1088 / total));
  canvas.width = total * scale;
  canvas.height = total * scale;
  context.imageSmoothingEnabled = false;
  context.drawImage(scratchCanvas, 0, 0, canvas.width, canvas.height);

  return { modules, total, scale };
}

export function renderQRToRgba(frameBytes, version, scale = 4) {
  const { matrix, total } = qrMatrix(frameBytes, version);
  const size = total * scale;
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dark = matrix[Math.floor(y / scale) * total + Math.floor(x / scale)];
      const offset = (y * size + x) * 4;
      const color = dark ? 0 : 255;
      rgba[offset] = color;
      rgba[offset + 1] = color;
      rgba[offset + 2] = color;
      rgba[offset + 3] = 255;
    }
  }
  return { rgba, size };
}
