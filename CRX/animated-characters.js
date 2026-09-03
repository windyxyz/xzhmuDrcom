"use strict";

/* 动画角色引擎 —— 1:1 移植自 TEMP/登录界面/animated-characters-login-page-main（Vue 版）。
   portal 认证页 / welcome / preview 共用；reduced-motion 下全部演出静止。 */

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.DrcomCharacters = api;
})(typeof globalThis === "object" ? globalThis : this, () => {
  const CONFETTI_COLORS = ["#FF6B6B", "#4ECDC4", "#FFE66D", "#A78BFA", "#FF9B6B", "#6BCB77", "#4D96FF"];
  const STAGE_WIDTH = 550;
  const STAGE_HEIGHT = 400;

  /* 与 Vue 版一致的角色几何与面部活动范围 */
  const CHARACTERS = {
    purple: { left: 70, width: 180, height: 400, typingHeight: 440, eyes: { gap: 32, size: 18, pupil: 7, max: 5 }, face: { minX: -46, maxX: 18, minY: -8, maxY: 5 }, eyesAt: { default: [75, 25], looking: [85, 50], visible: [50, 20] }, mouthAt: { default: [97, 57], looking: [106, 82], visible: [72, 57] } },
    black: { left: 240, width: 120, height: 310, typingHeight: 310, eyes: { gap: 24, size: 16, pupil: 6, max: 4 }, face: { minX: -15, maxX: 15, minY: -10, maxY: 10 }, eyesAt: { default: [26, 32], looking: [32, 12], visible: [10, 28] } },
    orange: { left: 0, width: 240, height: 150, typingHeight: 150, eyes: { gap: 32, size: 12, pupil: 12, max: 5 }, face: { minX: -46, maxX: 20, minY: -18, maxY: 20 }, eyesAt: { default: [112, 60], visible: [80, 55] }, mouthAt: { default: [126, 92], visible: [94, 87] } },
    yellow: { left: 310, width: 140, height: 230, typingHeight: 230, eyes: { gap: 24, size: 12, pupil: 12, max: 5 }, face: { minX: -15, maxX: 15, minY: -10, maxY: 10 }, eyesAt: { default: [52, 40], visible: [20, 35] }, mouthAt: { default: [40, 88], visible: [10, 88] } }
  };

  const YELLOW_MOUTH = {
    idle: "M0 10 Q10 10, 20 10 Q30 10, 40 10 Q50 10, 60 10 Q70 10, 80 10",
    sad: "M0 10 Q10 2, 20 10 Q30 18, 40 10 Q50 2, 60 10 Q70 18, 80 10",
    happy: "M0 2 Q10 10, 20 14 Q30 18, 40 18 Q50 18, 60 14 Q70 10, 80 2"
  };

  function renderMarkup() {
    const eyeballs = (count, size) => Array.from({ length: count }, () =>
      `<span class="dchar-eyeball" data-size="${size}"><span class="dchar-pupil"></span></span>`).join("");
    const barePupils = (count) => Array.from({ length: count }, () =>
      `<span class="dchar-pupil dchar-pupil-bare"></span>`).join("");
    return `
      <div class="dchar-scaler"><div class="dchar-stage" data-state="idle">
        <div class="dchar dchar-purple">
          <span class="dchar-eyes">${eyeballs(2, CHARACTERS.purple.eyes.size)}</span>
          <span class="dchar-mouth dchar-mouth-purple"></span>
        </div>
        <div class="dchar dchar-black">
          <span class="dchar-eyes">${eyeballs(2, CHARACTERS.black.eyes.size)}</span>
        </div>
        <div class="dchar dchar-orange">
          <span class="dchar-eyes">${barePupils(2)}</span>
          <span class="dchar-mouth dchar-mouth-orange"></span>
        </div>
        <div class="dchar dchar-yellow">
          <span class="dchar-eyes">${barePupils(2)}</span>
          <span class="dchar-mouth-wrapper"><svg width="80" height="20" viewBox="0 0 80 20"><path class="dchar-yellow-mouth" stroke="#2D2D2D" stroke-width="3" fill="none" stroke-linecap="round"/></svg></span>
        </div>
      </div></div>`;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function reducedMotion() {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function mount(frame, options = {}) {
    const interactive = options.interactive !== false;
    frame.innerHTML = renderMarkup();
    const stage = frame.querySelector(".dchar-stage");
    const els = {};
    for (const key of Object.keys(CHARACTERS)) {
      const el = stage.querySelector(`.dchar-${key}`);
      els[key] = {
        el,
        eyes: el.querySelector(".dchar-eyes"),
        mouth: el.querySelector(".dchar-mouth, .dchar-mouth-wrapper"),
        eyeballs: Array.from(el.querySelectorAll(".dchar-eyeball")),
        pupils: Array.from(el.querySelectorAll(".dchar-pupil")),
        yellowPath: el.querySelector(".dchar-yellow-mouth")
      };
    }
    const purpleMouth = stage.querySelector(".dchar-mouth-purple");
    const orangeMouth = stage.querySelector(".dchar-mouth-orange");

    let mode = "idle";
    let destroyed = false;
    let hasEntered = false;
    let looking = false;
    let peeking = false;
    let successLookY = -5;
    let pendingMouse = { x: 0, y: 0 };

    const centers = {};
    const face = { purple: { x: 0, y: 0, skew: 0 }, black: { x: 0, y: 0, skew: 0 }, orange: { x: 0, y: 0, skew: 0 }, yellow: { x: 0, y: 0, skew: 0 } };
    let timers = [];
    let rafId = 0;
    let lookRafId = 0;

    function later(fn, ms) {
      const id = setTimeout(() => {
        if (!destroyed) fn();
      }, ms);
      timers.push(id);
      return id;
    }

    function scheduleBlink(key) {
      later(() => {
        const { eyeballs } = els[key];
        eyeballs.forEach((eye) => { eye.style.height = "2px"; });
        later(() => {
          eyeballs.forEach((eye) => { eye.style.height = `${CHARACTERS[key].eyes.size}px`; });
          scheduleBlink(key);
        }, 150);
      }, 3000 + Math.random() * 4000);
    }

    function updateCenters() {
      for (const key of Object.keys(els)) {
        const rect = els[key].el.getBoundingClientRect();
        centers[key] = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 3 };
      }
    }

    function computeFace(key, mx, my) {
      const config = CHARACTERS[key];
      const center = centers[key] || { x: 0, y: 0 };
      const deltaX = mx - center.x;
      const deltaY = my - center.y;
      const scaleX = Math.max(Math.abs(config.face.minX), Math.abs(config.face.maxX)) || 15;
      const scaleY = Math.max(Math.abs(config.face.minY), Math.abs(config.face.maxY)) || 10;
      return {
        x: clamp(deltaX / (300 / scaleX), config.face.minX, config.face.maxX),
        y: clamp(deltaY / (300 / scaleY), config.face.minY, config.face.maxY),
        skew: clamp(-deltaX / 120, -6, 6)
      };
    }

    function applyFrame() {
      if (destroyed || !hasEntered) return;
      for (const key of Object.keys(els)) {
        face[key] = computeFace(key, pendingMouse.x, pendingMouse.y);
      }
      renderBodies();
      renderEyes();
    }

    function bodyTransform(key) {
      const skew = face[key].skew || 0;
      if (mode === "visible") return "skewX(0deg)";
      if (mode === "typing" || mode === "hiding") {
        if (key === "purple") return `skewX(${skew - 12}deg) translateX(40px)`;
        if (key === "black") return `skewX(${skew * 1.5}deg)`;
        return `skewX(${skew}deg)`;
      }
      if (key === "black") return `skewX(${skew * 1.5}deg)`;
      return `skewX(${skew}deg)`;
    }

    function eyesPosition(key) {
      const config = CHARACTERS[key];
      const at = config.eyesAt;
      if (mode === "visible" && at.visible) return at.visible;
      if (looking && at.looking) return at.looking;
      return [at.default[0] + face[key].x, at.default[1] + face[key].y];
    }

    function mouthPosition(key) {
      const config = CHARACTERS[key];
      if (!config.mouthAt) return null;
      const at = config.mouthAt;
      if (mode === "visible" && at.visible) return at.visible;
      if (looking && at.looking) return at.looking;
      return [at.default[0] + face[key].x, at.default[1] + face[key].y];
    }

    function renderBodies() {
      for (const key of Object.keys(els)) {
        els[key].el.style.transform = bodyTransform(key);
        els[key].el.style.height = `${(mode === "typing" || mode === "hiding") ? CHARACTERS[key].typingHeight : CHARACTERS[key].height}px`;
        const position = eyesPosition(key);
        els[key].eyes.style.left = `${position[0]}px`;
        els[key].eyes.style.top = `${position[1]}px`;
        const mouth = mouthPosition(key);
        if (mouth && els[key].mouth) {
          els[key].mouth.style.left = `${mouth[0]}px`;
          els[key].mouth.style.top = `${mouth[1]}px`;
        }
      }
      if (purpleMouth) {
        purpleMouth.style.setProperty("--counter-skew", (mode === "typing" || mode === "hiding")
          ? `skewX(${-(face.purple.skew - 12)}deg)`
          : "skewX(0deg)");
      }
    }

    function forceLook(key) {
      if (mode === "happy") return { x: 0, y: successLookY };
      if (mode === "visible") {
        if (key === "purple") return peeking ? { x: 4, y: 5 } : { x: -4, y: -4 };
        if (key === "black") return { x: -4, y: -4 };
        return { x: -5, y: -4 };
      }
      if (looking) {
        if (key === "purple") return { x: 3, y: 4 };
        if (key === "black") return { x: 0, y: -4 };
      }
      return null;
    }

    function renderEyes() {
      for (const key of Object.keys(els)) {
        const config = CHARACTERS[key].eyes;
        const forced = forceLook(key);
        els[key].pupils.forEach((pupil) => {
          if (forced) {
            pupil.style.transform = `translate(${forced.x}px, ${forced.y}px)`;
            return;
          }
          if (!hasEntered) {
            pupil.style.transform = "translate(0, 0)";
            return;
          }
          const center = centers[key] || { x: 0, y: 0 };
          const deltaX = pendingMouse.x - center.x;
          const deltaY = pendingMouse.y - (center.y + 20);
          const distance = Math.min(Math.hypot(deltaX, deltaY), config.max);
          const angle = Math.atan2(deltaY, deltaX);
          pupil.style.transform = `translate(${Math.cos(angle) * distance}px, ${Math.sin(angle) * distance}px)`;
        });
      }
    }

    function renderMouths() {
      stage.dataset.state = mode;
      if (els.yellow.yellowPath) {
        els.yellow.yellowPath.style.d = mode === "sad" ? `path("${YELLOW_MOUTH.sad}")`
          : mode === "happy" ? `path("${YELLOW_MOUTH.happy}")`
            : `path("${YELLOW_MOUTH.idle}")`;
      }
      void purpleMouth;
      void orangeMouth;
    }

    function schedulePeek() {
      if (mode !== "visible") return;
      later(() => {
        peeking = true;
        renderEyes();
        later(() => {
          peeking = false;
          renderEyes();
          schedulePeek();
        }, 800);
      }, 2000 + Math.random() * 3000);
    }

    function animateSuccessLook() {
      const startTime = performance.now();
      const step = (now) => {
        if (destroyed || mode !== "happy") return;
        const progress = Math.min((now - startTime) / 5500, 1);
        const eased = progress < 0.5
          ? 4 * progress * progress * progress
          : 1 - Math.pow(-2 * progress + 2, 3) / 2;
        successLookY = -5 + 9 * eased;
        renderEyes();
        if (progress < 1) lookRafId = requestAnimationFrame(step);
      };
      lookRafId = requestAnimationFrame(step);
    }

    function spawnConfetti() {
      if (reducedMotion() || frame.querySelector(".dchar-confetti")) return;
      const container = document.createElement("div");
      container.className = "dchar-confetti";
      container.setAttribute("aria-hidden", "true");
      for (let index = 0; index < 180; index += 1) {
        const piece = document.createElement("span");
        piece.className = "dchar-confetti-piece";
        piece.style.left = `${Math.random() * 100}%`;
        piece.style.top = `-${10 + Math.random() * 30}%`;
        piece.style.backgroundColor = CONFETTI_COLORS[index % CONFETTI_COLORS.length];
        piece.style.width = `${4 + Math.random() * 6}px`;
        piece.style.height = `${8 + Math.random() * 12}px`;
        piece.style.animationDelay = `${Math.random() * 2}s`;
        piece.style.animationDuration = `${4.5 + Math.random() * 2}s`;
        piece.style.transform = `rotate(${Math.random() * 360}deg)`;
        container.append(piece);
      }
      frame.append(container);
      later(() => container.remove(), 8000);
    }

    function renderScale() {
      const scale = clamp(frame.clientWidth / STAGE_WIDTH, 0.4, 1);
      const scaler = frame.querySelector(".dchar-scaler");
      if (!scaler) return;
      scaler.style.transform = `scale(${scale})`;
      scaler.style.height = `${STAGE_HEIGHT * scale}px`;
    }

    function applyMouse(x, y) {
      pendingMouse = { x, y };
      if (rafId || !hasEntered) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        applyFrame();
      });
    }

    function handleResize() {
      renderScale();
      updateCenters();
      applyFrame();
    }

    function setMode(next) {
      if (destroyed || mode === next) return;
      const previous = mode;
      mode = next;
      renderMouths();
      renderBodies();
      renderEyes();
      if (next === "typing" && previous !== "typing") {
        looking = true;
        renderBodies();
        renderEyes();
        later(() => {
          looking = false;
          renderBodies();
          renderEyes();
        }, 800);
      }
      if (next === "visible") {
        peeking = false;
        schedulePeek();
      }
      if (next === "happy") {
        successLookY = -5;
        if (lookRafId) cancelAnimationFrame(lookRafId);
        animateSuccessLook();
        spawnConfetti();
      }
    }

    const controller = {
      setState: setMode,
      get state() { return mode; },
      refresh() {
        renderScale();
        updateCenters();
        applyFrame();
      },
      destroy() {
        destroyed = true;
        timers.forEach((id) => clearTimeout(id));
        if (rafId) cancelAnimationFrame(rafId);
        if (lookRafId) cancelAnimationFrame(lookRafId);
        if (interactive && typeof window !== "undefined") {
          window.removeEventListener("mousemove", onMouseMove);
          window.removeEventListener("resize", handleResize);
        }
        frame.innerHTML = "";
      }
    };

    function onMouseMove(event) {
      applyMouse(event.clientX, event.clientY);
    }

    if (typeof window !== "undefined") {
      if (interactive) window.addEventListener("mousemove", onMouseMove, { passive: true });
      window.addEventListener("resize", handleResize, { passive: true });
    }

    renderMouths();
    renderScale();
    /* 首帧写入眼睛/嘴的内联定位，避免入场前悬在角色左上角 */
    renderBodies();
    renderEyes();

    if (reducedMotion()) {
      hasEntered = true;
      pendingMouse = { x: 0, y: 0 };
      stage.classList.add("entered");
      later(() => {
        updateCenters();
        renderBodies();
        renderEyes();
      }, 50);
    } else {
      later(() => {
        hasEntered = true;
        stage.classList.add("entered");
        renderScale();
        updateCenters();
        renderBodies();
        renderEyes();
      }, 1400);
      for (const key of Object.keys(els)) scheduleBlink(key);
    }

    return controller;
  }

  return { renderMarkup, mount };
});
