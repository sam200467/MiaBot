"use strict";

(() => {
  let canvasWidth = 1440;
  let canvasHeight = 2981;
  const elements = {
    editor: document.getElementById("css-editor"),
    sample: document.getElementById("sample"),
    ruleJump: document.getElementById("rule-jump"),
    save: document.getElementById("save"),
    reload: document.getElementById("reload"),
    saveState: document.getElementById("save-state"),
    cursor: document.getElementById("cursor-position"),
    frame: document.getElementById("preview-frame"),
    viewport: document.getElementById("preview-viewport"),
    stage: document.getElementById("preview-stage"),
    previewSize: document.getElementById("preview-size"),
    previewState: document.getElementById("preview-state"),
    zoom: document.getElementById("zoom"),
    zoomValue: document.getElementById("zoom-value"),
    fit: document.getElementById("fit"),
    refresh: document.getElementById("refresh-preview"),
    exportPreview: document.getElementById("export-preview"),
    toast: document.getElementById("toast"),
  };

  let savedCss = "";
  let liveStyle = null;
  let frameReady = false;
  let applyFrame = 0;
  let toastTimer = 0;
  let autoFit = true;

  function showToast(message, isError) {
    clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.toggle("error", Boolean(isError));
    elements.toast.classList.add("visible");
    toastTimer = setTimeout(() => elements.toast.classList.remove("visible"), 2800);
  }

  function setSaveState(kind, text) {
    elements.saveState.className = "state " + kind;
    elements.saveState.textContent = text;
  }

  function markDirty() {
    const dirty = elements.editor.value !== savedCss;
    setSaveState(dirty ? "dirty" : "saved", dirty ? "未保存" : "已保存");
  }

  function fitSingleLine(element, minimumSize) {
    let size = Number.parseFloat(getComputedStyle(element).fontSize);
    while (element.scrollWidth > element.clientWidth && size > minimumSize) {
      size -= 0.5;
      element.style.fontSize = size + "px";
    }
  }

  function refreshRuntimeLayout() {
    if (!frameReady) return;
    const frameDocument = elements.frame.contentDocument;
    frameDocument.querySelectorAll(".player-name, .chart-card .title").forEach((element) => {
      element.style.removeProperty("font-size");
    });
    frameDocument.fonts.ready.then(() => {
      if (!frameReady) return;
      const playerName = frameDocument.querySelector(".player-name");
      if (playerName) fitSingleLine(playerName, 18);
      frameDocument.querySelectorAll(".chart-card .title").forEach((element) => fitSingleLine(element, 10));
    });
  }

  function applyCssNow() {
    applyFrame = 0;
    if (!frameReady || !liveStyle) return;
    liveStyle.textContent = elements.editor.value;
    requestAnimationFrame(refreshRuntimeLayout);
  }

  function scheduleApply() {
    if (applyFrame) cancelAnimationFrame(applyFrame);
    applyFrame = requestAnimationFrame(applyCssNow);
  }

  async function waitForThemeReady(frameWindow) {
    const started = Date.now();
    while (Date.now() - started < 30000) {
      if (frameWindow.__THEME_ERROR__) throw new Error(frameWindow.__THEME_ERROR__);
      if (frameWindow.__THEME_READY__) return;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    throw new Error("预览等待超时，请检查图片、字体地址或主题脚本");
  }

  function updateCanvasSize(frameWindow) {
    const data = frameWindow.__THEME_DATA__ || {};
    canvasWidth = Math.max(1, Number(data?.canvas?.width) || 1440);
    canvasHeight = Math.max(1, Number(data?.canvas?.height) || 2981);
    elements.frame.style.width = canvasWidth + "px";
    elements.frame.style.height = canvasHeight + "px";
    elements.previewSize.textContent = canvasWidth + " × " + canvasHeight + " 实时预览";
  }

  async function prepareFrame() {
    frameReady = false;
    liveStyle = null;
    elements.previewState.textContent = "正在载入……";
    try {
      const frameWindow = elements.frame.contentWindow;
      await waitForThemeReady(frameWindow);
      const frameDocument = elements.frame.contentDocument;
      updateCanvasSize(frameWindow);
      const themeLink = [...frameDocument.querySelectorAll("link[rel=stylesheet]")]
        .find((link) => link.href.endsWith("/theme.css"));
      if (themeLink) themeLink.disabled = true;
      liveStyle = frameDocument.createElement("style");
      liveStyle.id = "__live_editor_css__";
      liveStyle.textContent = elements.editor.value;
      frameDocument.head.appendChild(liveStyle);
      frameReady = true;
      refreshRuntimeLayout();
      elements.previewState.textContent = "已同步";
      if (autoFit) fitPreview(); else setZoom(elements.zoom.value);
    } catch (error) {
      elements.previewState.textContent = "载入失败";
      showToast(error.message || String(error), true);
    }
  }

  function refreshPreview() {
    frameReady = false;
    const sample = encodeURIComponent(elements.sample.value);
    elements.frame.src = "/level-score/renderer/theme.html?sample=" + sample + "&liveEditor=1&t=" + Date.now();
  }

  function updateCursorPosition() {
    const before = elements.editor.value.slice(0, elements.editor.selectionStart);
    const lines = before.split("\n");
    elements.cursor.textContent = "第 " + lines.length + " 行，第 " + (lines[lines.length - 1].length + 1) + " 列";
  }

  function jumpToRule() {
    const needle = elements.ruleJump.value;
    if (!needle) return;
    const index = elements.editor.value.indexOf(needle);
    if (index < 0) {
      showToast("没有找到该规则，可能已被重命名", true);
      return;
    }
    elements.editor.focus();
    elements.editor.setSelectionRange(index, index + needle.length);
    const line = elements.editor.value.slice(0, index).split("\n").length;
    const lineHeight = parseFloat(getComputedStyle(elements.editor).lineHeight) || 21;
    elements.editor.scrollTop = Math.max(0, (line - 5) * lineHeight);
    updateCursorPosition();
    elements.ruleJump.value = "";
  }

  function setZoom(percent) {
    const value = Math.max(10, Math.min(100, Number(percent) || 25));
    const scale = value / 100;
    elements.frame.style.transform = "scale(" + scale + ")";
    elements.stage.style.width = Math.round(canvasWidth * scale) + "px";
    elements.stage.style.height = Math.round(canvasHeight * scale) + "px";
    elements.zoom.value = String(Math.round(value));
    elements.zoomValue.textContent = Math.round(value) + "%";
  }

  function fitPreview() {
    const availableWidth = Math.max(240, elements.viewport.clientWidth - 38);
    const availableHeight = Math.max(240, elements.viewport.clientHeight - 38);
    const scale = Math.min(availableWidth / canvasWidth, availableHeight / canvasHeight, 1);
    autoFit = true;
    setZoom(Math.max(10, Math.floor(scale * 100)));
  }

  async function loadSavedCss(showMessage) {
    const response = await fetch("/api/css", { cache: "no-store" });
    if (!response.ok) throw new Error("读取 theme.css 失败");
    savedCss = await response.text();
    elements.editor.value = savedCss;
    markDirty();
    updateCursorPosition();
    scheduleApply();
    if (showMessage) showToast("已恢复磁盘中的 theme.css");
  }

  async function saveCss() {
    elements.save.disabled = true;
    setSaveState("saving", "保存中");
    try {
      const response = await fetch("/api/css", {
        method: "POST",
        headers: { "Content-Type": "text/css; charset=utf-8" },
        body: elements.editor.value,
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "保存失败");
      savedCss = elements.editor.value;
      markDirty();
      showToast("已保存到 level-score/renderer/theme.css");
    } catch (error) {
      markDirty();
      showToast(error.message || String(error), true);
    } finally {
      elements.save.disabled = false;
    }
  }

  async function exportPreview() {
    elements.exportPreview.disabled = true;
    elements.previewState.textContent = "正在导出……";
    try {
      const sample = encodeURIComponent(elements.sample.value);
      const response = await fetch("/api/screenshot?sample=" + sample, {
        method: "POST",
        headers: { "Content-Type": "text/css; charset=utf-8" },
        body: elements.editor.value,
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || "PNG 导出失败");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "level-score-" + elements.sample.value + "-preview.png";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      showToast("当前预览已导出为 PNG");
    } catch (error) {
      showToast(error.message || String(error), true);
    } finally {
      elements.exportPreview.disabled = false;
      elements.previewState.textContent = frameReady ? "已同步" : "未载入";
    }
  }

  elements.editor.addEventListener("input", () => {
    markDirty();
    updateCursorPosition();
    scheduleApply();
  });
  elements.editor.addEventListener("click", updateCursorPosition);
  elements.editor.addEventListener("keyup", updateCursorPosition);
  elements.editor.addEventListener("keydown", (event) => {
    if (event.key === "Tab") {
      event.preventDefault();
      const start = elements.editor.selectionStart;
      const end = elements.editor.selectionEnd;
      elements.editor.setRangeText("  ", start, end, "end");
      elements.editor.dispatchEvent(new Event("input"));
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      saveCss();
    }
  });

  elements.frame.addEventListener("load", prepareFrame);
  elements.sample.addEventListener("change", refreshPreview);
  elements.ruleJump.addEventListener("change", jumpToRule);
  elements.save.addEventListener("click", saveCss);
  elements.reload.addEventListener("click", () => loadSavedCss(true).catch((error) => showToast(error.message, true)));
  elements.refresh.addEventListener("click", refreshPreview);
  elements.exportPreview.addEventListener("click", exportPreview);
  elements.fit.addEventListener("click", fitPreview);
  elements.zoom.addEventListener("input", () => {
    autoFit = false;
    setZoom(elements.zoom.value);
  });
  window.addEventListener("resize", () => {
    if (autoFit) fitPreview();
  });
  window.addEventListener("beforeunload", (event) => {
    if (elements.editor.value === savedCss) return;
    event.preventDefault();
    event.returnValue = "";
  });

  loadSavedCss(false)
    .then(() => {
      refreshPreview();
      requestAnimationFrame(fitPreview);
    })
    .catch((error) => {
      setSaveState("dirty", "读取失败");
      showToast(error.message || String(error), true);
    });
})();
