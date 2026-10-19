import { createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { finished } from "node:stream/promises";
import { PROFILES, QRSender, prepareFile } from "../src/transfer.js";
import { renderQRToRgba } from "../src/qr.js";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const outputDir = path.resolve("docs");
await mkdir(outputDir, { recursive: true });

const loopbackName = "摄像头回环.txt";
const loopbackText = "通过浏览器摄像头回环收到的文件。\n".repeat(40);
const videoPath = path.join(tmpdir(), `qrdrop-loopback-${process.pid}.y4m`);

async function makeLoopbackVideo() {
  const prepared = await prepareFile(
    new File([new TextEncoder().encode(loopbackText)], loopbackName, { type: "text/plain" }),
    PROFILES.stable,
    { compress: true }
  );
  const sender = new QRSender(prepared, PROFILES.stable);
  const stream = createWriteStream(videoPath);
  let size = 0;
  let chroma = null;

  for (let frameIndex = 0; frameIndex < 80; frameIndex++) {
    const frame = sender.nextFrame();
    const image = renderQRToRgba(frame.bytes, PROFILES.stable.qrVersion, 8);
    if (!size) {
      size = image.size;
      chroma = Buffer.alloc((size * size) / 4, 128);
      stream.write(`YUV4MPEG2 W${size} H${size} F30:1 Ip A1:1 C420jpeg\n`);
    }
    if (image.size !== size) throw new Error("Loopback QR frame changed size");
    const luma = Buffer.alloc(size * size);
    for (let pixel = 0; pixel < size * size; pixel++) {
      luma[pixel] = image.rgba[pixel * 4];
    }
    const packet = Buffer.concat([Buffer.from("FRAME\n"), luma, chroma, chroma]);
    await new Promise((resolve, reject) => {
      stream.write(packet, (error) => error ? reject(error) : resolve());
    });
  }
  stream.end();
  await finished(stream);
}

await makeLoopbackVideo();

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-video-capture=${videoPath}`
  ]
});

const errors = [];
try {
  const desktop = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    permissions: ["camera"],
    serviceWorkers: "block"
  });
  const page = await desktop.newPage();
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });

  await page.goto("http://localhost:8000/#send");
  await page.setInputFiles("#fileInput", {
    name: "码渡测试文件.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("码渡动态二维码传输测试。\n".repeat(300), "utf8")
  });
  await page.locator("#startSendBtn").click();
  await page.locator("#qrLive").waitFor({ state: "visible" });
  await page.waitForTimeout(700);
  const qrPixels = await page.evaluate(() => {
    const canvas = document.querySelector("#qrCanvas");
    const context = canvas.getContext("2d");
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const decoded = window.jsQR(image.data, canvas.width, canvas.height, {
      inversionAttempts: "dontInvert"
    });
    return decoded?.binaryData?.length || 0;
  });
  if (!qrPixels) throw new Error("Live canvas QR did not decode");
  await page.locator("#sendStage").screenshot({
    path: path.join(outputDir, "preview-sender-live.png")
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await page.locator("#sendStage").screenshot({
    path: path.join(outputDir, "preview-sender-mobile.png")
  });
  await desktop.close();

  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    permissions: ["camera"],
    serviceWorkers: "block",
    isMobile: true,
    hasTouch: true
  });
  const mobilePage = await mobile.newPage();
  mobilePage.on("pageerror", (error) => errors.push(`mobile pageerror: ${error.message}`));
  mobilePage.on("console", (message) => {
    if (message.type() === "error") errors.push(`mobile console: ${message.text()}`);
  });
  await mobilePage.goto("http://localhost:8000/#receive");
  await mobilePage.locator("#startReceiveBtn").click();
  await mobilePage.locator("#cameraShell.is-live").waitFor({ timeout: 12_000 });
  const camera = await mobilePage.evaluate(() => {
    const video = document.querySelector("#receiveVideo");
    return {
      width: video.videoWidth,
      height: video.videoHeight,
      stream: Boolean(video.srcObject),
      cameraOptions: document.querySelector("#cameraSelect").options.length,
      zoomEnabled: !document.querySelector("#zoomRange").disabled,
      zoomMode: document.querySelector("#zoomModeLabel").textContent
    };
  });
  if (!camera.stream || !camera.width || !camera.height) {
    throw new Error("Fake camera did not start");
  }
  if (!camera.zoomEnabled) throw new Error("Zoom fallback control was not enabled");
  const digitalZoom = await mobilePage.evaluate(() => {
    const range = document.querySelector("#zoomRange");
    range.value = "2";
    range.dispatchEvent(new Event("input", { bubbles: true }));
    return {
      value: range.value,
      cssZoom: document.querySelector("#receiveVideo").style.getPropertyValue("--camera-zoom")
    };
  });
  if (camera.zoomMode.includes("数字") && digitalZoom.cssZoom !== "2") {
    throw new Error("Digital zoom fallback did not update the preview");
  }
  await mobilePage.waitForTimeout(500);
  await mobilePage.screenshot({
    path: path.join(outputDir, "preview-camera-mobile.png"),
    fullPage: true
  });
  await mobile.close();

  const loopback = await browser.newContext({
    viewport: { width: 1280, height: 960 },
    serviceWorkers: "block"
  });
  const receivePage = await loopback.newPage();
  receivePage.on("pageerror", (error) => errors.push(`loopback pageerror: ${error.message}`));
  receivePage.on("console", (message) => {
    if (message.type() === "error") errors.push(`loopback console: ${message.text()}`);
  });
  await receivePage.goto("http://localhost:8000/#receive");
  await receivePage.locator("#startReceiveBtn").click();
  await receivePage.locator("#cameraShell.is-live").waitFor({ timeout: 12_000 });
  await receivePage.locator("#receiveResult").waitFor({ state: "visible", timeout: 30_000 });
  const receivedName = await receivePage.locator("#resultFileName").textContent();
  const receivedHash = await receivePage.locator("#resultHash").textContent();
  if (receivedName !== loopbackName) {
    throw new Error(`Loopback filename mismatch: ${receivedName}`);
  }
  await receivePage.screenshot({
    path: path.join(outputDir, "preview-receive-success.png"),
    fullPage: true
  });
  await loopback.close();

  console.log(JSON.stringify({
    qrBinaryBytes: qrPixels,
    camera: { ...camera, digitalZoom },
    loopback: { receivedName, receivedHash }
  }, null, 2));
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  }
} finally {
  await browser.close();
  await unlink(videoPath).catch(() => {});
}
