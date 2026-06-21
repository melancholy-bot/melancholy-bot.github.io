/* =============================================================
 * Frenet Lab — app.js
 * 3D 렌더링(three.js) + 자체 구현 궤도 카메라 + TNB 틀 애니메이션
 * + 곡률/비틀림 실시간 그래프 + UI 연결.
 * 곡률·비틀림 값은 항상 "원래 곡선"에서 계산하고,
 * 화면에는 보기 좋게 정규화(이동·확대)한 좌표만 그린다.
 * ============================================================= */
(function () {
  "use strict";
  const FM = window.FrenetMath;

  /* ---------- 상수 ---------- */
  const SAMPLES = 600;     // 곡선/그래프 샘플 수
  const TARGET = 5;        // 정규화 목표 반지름(화면용)
  const ARROW_LEN = 1.7;   // TNB 화살표 표시 길이
  const CIRC_SEG = 96;     // 접촉원 분할
  const CIRC_CAP = 70;     // 접촉원이 이보다 크면(거의 직선) 숨김

  /* ---------- 프리셋 곡선 ---------- */
  const PRESETS = [
    { name: "나선 Helix",      x: "2*cos(t)", y: "2*sin(t)", z: "0.5*t",  tmin: "0", tmax: "6*pi" },
    { name: "세잎매듭 Trefoil", x: "sin(t)+2*sin(2*t)", y: "cos(t)-2*cos(2*t)", z: "-sin(3*t)", tmin: "0", tmax: "2*pi" },
    { name: "꼬인삼차곡선",     x: "t", y: "t^2", z: "t^3", tmin: "-1.5", tmax: "1.5" },
    { name: "비비아니 곡선",    x: "1+cos(t)", y: "sin(t)", z: "2*sin(t/2)", tmin: "0", tmax: "4*pi" },
    { name: "원뿔나선",        x: "0.35*t*cos(3*t)", y: "0.35*t*sin(3*t)", z: "0.4*t", tmin: "0", tmax: "4*pi" },
    { name: "토러스매듭",      x: "(2+cos(3*t))*cos(2*t)", y: "(2+cos(3*t))*sin(2*t)", z: "sin(3*t)", tmin: "0", tmax: "2*pi" },
  ];

  /* ---------- 상태 ---------- */
  let scene, camera, renderer, stage;
  let curveLine, ptMesh, circleLine;
  let arrowT, arrowN, arrowB;
  let cur = null;          // 현재 곡선 {r, tMin, tMax, data, centroid, scale}
  let tNorm = 0;           // 애니메이션 파라미터 0..1
  let playing = true;
  let speed = 1;
  const show = { frame: true, circle: true, trail: true };

  /* ---------- 3D 좌표 변환(원좌표 -> 화면좌표) ---------- */
  // x축 기준 -90° 회전 (x,y,z) -> (x, z, -y): 행렬식 +1 이므로 오른손 좌표계 보존.
  function worldVec(p) {
    return new THREE.Vector3(
      (p[0] - cur.centroid[0]) * cur.scale,
      (p[2] - cur.centroid[2]) * cur.scale,    // z(원) -> 화면 y (위로)
      -(p[1] - cur.centroid[1]) * cur.scale    // -y(원) -> 화면 z
    );
  }
  function worldDir(d) { // 방향(단위벡터): 같은 회전, 크기 보존
    return new THREE.Vector3(d[0], d[2], -d[1]);
  }

  /* ===========================================================
   *  씬 초기화
   * =========================================================== */
  function initScene() {
    stage = document.getElementById("stage");
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x090d15);

    const w = stage.clientWidth, h = stage.clientHeight;
    camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 1000);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h);
    stage.appendChild(renderer.domElement);

    // 바닥 그리드 + 원점 표시(중립 회색 — TNB 색과 충돌 방지)
    const grid = new THREE.GridHelper(20, 20, 0x2a3547, 0x18202d);
    grid.position.y = -TARGET * 1.05;
    scene.add(grid);

    // 곡선
    curveLine = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xc9d4e4, transparent: true, opacity: 0.85 })
    );
    scene.add(curveLine);

    // 접촉원(점선)
    circleLine = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineDashedMaterial({ color: 0xf4c45d, dashSize: 0.32, gapSize: 0.18, transparent: true, opacity: 0.95 })
    );
    scene.add(circleLine);

    // 현재 점
    ptMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.13, 20, 20),
      new THREE.MeshBasicMaterial({ color: 0xf4c45d })
    );
    scene.add(ptMesh);

    // TNB 화살표
    const o = new THREE.Vector3();
    arrowT = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), o, ARROW_LEN, 0xff6f5e, 0.45, 0.28);
    arrowN = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), o, ARROW_LEN, 0x37d597, 0.45, 0.28);
    arrowB = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), o, ARROW_LEN, 0x5b9cff, 0.45, 0.28);
    scene.add(arrowT, arrowN, arrowB);

    initOrbit();
    window.addEventListener("resize", onResize);
  }

  /* ===========================================================
   *  자체 구현 궤도 카메라 (드래그 회전 / 휠 줌)
   * =========================================================== */
  const orbit = { theta: 0.9, phi: 1.15, radius: 14, target: new THREE.Vector3(0, 0, 0) };
  function applyCamera() {
    const { theta, phi, radius, target } = orbit;
    camera.position.set(
      target.x + radius * Math.sin(phi) * Math.sin(theta),
      target.y + radius * Math.cos(phi),
      target.z + radius * Math.sin(phi) * Math.cos(theta)
    );
    camera.lookAt(target);
  }
  function initOrbit() {
    const el = renderer.domElement;
    let dragging = false, px = 0, py = 0;
    el.style.touchAction = "none";
    el.addEventListener("pointerdown", (e) => { dragging = true; px = e.clientX; py = e.clientY; el.setPointerCapture(e.pointerId); });
    el.addEventListener("pointerup", () => { dragging = false; });
    el.addEventListener("pointerleave", () => { dragging = false; });
    el.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - px, dy = e.clientY - py;
      px = e.clientX; py = e.clientY;
      orbit.theta -= dx * 0.006;
      orbit.phi = Math.max(0.08, Math.min(Math.PI - 0.08, orbit.phi - dy * 0.006));
      applyCamera();
    });
    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      orbit.radius = Math.max(4, Math.min(60, orbit.radius * (1 + e.deltaY * 0.0011)));
      applyCamera();
    }, { passive: false });
    applyCamera();
  }

  /* ===========================================================
   *  곡선 생성 / 정규화 / 그래프 데이터
   * =========================================================== */
  function buildCurve(ex, ey, ez, tminStr, tmaxStr) {
    const tMin = math.evaluate(tminStr);
    const tMax = math.evaluate(tmaxStr);
    if (!(isFinite(tMin) && isFinite(tMax) && tMax > tMin))
      throw new Error("t 범위가 올바르지 않습니다.");

    const r = FM.makeCurve(ex, ey, ez);             // 식 오류 시 throw
    const data = FM.sampleCurve(r, tMin, tMax, SAMPLES);
    if (data.pts.length < 3) throw new Error("곡선을 평가할 수 없습니다.");

    // 중심과 반지름(정규화)
    const c = [0, 0, 0];
    data.pts.forEach((p) => { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; });
    c[0] /= data.pts.length; c[1] /= data.pts.length; c[2] /= data.pts.length;
    let maxR = 1e-6;
    data.pts.forEach((p) => {
      const dx = p[0] - c[0], dy = p[1] - c[1], dz = p[2] - c[2];
      maxR = Math.max(maxR, Math.sqrt(dx * dx + dy * dy + dz * dz));
    });
    const scale = TARGET / maxR;

    cur = { r, tMin, tMax, data, centroid: c, scale };

    // 곡선 라인 갱신
    const vs = data.pts.map(worldVec);
    curveLine.geometry.dispose();
    curveLine.geometry = new THREE.BufferGeometry().setFromPoints(vs);

    buildGraphs();
    tNorm = 0;
    updateScene();
  }

  /* ===========================================================
   *  매 프레임 갱신: TNB 틀 / 점 / 접촉원 / 측정값 / 그래프
   * =========================================================== */
  const fmt = (v, d = 4) => (Math.abs(v) >= 1e4 || (v !== 0 && Math.abs(v) < 1e-3))
    ? v.toExponential(2) : v.toFixed(d);

  function updateScene() {
    if (!cur) return;
    const t = cur.tMin + tNorm * (cur.tMax - cur.tMin);
    const f = FM.frameAt(cur.r, t);

    const pW = worldVec(f.point);
    ptMesh.position.copy(pW);

    const Tw = worldDir(f.T), Nw = worldDir(f.N), Bw = worldDir(f.B);
    arrowT.position.copy(pW); arrowT.setDirection(Tw);
    arrowN.position.copy(pW); arrowN.setDirection(Nw);
    arrowB.position.copy(pW); arrowB.setDirection(Bw);

    // 접촉원
    let drawCircle = false;
    if (show.circle && f.radius && isFinite(f.radius)) {
      const Rw = f.radius * cur.scale;
      if (Rw < CIRC_CAP) {
        const cW = worldVec(f.circleCenter);
        const pts = [];
        for (let i = 0; i <= CIRC_SEG; i++) {
          const a = (i / CIRC_SEG) * 2 * Math.PI, ca = Math.cos(a), sa = Math.sin(a);
          pts.push(new THREE.Vector3(
            cW.x - Rw * ca * Nw.x + Rw * sa * Tw.x,
            cW.y - Rw * ca * Nw.y + Rw * sa * Tw.y,
            cW.z - Rw * ca * Nw.z + Rw * sa * Tw.z
          ));
        }
        circleLine.geometry.dispose();
        circleLine.geometry = new THREE.BufferGeometry().setFromPoints(pts);
        circleLine.computeLineDistances();
        drawCircle = true;
      }
    }
    circleLine.visible = drawCircle;

    arrowT.visible = arrowN.visible = arrowB.visible = show.frame;
    curveLine.visible = show.trail;

    // 측정값(원래 곡선 기준)
    document.getElementById("rSpeed").textContent = fmt(f.speed, 3);
    document.getElementById("rKappa").textContent = fmt(f.kappa);
    document.getElementById("rRad").textContent =
      f.kappa < 1e-4 ? "∞ (직선)" : fmt(1 / f.kappa, 3);
    document.getElementById("rTau").textContent = fmt(f.tau);
    document.getElementById("tval").textContent = "t=" + t.toFixed(2);
    document.getElementById("tslider").value = Math.round(tNorm * 1000);

    drawGraphs(f);
  }

  /* ===========================================================
   *  2D 그래프 (곡률 κ, 비틀림 τ)
   * =========================================================== */
  let gK, gT, gKctx, gTctx;
  function buildGraphs() {
    gK = document.getElementById("gKappa"); gT = document.getElementById("gTau");
    sizeCanvas(gK); sizeCanvas(gT);
    gKctx = gK.getContext("2d"); gTctx = gT.getContext("2d");
  }
  function sizeCanvas(cv) {
    const dpr = Math.min(window.devicePixelRatio, 2);
    const w = cv.clientWidth || 600, h = 150;
    cv.width = w * dpr; cv.height = h * dpr;
    cv.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function drawOneGraph(ctx, cv, values, color) {
    const W = cv.clientWidth || 600, H = 150, pad = 14;
    ctx.clearRect(0, 0, W, H);
    let lo = Math.min(...values), hi = Math.max(...values);
    if (lo > 0) lo = 0;                 // 0 기준선 포함
    if (hi < 0) hi = 0;
    if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
    const pad2 = (hi - lo) * 0.12; lo -= pad2; hi += pad2;
    const X = (i) => pad + (i / (values.length - 1)) * (W - 2 * pad);
    const Y = (v) => H - pad - ((v - lo) / (hi - lo)) * (H - 2 * pad);

    // 0 기준선
    ctx.strokeStyle = "#1e2735"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad, Y(0)); ctx.lineTo(W - pad, Y(0)); ctx.stroke();

    // 값 곡선
    ctx.strokeStyle = color; ctx.lineWidth = 1.8; ctx.beginPath();
    for (let i = 0; i < values.length; i++) {
      const x = X(i), y = Y(values[i]);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
    return { X, Y, lo, hi, W, H, pad };
  }
  function marker(ctx, g, valNow, color) {
    const x = g.pad + tNorm * (g.W - 2 * g.pad);
    const y = g.Y(valNow);
    ctx.strokeStyle = "#3a4658"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, g.pad); ctx.lineTo(x, g.H - g.pad); ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x, y, 3.5, 0, 2 * Math.PI); ctx.fill();
  }
  function drawGraphs(f) {
    if (!cur || !gKctx) return;
    const gk = drawOneGraph(gKctx, gK, cur.data.ks, "#37d597");
    marker(gKctx, gk, f.kappa, "#f4c45d");
    const gt = drawOneGraph(gTctx, gT, cur.data.taus, "#5b9cff");
    marker(gTctx, gt, f.tau, "#f4c45d");
  }

  /* ===========================================================
   *  애니메이션 루프
   * =========================================================== */
  const clock = new THREE.Clock();
  function loop() {
    requestAnimationFrame(loop);
    const dt = Math.min(clock.getDelta(), 0.05);
    if (playing && cur) {
      tNorm += dt * 0.12 * speed;
      if (tNorm > 1) tNorm -= 1;
      updateScene();
    }
    renderer.render(scene, camera);
  }

  /* ===========================================================
   *  UI 연결
   * =========================================================== */
  function showError(msg) { document.getElementById("err").textContent = msg || ""; }

  function drawFromInputs() {
    try {
      buildCurve(
        document.getElementById("ex").value,
        document.getElementById("ey").value,
        document.getElementById("ez").value,
        document.getElementById("tmin").value,
        document.getElementById("tmax").value
      );
      showError("");
    } catch (e) { showError("⚠ " + e.message); }
  }

  function initUI() {
    // 프리셋 버튼
    const box = document.getElementById("presets");
    PRESETS.forEach((p, i) => {
      const b = document.createElement("button");
      b.className = "preset" + (i === 0 ? " active" : "");
      b.textContent = p.name;
      b.onclick = () => {
        document.querySelectorAll(".preset").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        document.getElementById("ex").value = p.x;
        document.getElementById("ey").value = p.y;
        document.getElementById("ez").value = p.z;
        document.getElementById("tmin").value = p.tmin;
        document.getElementById("tmax").value = p.tmax;
        drawFromInputs();
      };
      box.appendChild(b);
    });

    document.getElementById("draw").onclick = () => {
      document.querySelectorAll(".preset").forEach((x) => x.classList.remove("active"));
      drawFromInputs();
    };

    const playBtn = document.getElementById("play");
    playBtn.onclick = () => {
      playing = !playing;
      playBtn.textContent = playing ? "❚❚ 일시정지" : "▶ 재생";
    };
    playBtn.textContent = "❚❚ 일시정지";

    document.getElementById("speed").oninput = (e) => { speed = parseFloat(e.target.value); };
    document.getElementById("tslider").oninput = (e) => {
      tNorm = parseInt(e.target.value, 10) / 1000;
      updateScene();
    };
    document.getElementById("tgFrame").onchange = (e) => { show.frame = e.target.checked; updateScene(); };
    document.getElementById("tgCircle").onchange = (e) => { show.circle = e.target.checked; updateScene(); };
    document.getElementById("tgTrail").onchange = (e) => { show.trail = e.target.checked; updateScene(); };
  }

  function onResize() {
    if (!renderer) return;
    const w = stage.clientWidth, h = stage.clientHeight;
    camera.aspect = w / h; camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    if (gK) { sizeCanvas(gK); sizeCanvas(gT); if (cur) updateScene(); }
  }

  /* ---------- 시작 ---------- */
  window.addEventListener("DOMContentLoaded", () => {
    if (typeof THREE === "undefined" || typeof math === "undefined") {
      document.getElementById("err") &&
        (document.getElementById("err").textContent =
          "라이브러리(js/lib)를 불러오지 못했습니다. 폴더 구조가 그대로인지 확인하세요.");
      return;
    }
    initScene();
    initUI();
    drawFromInputs(); // 기본 곡선(나선)
    loop();
  });
})();
