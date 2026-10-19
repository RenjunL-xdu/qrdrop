import { CameraController, getZoomMode } from "./camera.js";
import { renderQRToCanvas } from "./qr.js";
import {
  MAX_FILE_BYTES,
  PROFILES,
  PasswordRequiredError,
  QRReceiver,
  QRSender,
  WrongPasswordError,
  formatBytes,
  prepareFile
} from "./transfer.js";

const $ = (id) => document.getElementById(id);
const views = ["send", "receive", "help"];
const viewButtons = [...document.querySelectorAll("[data-view]")];
const viewPanels = [...document.querySelectorAll("[data-view-panel]")];

const state = {
  view: "send",
  file: null,
  profile: "stable",
  preparing: false,
  sender: null,
  isSending: false,
  senderPaused: false,
  sendRaf: 0,
  lastQrDraw: 0,
  drawStamps: [],
  drawCount: 0,
  wakeLock: null,
  camera: null,
  cameraInfo: null,
  cameras: [],
  scanning: false,
  scanRaf: 0,
  lastScan: 0,
  scanCanvas: document.createElement("canvas"),
  scanContext: null,
  scanCount: 0,
  detectCount: 0,
  statsAt: 0,
  digitalZoom: 1,
  receiver: null,
  receiveStartedAt: 0,
  lastSessionId: null,
  objectUrl: "",
  receivedFile: null,
  unlockBusy: false,
  frameBadgeTimer: 0,
  toastTimer: 0
};

state.scanContext = state.scanCanvas.getContext("2d", {
  alpha: false,
  willReadFrequently: true
});

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 3000);
}

function showSendError(message = "") {
  const box = $("sendError");
  box.textContent = message;
  box.hidden = !message;
}

function showReceiveError(message = "") {
  const box = $("receiveError");
  box.textContent = message;
  box.hidden = !message;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes} 分 ${rest} 秒`;
}

function extensionLabel(name) {
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return "FILE";
  return name.slice(dot + 1, dot + 5).toUpperCase();
}

function setView(name, { fromHash = false } = {}) {
  if (!views.includes(name)) name = "send";
  const previous = state.view;
  state.view = name;

  if (previous === "receive" && name !== "receive" && state.camera?.stream) {
    stopReceiveCamera();
  }
  if (previous === "send" && name !== "send" && state.isSending && !state.senderPaused) {
    setSenderPaused(true);
  }

  viewButtons.forEach((button) => {
    const active = button.dataset.view === name;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });
  viewPanels.forEach((panel) => {
    const active = panel.dataset.viewPanel === name;
    panel.hidden = !active;
    panel.classList.toggle("is-active", active);
  });

  if (!fromHash && location.hash !== `#${name}`) {
    history.replaceState(null, "", `#${name}`);
  }
  window.scrollTo({ top: 0, behavior: "auto" });
}

viewButtons.forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.view));
});

window.addEventListener("hashchange", () => {
  setView(location.hash.slice(1) || "send", { fromHash: true });
});

function storedProfile() {
  try {
    const value = localStorage.getItem("qrdrop.profile");
    if (value && PROFILES[value]) return value;
  } catch {
    // Storage can be disabled in private browsing.
  }
  return window.matchMedia("(max-width: 760px)").matches ? "stable" : "balanced";
}

function selectProfile(profileId, persist = true) {
  if (!PROFILES[profileId]) return;
  state.profile = profileId;
  document.querySelectorAll("[data-profile]").forEach((button) => {
    const active = button.dataset.profile === profileId;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  const profile = PROFILES[profileId];
  const rate = formatBytes(Math.round(profile.blockSize * profile.fps * (1 - 3 / 16)));
  $("profileNote").textContent = `${profile.note}。理论有效载荷约 ${rate}/s。`;
  if (persist) {
    try {
      localStorage.setItem("qrdrop.profile", profileId);
    } catch {
      // Optional preference.
    }
  }
}

document.querySelectorAll("[data-profile]").forEach((button) => {
  button.addEventListener("click", () => selectProfile(button.dataset.profile));
});

function updateStartButton() {
  $("startSendBtn").disabled = !state.file || state.preparing || state.isSending;
}

function setFile(file) {
  if (!file) return;
  if (file.size > MAX_FILE_BYTES) {
    showSendError(`文件超过了 ${formatBytes(MAX_FILE_BYTES)} 的单文件上限。`);
    return;
  }
  showSendError();
  state.file = file;
  $("dropZone").classList.add("has-file");
  $("fileName").textContent = file.name;
  $("fileMeta").textContent = `${formatBytes(file.size)} · ${file.type || "未知类型"} · 本地处理`;
  $("dropButton").textContent = "更换";
  updateStartButton();
}

$("fileInput").addEventListener("change", (event) => {
  setFile(event.target.files?.[0]);
});

const dropZone = $("dropZone");
for (const eventName of ["dragenter", "dragover"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("is-dragging");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("is-dragging");
  });
}
dropZone.addEventListener("drop", (event) => {
  setFile(event.dataTransfer?.files?.[0]);
});

$("passwordToggle").addEventListener("change", (event) => {
  $("sendPasswordWrap").hidden = !event.target.checked;
  if (event.target.checked) $("sendPassword").focus();
  else $("sendPassword").value = "";
  showSendError();
});

async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
    state.wakeLock.addEventListener("release", () => {
      state.wakeLock = null;
    });
  } catch {
    state.wakeLock = null;
  }
}

async function releaseWakeLock() {
  try {
    await state.wakeLock?.release();
  } catch {
    // Wake Lock is best-effort.
  }
  state.wakeLock = null;
}

function renderNextSenderFrame() {
  if (!state.sender) return;
  const frame = state.sender.nextFrame();
  renderQRToCanvas($("qrCanvas"), frame.bytes, state.sender.profile.qrVersion);
  state.drawCount++;
  $("liveFrames").textContent = String(state.drawCount);

  const now = performance.now();
  state.drawStamps.push(now);
  while (state.drawStamps.length && now - state.drawStamps[0] > 2200) state.drawStamps.shift();
  if (state.drawStamps.length > 2) {
    const elapsed = (state.drawStamps.at(-1) - state.drawStamps[0]) / 1000;
    const fps = (state.drawStamps.length - 1) / Math.max(0.001, elapsed);
    $("liveFps").textContent = `${fps.toFixed(1)} fps`;
  }
}

function senderLoop(timestamp) {
  if (!state.isSending || state.senderPaused) return;
  const interval = 1000 / state.sender.profile.fps;
  if (!state.lastQrDraw || timestamp - state.lastQrDraw >= interval * 0.92) {
    state.lastQrDraw = timestamp;
    try {
      renderNextSenderFrame();
    } catch (error) {
      stopSending();
      showSendError(error.message || "无法生成二维码。");
      return;
    }
  }
  state.sendRaf = requestAnimationFrame(senderLoop);
}

function setSenderPaused(paused) {
  if (!state.isSending || state.senderPaused === paused) return;
  state.senderPaused = paused;
  $("qrPaused").hidden = !paused;
  $("pauseSendBtn").textContent = paused ? "继续" : "暂停";
  if (paused) {
    cancelAnimationFrame(state.sendRaf);
    state.sendRaf = 0;
  } else {
    state.lastQrDraw = 0;
    state.sendRaf = requestAnimationFrame(senderLoop);
  }
}

async function startSending() {
  if (!state.file || state.preparing || state.isSending) return;
  const enabledPassword = $("passwordToggle").checked;
  const password = $("sendPassword").value;
  if (enabledPassword && Array.from(password).length < 4) {
    showSendError("密码至少需要 4 个字符。");
    $("sendPassword").focus();
    return;
  }

  state.preparing = true;
  updateStartButton();
  showSendError();
  const button = $("startSendBtn");
  const buttonText = button.querySelector("span");
  buttonText.textContent = "正在压缩并计算校验…";

  try {
    const profile = PROFILES[state.profile];
    const prepared = await prepareFile(state.file, profile, {
      compress: $("compressToggle").checked,
      password: enabledPassword ? password : ""
    });
    state.sender = new QRSender(prepared, profile);
    state.isSending = true;
    state.senderPaused = false;
    state.lastQrDraw = 0;
    state.drawStamps = [];
    state.drawCount = 0;

    $("liveFileName").textContent = `${prepared.name}${prepared.encrypted ? " · 已加密" : ""}`;
    $("liveProfile").textContent = `${profile.label} · QR v${profile.qrVersion}`;
    $("liveRate").textContent = `${formatBytes(Math.round(state.sender.estimatedBytesPerSecond))}/s`;
    $("liveSession").textContent = prepared.sessionId.toString(16).toUpperCase().padStart(8, "0");
    $("liveFrames").textContent = "0";
    $("liveFps").textContent = "—";
    $("qrIdle").hidden = true;
    $("qrLive").hidden = false;
    $("qrPaused").hidden = true;
    $("pauseSendBtn").textContent = "暂停";
    document.body.classList.add("is-sending");
    renderNextSenderFrame();
    state.sendRaf = requestAnimationFrame(senderLoop);
    requestWakeLock();
    $("sendStage").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    if (state.isSending) stopSending();
    showSendError(error.message || "准备文件失败。");
  } finally {
    state.preparing = false;
    buttonText.textContent = "生成二维码";
    updateStartButton();
  }
}

function stopSending() {
  cancelAnimationFrame(state.sendRaf);
  state.sendRaf = 0;
  state.isSending = false;
  state.senderPaused = false;
  state.sender = null;
  state.lastQrDraw = 0;
  state.drawStamps = [];
  releaseWakeLock();
  document.body.classList.remove("is-sending", "cinema");
  $("qrLive").hidden = true;
  $("qrIdle").hidden = false;
  $("qrPaused").hidden = true;
  $("cinemaBtn").textContent = "放大二维码";
  updateStartButton();
}

$("startSendBtn").addEventListener("click", startSending);
$("pauseSendBtn").addEventListener("click", () => setSenderPaused(!state.senderPaused));
$("stopSendBtn").addEventListener("click", stopSending);

function toggleCinema() {
  const enabled = !document.body.classList.contains("cinema");
  document.body.classList.toggle("cinema", enabled);
  $("cinemaBtn").textContent = enabled ? "退出放大" : "放大二维码";
  if (!enabled) $("sendStage").scrollIntoView({ behavior: "smooth", block: "start" });
}

$("cinemaBtn").addEventListener("click", toggleCinema);
$("qrCanvas").addEventListener("click", () => {
  if (state.isSending) toggleCinema();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.body.classList.contains("cinema")) {
    document.body.classList.remove("cinema");
    $("cinemaBtn").textContent = "放大二维码";
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.isSending && !state.senderPaused) {
    state.lastQrDraw = 0;
  }
});

function updateFrameBadge() {
  const badge = $("lastFrameBadge");
  badge.hidden = false;
  clearTimeout(state.frameBadgeTimer);
  state.frameBadgeTimer = setTimeout(() => {
    badge.hidden = true;
  }, 850);
}

function updateScanStats(force = false) {
  const now = performance.now();
  if (!force && now - state.statsAt < 900) return;
  const seconds = state.statsAt ? Math.max(0.2, (now - state.statsAt) / 1000) : 1;
  const rate = state.scanCount / seconds;
  $("scanRate").textContent = state.scanCount ? `${rate.toFixed(1)} 帧/s` : "—";
  state.scanCount = 0;
  state.statsAt = now;

  if (state.receiveStartedAt) {
    $("receiveElapsed").textContent = formatDuration((now - state.receiveStartedAt) / 1000);
  }
}

function scanFrame() {
  if (!state.scanning || !state.receiver || !state.camera?.stream) return;
  const video = $("receiveVideo");
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
  if (!window.jsQR) {
    showReceiveError("二维码解码库没有加载。请刷新页面后重试。");
    stopReceiveCamera();
    return;
  }

  const zoom = state.cameraInfo?.zoom?.mode === "native" ? 1 : state.digitalZoom;
  const sourceWidth = video.videoWidth / zoom;
  const sourceHeight = video.videoHeight / zoom;
  const sourceX = (video.videoWidth - sourceWidth) / 2;
  const sourceY = (video.videoHeight - sourceHeight) / 2;
  const maxSide = 1152;
  const ratio = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * ratio));
  const height = Math.max(1, Math.round(sourceHeight * ratio));

  if (state.scanCanvas.width !== width || state.scanCanvas.height !== height) {
    state.scanCanvas.width = width;
    state.scanCanvas.height = height;
  }
  state.scanContext.drawImage(
    video,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    width,
    height
  );

  const image = state.scanContext.getImageData(0, 0, width, height);
  const result = window.jsQR(image.data, width, height, {
    inversionAttempts: "dontInvert"
  });
  state.scanCount++;

  if (result?.binaryData?.length) {
    state.detectCount++;
    updateFrameBadge();
    try {
      const ingestResult = state.receiver.ingest(result.binaryData);
      if (ingestResult === "invalid" || ingestResult === "invalid-metadata") {
        $("cameraHint").textContent = "识别到二维码，但协议或校验值不匹配";
      } else {
        $("cameraHint").textContent = "已锁定二维码 · 保持画面稳定";
      }
    } catch (error) {
      showReceiveError(error.message || "读取二维码时发生错误。");
    }
  }
}

function scanLoop(timestamp) {
  if (!state.scanning) return;
  if (timestamp - state.lastScan >= 86) {
    state.lastScan = timestamp;
    try {
      scanFrame();
    } catch (error) {
      showReceiveError(error.message || "扫描画面时发生错误。");
    }
    updateScanStats();
  }
  state.scanRaf = requestAnimationFrame(scanLoop);
}

function startScanLoop() {
  cancelAnimationFrame(state.scanRaf);
  state.scanning = true;
  state.lastScan = 0;
  state.scanCount = 0;
  state.statsAt = performance.now();
  $("cameraShell").classList.add("is-scanning");
  $("scanOverlay").hidden = false;
  state.scanRaf = requestAnimationFrame(scanLoop);
}

function stopScanLoop({ keepCamera = true } = {}) {
  state.scanning = false;
  cancelAnimationFrame(state.scanRaf);
  state.scanRaf = 0;
  $("cameraShell").classList.remove("is-scanning");
  $("scanOverlay").hidden = true;
  if (!keepCamera) stopReceiveCamera();
}

function setCameraControlsEnabled(enabled) {
  $("cameraSelect").disabled = !enabled || state.cameras.length === 0;
  $("swapCameraBtn").disabled = !enabled || state.cameras.length < 2;
  $("resetZoomBtn").disabled = !enabled;
}

async function populateCameraList(activeDeviceId) {
  try {
    state.cameras = await state.camera.listCameras();
  } catch {
    state.cameras = [];
  }
  const select = $("cameraSelect");
  select.innerHTML = "";
  if (!state.cameras.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "默认摄像头";
    select.append(option);
    setCameraControlsEnabled(Boolean(state.camera?.stream));
    return;
  }

  state.cameras.forEach((camera, index) => {
    const option = document.createElement("option");
    option.value = camera.deviceId;
    option.textContent = camera.label || `摄像头 ${index + 1}`;
    select.append(option);
  });
  if (activeDeviceId && state.cameras.some((camera) => camera.deviceId === activeDeviceId)) {
    select.value = activeDeviceId;
  }
  setCameraControlsEnabled(true);
}

function updateZoomProgress(value) {
  const range = $("zoomRange");
  const min = Number(range.min);
  const max = Number(range.max);
  const percent = max > min ? ((value - min) / (max - min)) * 100 : 0;
  range.style.setProperty("--zoom-progress", `${percent}%`);
}

function useDigitalZoomFallback(message = "") {
  const range = $("zoomRange");
  range.min = "1";
  range.max = "3";
  range.step = "0.05";
  range.value = String(state.digitalZoom);
  $("zoomModeLabel").textContent = message || "镜头未开放硬件变焦 · 数字裁切";
  updateZoomProgress(Number(range.value));
  $("zoomValue").textContent = `${Number(range.value).toFixed(1)}×`;
  $("resetZoomBtn").disabled = false;
}

function updateCameraTools(info) {
  state.cameraInfo = info;
  const zoom = info?.zoom || getZoomMode({});
  const range = $("zoomRange");
  $("torchBtn").hidden = !info?.torch;
  $("torchBtn").classList.remove("is-on");
  $("torchBtn").setAttribute("aria-label", "打开补光灯");

  if (zoom.mode === "native") {
    const current = Number(info.settings?.zoom ?? zoom.min);
    range.min = String(zoom.min);
    range.max = String(zoom.max);
    range.step = String(zoom.step);
    range.value = String(current);
    $("zoomModeLabel").textContent = "镜头硬件变焦";
    $("zoomValue").textContent = `${current.toFixed(1)}×`;
    $("resetZoomBtn").disabled = false;
    $("receiveVideo").style.setProperty("--camera-zoom", "1");
    state.digitalZoom = 1;
  } else {
    useDigitalZoomFallback("此镜头未开放变焦 · 数字裁切放大");
    $("receiveVideo").style.setProperty("--camera-zoom", String(state.digitalZoom));
  }
  range.disabled = false;
  updateZoomProgress(Number(range.value));

  const height = info?.height || 0;
  const fps = info?.frameRate || 0;
  if (height) {
    const label = height >= 1000 ? "1080p" : height >= 700 ? "720p" : `${height}p`;
    $("cameraResolution").textContent = `${label}${fps ? ` · ${Math.round(fps)} fps` : ""}`;
  } else {
    $("cameraResolution").textContent = "摄像头已开启";
  }
}

function updateReceiveButtonState() {
  const live = Boolean(state.camera?.stream);
  const startButton = $("startReceiveBtn");
  const toggle = $("receiveToggleBtn");
  if (live) {
    $("cameraPlaceholderTitle").textContent = "打开摄像头开始接收";
    $("cameraPlaceholderHint").textContent = "浏览器会请求一次摄像头权限";
    startButton.hidden = true;
    toggle.hidden = false;
    toggle.textContent = "停止摄像头";
  } else if (state.receiver?.ready) {
    $("cameraPlaceholderTitle").textContent = "文件已完整接收";
    $("cameraPlaceholderHint").textContent = "摄像头已关闭，文件可以保存或分享";
    $("cameraStatus").classList.add("is-live");
    $("cameraStatus").innerHTML = "<i></i> 接收完成";
    startButton.hidden = true;
    toggle.hidden = true;
  } else {
    $("cameraPlaceholderTitle").textContent = "打开摄像头开始接收";
    $("cameraPlaceholderHint").textContent = "浏览器会请求一次摄像头权限";
    startButton.hidden = false;
    startButton.textContent = state.receiver?.metadata ? "继续扫描" : "开启摄像头";
    toggle.hidden = true;
  }
}

async function startReceiveCamera(deviceId = "") {
  showReceiveError();
  if (!window.isSecureContext) {
    showReceiveError("摄像头访问要求 HTTPS。请使用 GitHub Pages 等 HTTPS 地址，或在本机 localhost 打开。");
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    showReceiveError("当前浏览器不支持摄像头访问，请使用最新版 Chrome、Edge 或 Safari。");
    return;
  }

  $("startReceiveBtn").disabled = true;
  $("startReceiveBtn").textContent = "正在请求权限…";
  try {
    if (!state.receiver) createReceiver();
    if (!state.camera) {
      state.camera = new CameraController($("receiveVideo"));
      state.camera.onEnded = (error) => {
        showReceiveError(error.message);
        stopReceiveCamera();
      };
    }
    const info = await state.camera.start({ deviceId });
    $("cameraShell").classList.add("is-live");
    $("cameraStatus").classList.add("is-live");
    $("cameraStatus").innerHTML = "<i></i> 实时扫描";
    $("cameraHint").textContent = "将动态二维码完整放入取景框";
    updateCameraTools(info);
    await populateCameraList(info.deviceId);
    updateReceiveButtonState();
    $("resetReceiverBtn").disabled = false;
    if (!state.receiveStartedAt) {
      $("receiveElapsed").textContent = "0 秒";
    }
    startScanLoop();
    requestWakeLock();
    showReceiveError();
  } catch (error) {
    state.camera?.stop();
    $("cameraShell").classList.remove("is-live", "is-scanning");
    $("cameraStatus").classList.remove("is-live");
    $("cameraStatus").innerHTML = "<i></i> 摄像头未开启";
    showReceiveError(error.message || "无法打开摄像头。");
    updateReceiveButtonState();
  } finally {
    $("startReceiveBtn").disabled = false;
  }
}

function stopReceiveCamera() {
  stopScanLoop({ keepCamera: true });
  state.camera?.stop();
  releaseWakeLock();
  $("cameraShell").classList.remove("is-live", "is-scanning");
  $("cameraStatus").classList.remove("is-live");
  $("cameraStatus").innerHTML = "<i></i> 摄像头未开启";
  $("cameraResolution").textContent = "等待摄像头";
  $("receiveVideo").style.setProperty("--camera-zoom", "1");
  state.digitalZoom = 1;
  $("zoomRange").disabled = true;
  $("zoomRange").value = "1";
  $("zoomValue").textContent = "1.0×";
  $("zoomModeLabel").textContent = "等待摄像头能力检测";
  $("lastFrameBadge").hidden = true;
  setCameraControlsEnabled(false);
  updateReceiveButtonState();
}

function createReceiver() {
  state.receiver = new QRReceiver({
    onSession: handleReceiveSession,
    onProgress: handleReceiveProgress,
    onReady: handleReceiveReady,
    onError: (error) => showReceiveError(error.message || "二维码内容无效。")
  });
}

function handleReceiveSession({ sessionId, metadata }) {
  const switched = state.lastSessionId !== null && state.lastSessionId !== sessionId;
  if (switched) showToast("已切换到新的发送会话");
  state.lastSessionId = sessionId;
  state.receiveStartedAt = performance.now();
  if (state.objectUrl) {
    URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = "";
  }
  state.receivedFile = null;
  $("receiveResult").hidden = true;
  $("receivePasswordPanel").hidden = !metadata.encrypted;
  $("receivePassword").value = "";
  $("receiveHeadline").textContent = "正在接收文件";
  $("receiveBadge").textContent = metadata.encrypted ? "已加密" : "接收中";
  $("receiveFileType").textContent = extensionLabel(metadata.name);
  $("receiveFileName").textContent = metadata.name;
  $("receiveFileMeta").textContent = `${formatBytes(metadata.originalSize)} · ${metadata.mime || "未知类型"}${metadata.compressed ? " · 已压缩" : ""}`;
  $("receivePhase").textContent = "已识别文件，正在收集数据块";
  $("receivePercent").textContent = "0%";
  $("receiveProgressBar").style.width = "0%";
  $("recoveredBlocks").textContent = "0 / 0";
  $("receivedFrames").textContent = "0";
  $("cameraHint").textContent = "已锁定二维码 · 保持画面稳定";
}

function handleReceiveProgress(progress) {
  if (!progress?.metadata) return;
  const percent = Math.min(99, Math.floor(progress.progress * 100));
  $("receivePercent").textContent = `${percent}%`;
  $("receiveProgressBar").style.width = `${percent}%`;
  $("recoveredBlocks").textContent = `${progress.recoveredBlocks} / ${progress.totalBlocks}`;
  $("receivedFrames").textContent = String(progress.receivedFrames);
  $("receivePhase").textContent = progress.progress > 0
    ? `正在补齐文件 · ${progress.chunksDone}/${progress.chunks} 个分片`
    : "正在建立分片";
}

function handleReceiveReady(metadata) {
  stopScanLoop({ keepCamera: true });
  $("cameraStatus").classList.remove("is-live");
  $("cameraStatus").innerHTML = "<i></i> 数据已收齐";
  $("receivePercent").textContent = "100%";
  $("receiveProgressBar").style.width = "100%";
  $("receiveBadge").textContent = "待校验";
  $("receiveHeadline").textContent = metadata.encrypted ? "输入密码完成接收" : "正在校验文件";
  $("receivePhase").textContent = metadata.encrypted
    ? "加密数据已全部收齐，等待解密"
    : "数据块已收齐，正在还原并校验";
  if (metadata.encrypted) {
    $("receivePasswordPanel").hidden = false;
    $("receivePassword").focus();
  } else {
    finalizeReceive("");
  }
}

async function finalizeReceive(password = "") {
  if (!state.receiver || state.unlockBusy) return;
  state.unlockBusy = true;
  $("unlockBtn").disabled = true;
  $("unlockBtn").textContent = "校验中…";
  showReceiveError();
  try {
    const result = await state.receiver.finalize(password);
    stopReceiveCamera();
    showReceiveResult(result);
  } catch (error) {
    if (error instanceof PasswordRequiredError) {
      $("receivePasswordPanel").hidden = false;
      $("receivePassword").focus();
      showReceiveError(error.message);
    } else if (error instanceof WrongPasswordError) {
      showReceiveError(error.message);
      $("receivePassword").select();
    } else {
      showReceiveError(error.message || "文件还原失败。");
    }
  } finally {
    state.unlockBusy = false;
    $("unlockBtn").disabled = false;
    $("unlockBtn").textContent = "解密文件";
  }
}

function showReceiveResult(result) {
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = URL.createObjectURL(result.blob);
  state.receivedFile = new File([result.blob], result.name, {
    type: result.mime || "application/octet-stream"
  });
  $("saveFileLink").href = state.objectUrl;
  $("saveFileLink").download = result.name;
  $("resultFileName").textContent = result.name;
  $("resultMeta").textContent = `${formatBytes(result.size)} · SHA-256 校验通过`;
  $("resultHash").textContent = `SHA-256 ${result.hash}`;
  $("receiveHeadline").textContent = "接收完成";
  $("receiveBadge").textContent = "已校验";
  $("receivePhase").textContent = "文件已完整还原并通过校验";
  $("receiveResult").hidden = false;
  $("receivePasswordPanel").hidden = true;
  $("cameraHint").textContent = "接收完成";
  $("shareFileBtn").hidden = !canShareFile();
  $("receiveResult").scrollIntoView({ behavior: "smooth", block: "nearest" });
  requestWakeLockReleaseForReceiver();
}

function requestWakeLockReleaseForReceiver() {
  if (state.wakeLock) releaseWakeLock();
}

function canShareFile() {
  return Boolean(
    state.receivedFile &&
    navigator.share &&
    navigator.canShare?.({ files: [state.receivedFile] })
  );
}

async function shareReceivedFile() {
  if (!state.receivedFile) return;
  try {
    await navigator.share({
      files: [state.receivedFile],
      title: state.receivedFile.name
    });
  } catch (error) {
    if (error?.name !== "AbortError") showToast("系统分享没有完成，可以改用“保存文件”。");
  }
}

function resetReceiveUi() {
  $("receiveHeadline").textContent = "等待二维码";
  $("receiveBadge").textContent = "扫描中";
  $("receiveFileType").textContent = "FILE";
  $("receiveFileName").textContent = "还没有识别到文件";
  $("receiveFileMeta").textContent = "把二维码放进取景框，第一帧识别后这里会显示文件信息。";
  $("receivePhase").textContent = "正在寻找二维码";
  $("receivePercent").textContent = "0%";
  $("receiveProgressBar").style.width = "0%";
  $("recoveredBlocks").textContent = "0 / 0";
  $("receivedFrames").textContent = "0";
  $("scanRate").textContent = "—";
  $("receiveElapsed").textContent = "0 秒";
  $("receivePasswordPanel").hidden = true;
  $("receivePassword").value = "";
  $("receiveResult").hidden = true;
  $("cameraHint").textContent = "将动态二维码完整放入取景框";
  $("lastFrameBadge").hidden = true;
  showReceiveError();
}

function resetReceiver(restart = false) {
  const previousDevice = $("cameraSelect").value;
  stopReceiveCamera();
  if (state.objectUrl) {
    URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = "";
  }
  state.receivedFile = null;
  state.receiver = null;
  state.receiveStartedAt = 0;
  state.lastSessionId = null;
  state.detectCount = 0;
  createReceiver();
  resetReceiveUi();
  if (restart) startReceiveCamera(previousDevice);
}

$("startReceiveBtn").addEventListener("click", () => startReceiveCamera());
$("receiveToggleBtn").addEventListener("click", () => {
  if (state.camera?.stream) stopReceiveCamera();
  else startReceiveCamera($("cameraSelect").value);
});
$("resetReceiverBtn").addEventListener("click", () => resetReceiver(true));
$("receiveAgainBtn").addEventListener("click", () => resetReceiver(true));
$("shareFileBtn").addEventListener("click", shareReceivedFile);

$("receivePasswordForm").addEventListener("submit", (event) => {
  event.preventDefault();
  finalizeReceive($("receivePassword").value);
});

$("cameraSelect").addEventListener("change", async (event) => {
  if (!state.camera?.stream) return;
  stopScanLoop({ keepCamera: true });
  const deviceId = event.target.value;
  try {
    await startReceiveCamera(deviceId);
  } catch {
    showReceiveError("切换摄像头失败，请重新选择。");
  }
});

$("swapCameraBtn").addEventListener("click", () => {
  if (state.cameras.length < 2) {
    showToast("这个设备只检测到一个摄像头。");
    return;
  }
  const current = $("cameraSelect").value;
  const index = state.cameras.findIndex((camera) => camera.deviceId === current);
  const next = state.cameras[(index + 1) % state.cameras.length];
  startReceiveCamera(next.deviceId);
});

let zoomApplyTimer = 0;
$("zoomRange").addEventListener("input", (event) => {
  const value = Number(event.target.value);
  $("zoomValue").textContent = `${value.toFixed(1)}×`;
  updateZoomProgress(value);
  if (state.cameraInfo?.zoom?.mode === "native") {
    clearTimeout(zoomApplyTimer);
    zoomApplyTimer = setTimeout(async () => {
      try {
        await state.camera.setNativeZoom(value);
      } catch {
        state.cameraInfo.zoom = getZoomMode({});
        useDigitalZoomFallback("硬件变焦失败 · 已切换为数字裁切");
      }
    }, 45);
  } else {
    state.digitalZoom = value;
    $("receiveVideo").style.setProperty("--camera-zoom", String(value));
  }
});

$("resetZoomBtn").addEventListener("click", () => {
  const range = $("zoomRange");
  range.value = range.min;
  range.dispatchEvent(new Event("input", { bubbles: true }));
});

$("torchBtn").addEventListener("click", async () => {
  const enabled = !$("torchBtn").classList.contains("is-on");
  try {
    await state.camera.setTorch(enabled);
    $("torchBtn").classList.toggle("is-on", enabled);
    $("torchBtn").setAttribute("aria-label", enabled ? "关闭补光灯" : "打开补光灯");
  } catch {
    showToast("这个摄像头暂时无法控制补光灯。");
  }
});

window.addEventListener("pagehide", () => {
  cancelAnimationFrame(state.sendRaf);
  cancelAnimationFrame(state.scanRaf);
  state.camera?.stop();
  releaseWakeLock();
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
});

selectProfile(storedProfile(), false);
setView(views.includes(location.hash.slice(1)) ? location.hash.slice(1) : "send", {
  fromHash: true
});
updateStartButton();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      // Offline support is optional; the transfer still works while online.
    });
  });
}
