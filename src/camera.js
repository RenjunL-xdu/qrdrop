function errorText(error) {
  switch (error?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "摄像头权限被拒绝。请在浏览器站点设置中允许摄像头，然后重试。";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "没有找到可用的摄像头。";
    case "NotReadableError":
    case "TrackStartError":
      return "摄像头正被其他应用占用，请关闭占用它的应用后重试。";
    case "OverconstrainedError":
      return "所选摄像头不支持当前参数，请换一个摄像头。";
    default:
      return error?.message || "无法打开摄像头。";
  }
}

export function getZoomMode(capabilities = {}) {
  const zoom = capabilities.zoom;
  if (zoom && Number.isFinite(zoom.min) && Number.isFinite(zoom.max) && zoom.max > zoom.min) {
    return {
      mode: "native",
      min: zoom.min,
      max: zoom.max,
      step: Number.isFinite(zoom.step) && zoom.step > 0 ? zoom.step : 0.1
    };
  }
  return { mode: "digital", min: 1, max: 3, step: 0.05 };
}

export class CameraController {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.track = null;
    this.capabilities = {};
    this.settings = {};
    this.deviceId = "";
    this.stopping = false;
    this.onEnded = null;
  }

  async start({ deviceId = "", facingMode = "environment" } = {}) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("当前浏览器不支持摄像头访问。请使用最新版 Chrome、Edge 或 Safari。");
    }
    this.stop();

    const videoConstraints = {
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30, max: 60 },
      ...(deviceId
        ? { deviceId: { exact: deviceId } }
        : { facingMode: { ideal: facingMode } })
    };

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: videoConstraints
      });
    } catch (error) {
      if (deviceId) {
        try {
          this.stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
              width: { ideal: 1920 },
              height: { ideal: 1080 },
              frameRate: { ideal: 30, max: 60 },
              facingMode: { ideal: facingMode }
            }
          });
        } catch (fallbackError) {
          throw new Error(errorText(fallbackError));
        }
      } else {
        throw new Error(errorText(error));
      }
    }

    this.track = this.stream.getVideoTracks()[0] || null;
    if (!this.track) {
      this.stop();
      throw new Error("摄像头没有返回视频轨道。");
    }
    this.stopping = false;
    this.track.addEventListener("ended", () => {
      if (!this.stopping) this.onEnded?.(new Error("摄像头连接已断开。"));
    });

    this.video.srcObject = this.stream;
    await new Promise((resolve, reject) => {
      if (this.video.readyState >= 1) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        this.video.removeEventListener("loadedmetadata", onLoaded);
        reject(new Error("摄像头没有返回画面，请重新选择或重新打开页面。"));
      }, 6000);
      const onLoaded = () => {
        clearTimeout(timer);
        resolve();
      };
      this.video.addEventListener("loadedmetadata", onLoaded, { once: true });
    });
    await this.video.play();

    this._readTrackInfo();
    await this._applyContinuousFocus();
    return this.getInfo();
  }

  _readTrackInfo() {
    if (!this.track) return;
    try {
      this.capabilities = this.track.getCapabilities?.() || {};
    } catch {
      this.capabilities = {};
    }
    this.settings = this.track.getSettings?.() || {};
    this.deviceId = this.settings.deviceId || "";
  }

  async _applyContinuousFocus() {
    const focusModes = this.capabilities.focusMode;
    if (!Array.isArray(focusModes) || !focusModes.includes("continuous")) return;
    try {
      await this.track.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
      this.settings = this.track.getSettings?.() || this.settings;
    } catch {
      // Focus control is optional and varies by browser.
    }
  }

  async listCameras() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((device) => device.kind === "videoinput")
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `摄像头 ${index + 1}`
      }));
  }

  getInfo() {
    const zoom = getZoomMode(this.capabilities);
    return {
      deviceId: this.deviceId,
      capabilities: this.capabilities,
      settings: this.settings,
      zoom,
      torch: Boolean(this.capabilities.torch),
      width: this.settings.width || this.video.videoWidth || 0,
      height: this.settings.height || this.video.videoHeight || 0,
      frameRate: this.settings.frameRate || 0
    };
  }

  async setNativeZoom(value) {
    if (!this.track) return;
    const zoom = getZoomMode(this.capabilities);
    if (zoom.mode !== "native") throw new Error("此摄像头没有开放原生变焦");
    const numeric = Math.max(zoom.min, Math.min(zoom.max, Number(value)));
    await this.track.applyConstraints({ advanced: [{ zoom: numeric }] });
    this.settings = this.track.getSettings?.() || this.settings;
  }

  async setTorch(enabled) {
    if (!this.track || !this.capabilities.torch) return false;
    await this.track.applyConstraints({ advanced: [{ torch: Boolean(enabled) }] });
    return Boolean(enabled);
  }

  stop() {
    this.stopping = true;
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
    }
    this.stream = null;
    this.track = null;
    this.capabilities = {};
    this.settings = {};
    this.deviceId = "";
    this.video.pause();
    this.video.srcObject = null;
  }
}
