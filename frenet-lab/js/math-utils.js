/* =============================================================
 * Frenet Lab — 미분기하 계산 모듈 (math-utils.js)
 * 공간곡선 r(t) = (x(t), y(t), z(t)) 에 대하여
 *   - 수치미분으로 r', r'', r''' 을 구하고
 *   - 단위접선 T, 단위법선 N, 종법선 B (TNB 틀)
 *   - 곡률 kappa, 비틀림(토션) tau
 *   - 접촉원(osculating circle) 중심/반지름
 * 을 계산한다.
 *
 * 브라우저에서는 전역 `math`(math.js)를 사용하고,
 * node 환경에서는 require('mathjs') 를 사용한다(테스트용).
 * ============================================================= */
(function (global) {
  "use strict";

  // math.js 핸들 확보 (브라우저 전역 또는 node require)
  const MJS =
    (typeof global.math !== "undefined" && global.math) ||
    (typeof require !== "undefined" ? require("mathjs") : null);

  /* ---------- 3차원 벡터 기본 연산 ---------- */
  const V = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ],
    norm: (a) => Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]),
    normalize: (a) => {
      const n = V.norm(a);
      return n < 1e-12 ? [0, 0, 0] : [a[0] / n, a[1] / n, a[2] / n];
    },
  };

  /* ---------- 사용자 입력식 -> 곡선 함수 r(t) ----------
   * exprX/Y/Z 는 "cos(t)", "t/3", "sin(2*t)" 같은 문자열.
   * 컴파일해 두고 t 값만 바꿔 빠르게 평가한다. */
  function makeCurve(exprX, exprY, exprZ) {
    if (!MJS) throw new Error("math.js 를 찾을 수 없습니다.");
    const cx = MJS.compile(exprX);
    const cy = MJS.compile(exprY);
    const cz = MJS.compile(exprZ);
    const r = function (t) {
      const s = { t: t };
      return [cx.evaluate(s), cy.evaluate(s), cz.evaluate(s)];
    };
    // 입력 검증: t=0 부근에서 한 번 평가해 본다.
    const test = r(0.123);
    if (!test.every((v) => typeof v === "number" && isFinite(v))) {
      throw new Error("식을 평가할 수 없습니다. 변수는 t 만 사용하세요.");
    }
    return r;
  }

  /* ---------- 수치미분 (중심차분) ----------
   * 1차/2차: h1, 3차: h2(조금 크게)로 잡아 잡음을 줄인다. */
  function derivatives(r, t) {
    const h1 = 1e-4;
    const h2 = 1e-3;

    const rp1 = r(t + h1), rm1 = r(t - h1);
    const r0 = r(t);

    // r'(t)
    const d1 = V.scale(V.sub(rp1, rm1), 1 / (2 * h1));
    // r''(t)
    const d2 = V.scale(
      V.sub(V.add(rp1, rm1), V.scale(r0, 2)),
      1 / (h1 * h1)
    );
    // r'''(t)  (5점 공식)
    const rp2 = r(t + 2 * h2), rp = r(t + h2);
    const rm = r(t - h2), rm2 = r(t - 2 * h2);
    const d3 = V.scale(
      V.add(
        V.sub(rp2, V.scale(rp, 2)),
        V.sub(V.scale(rm, 2), rm2)
      ),
      1 / (2 * h2 * h2 * h2)
    );
    return { r0, d1, d2, d3 };
  }

  /* ---------- 한 점에서의 모든 기하량 ---------- */
  function frameAt(r, t) {
    const { r0, d1, d2, d3 } = derivatives(r, t);

    const speed = V.norm(d1);          // |r'|
    const d1xd2 = V.cross(d1, d2);     // r' x r''
    const crossNorm = V.norm(d1xd2);

    // 곡률 kappa = |r' x r''| / |r'|^3
    const kappa = speed > 1e-9 ? crossNorm / (speed * speed * speed) : 0;
    // 비틀림 tau = (r' x r'') . r''' / |r' x r''|^2
    const tau =
      crossNorm > 1e-9 ? V.dot(d1xd2, d3) / (crossNorm * crossNorm) : 0;

    // TNB 틀
    const T = V.normalize(d1);
    const B = V.normalize(d1xd2);
    const N = V.normalize(V.cross(B, T));

    // 접촉원: 곡률중심 = r + (1/kappa)*N, 반지름 = 1/kappa
    let circleCenter = null, radius = null;
    if (kappa > 1e-6) {
      radius = 1 / kappa;
      circleCenter = V.add(r0, V.scale(N, radius));
    }

    return {
      t, point: r0, speed, kappa, tau, T, N, B,
      radius, circleCenter,
    };
  }

  /* ---------- 곡선 위를 따라 샘플링 ----------
   * 3D 라인 그리기와 곡률/토션 그래프에 쓸 점들을 한 번에 만든다. */
  function sampleCurve(r, tMin, tMax, n) {
    const pts = [], ks = [], ts = [], taus = [];
    for (let i = 0; i <= n; i++) {
      const t = tMin + (tMax - tMin) * (i / n);
      let f;
      try { f = frameAt(r, t); }
      catch (e) { continue; }
      if (!f.point.every(isFinite)) continue;
      pts.push(f.point);
      ks.push(f.kappa);
      taus.push(f.tau);
      ts.push(t);
    }
    return { pts, ks, taus, ts };
  }

  const API = { V, makeCurve, derivatives, frameAt, sampleCurve };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = API; // node (테스트)
  }
  global.FrenetMath = API; // 브라우저
})(typeof window !== "undefined" ? window : globalThis);
