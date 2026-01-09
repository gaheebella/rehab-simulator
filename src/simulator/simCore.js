// src/simulator/simCore.js
// 특허 시나리오 핵심 로직(EMA, Dual Threshold, Z-score 기반 모드 선택, 임피던스 파라미터 산출)

export function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

export function ema(prev, x, alpha = 0.25) {
  if (prev === null || prev === undefined) return x;
  return alpha * x + (1 - alpha) * prev;
}

// Adaptive Threshold: T_min + (T_base - T_min) / (1 + exp(k*(slope - s_mid)))
export function adaptiveThreshold({ T_min, T_base, k_s, s_mid }, slope) {
  const denom = 1 + Math.exp(k_s * (slope - s_mid));
  return T_min + (T_base - T_min) / denom;
}

// Gate 상태 결정: NORMAL / ADAPTIVE / EMERGENCY
export function decideGate(pBar, T_abs, T_adapt) {
  if (pBar >= T_abs) return "EMERGENCY";
  if (pBar >= T_adapt) return "ADAPTIVE";
  return "NORMAL";
}

// Z-score 기반 모드: Assist / Constraint / Damping / Transparent / Emergency-Stop
export function decideMode(gate, z, theta) {
  if (gate === "EMERGENCY") return "Emergency-Stop";
  if (gate === "NORMAL") return "Transparent";

  // 우선순위(권장): 불안정 -> 보상 -> 과활성
  if (z.Z_inst >= theta.theta_inst) return "Damping";
  if (z.Z_comp >= theta.theta_comp) return "Constraint";
  if (z.Z_act >= theta.theta_act) return "Assist";

  // ADAPTIVE인데 z가 애매하면 기본 개입(보조)
  return "Assist";
}

// 마진 기반 연속 임피던스(기본): K=K0+gK*m, D=D0+gD*m
// 모드별 조정(특허 설명과 대응): Assist는 K↓, Damping은 D↑, Constraint는 가이드 강성↑(여기서는 guideK로 노출)
export function impedanceFromMargin(
  {
    K0,
    D0,
    guideK0,
    gK,
    gD,
    gGuide,
    K_min,
    K_max,
    D_min,
    D_max,
    guideK_min,
    guideK_max,
  },
  margin,
  mode
) {
  const m = Math.max(0, margin);

  let K = K0 + gK * m;
  let D = D0 + gD * m;
  let guideK = guideK0 + gGuide * m;

  if (mode === "Assist") {
    // 저항 감소(강성 낮추기)
    K = K0 - 0.5 * gK * m;
  } else if (mode === "Damping") {
    // 감쇠 증가
    D = D0 + 1.5 * gD * m;
  } else if (mode === "Constraint") {
    // 궤적 구속(가이드 강성 증가)
    guideK = guideK0 + 2.0 * gGuide * m;
  } else if (mode === "Emergency-Stop") {
    // 안전 모드: 강성/감쇠 상한쪽(또는 토크 컷 등) — UI용 파라미터로 표현
    K = K_max;
    D = D_max;
    guideK = guideK_max;
  }

  return {
    K: clamp(Number(K.toFixed(2)), K_min, K_max),
    D: clamp(Number(D.toFixed(2)), D_min, D_max),
    guideK: clamp(Number(guideK.toFixed(2)), guideK_min, guideK_max),
    m: Number(m.toFixed(4)),
  };
}
