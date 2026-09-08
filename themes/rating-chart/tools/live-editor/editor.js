"use strict";

(() => {
  const CANVAS_WIDTH = 3600;
  const CANVAS_HEIGHT = 1800;
  const elements = {
    editor: document.getElementById("css-editor"),
    ruleJump: document.getElementById("rule-jump"),
    save: document.getElementById("save"),
    reload: document.getElementById("reload"),
    saveState: document.getElementById("save-state"),
    cursor: document.getElementById("cursor-position"),
    frame: document.getElementById("preview-frame"),
    viewport: document.getElementById("preview-viewport"),
    stage: document.getElementById("preview-stage"),
    previewState: document.getElementById("preview-state"),
    zoom: document.getElementById("zoom"),
    zoomValue: document.getElementById("zoom-value"),
    fit: document.getElementById("fit"),
    refresh: document.getElementById("refresh-preview"),
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

  function clearRuntimeLayout(documentRoot) {
    const properties = {
      "#player-name": ["left", "width", "max-width", "font-size"],
      ".rating-separator": ["left", "width"],
      ".platinum-values": ["font-size"],
      ".platinum-card .rating-detail": ["font-size"],
      ".platinum-card .title": ["font-size"],
    };
    for (const [selector, names] of Object.entries(properties)) {
      documentRoot.querySelectorAll(selector).forEach((element) => {
        names.forEach((name) => element.style.removeProperty(name));
      });
    }
  }

  function refreshRuntimeLayout() {
    if (!frameReady) return;
    const frameDocument = elements.frame.contentDocument;
    const frameWindow = elements.frame.contentWindow;
    clearRuntimeLayout(frameDocument);
    frameWindow.__FIT_RATING_THEME__?.();
    frameDocument.fonts.ready.then(() => {
      if (!frameReady) return;
      clearRuntimeLayout(frameDocument);
      frameWindow.__FIT_RATING_THEME__?.();
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

  async function prepareFrame() {
    frameReady = false;
    liveStyle = null;
    elements.previewState.textContent = "正在载入……";
    try {
      const frameWindow = elements.frame.contentWindow;
      await waitForThemeReady(frameWindow);
      const frameDocument = elements.frame.contentDocument;
      const themeLink = [...frameDocument.querySelectorAll("link[rel=stylesheet]")]
        .find((link) => link.href.endsWith("/theme.css"));
      if (themeLink) themeLink.disabled = true;
      clearRuntimeLayout(frameDocument);
      liveStyle = frameDocument.createElement("style");
      liveStyle.id = "__live_editor_css__";
      liveStyle.textContent = elements.editor.value;
      frameDocument.head.appendChild(liveStyle);
      frameReady = true;
      refreshRuntimeLayout();
      elements.previewState.textContent = "已同步";
    } catch (error) {
      elements.previewState.textContent = "载入失败";
      showToast(error.message || String(error), true);
    }
  }

  function refreshPreview() {
    frameReady = false;
    elements.frame.src = "/rating-chart/renderer/theme.html?liveEditor=1&t=" + Date.now();
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
    const value = Math.max(10, Math.min(100, Number(percent) || 30));
    const scale = value / 100;
    elements.frame.style.transform = "scale(" + scale + ")";
    elements.stage.style.width = Math.round(CANVAS_WIDTH * scale) + "px";
    elements.stage.style.height = Math.round(CANVAS_HEIGHT * scale) + "px";
    elements.zoom.value = String(Math.round(value));
    elements.zoomValue.textContent = Math.round(value) + "%";
  }

  function fitPreview() {
    const availableWidth = Math.max(360, elements.viewport.clientWidth - 38);
    const availableHeight = Math.max(240, elements.viewport.clientHeight - 38);
    const scale = Math.min(availableWidth / CANVAS_WIDTH, availableHeight / CANVAS_HEIGHT, 1);
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
      showToast("已保存到 B50 / N10 / P50 的 theme.css");
    } catch (error) {
      markDirty();
      showToast(error.message || String(error), true);
    } finally {
      elements.save.disabled = false;
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
  elements.ruleJump.addEventListener("change", jumpToRule);
  elements.save.addEventListener("click", saveCss);
  elements.reload.addEventListener("click", () => loadSavedCss(true).catch((error) => showToast(error.message, true)));
  elements.refresh.addEventListener("click", refreshPreview);
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
