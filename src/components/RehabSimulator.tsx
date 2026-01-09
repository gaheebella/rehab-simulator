import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * ✅ 입력 CSV (public/data/window_features_with_p.csv) 필수 컬럼:
 * group, subject, file, t0, t1, f_act, f_comp, f_inst, Z_act, Z_comp, Z_inst, p
 *
 * ✅ 특허 정합 핵심:
 * - EMA/slope/T_adapt는 "파일(file) 단위"로 리셋 (Target 경계에서 초기화)
 * - T_abs는 Healthy p 분포 95th percentile (옵션: fallback fixed)
 * - 게이팅: Normal / Adaptive / Critical
 * - Z-score 원인 분리: Assist / Constraint / Damping
 * - 채터링 방지: 히스테리시스 + 최소 유지시간
 * - 임피던스 연속 조정: margin 기반 K(t), D(t) + 원인별 보정
 */

type Row = {
  group: string;
  subject: number;
  file: string;
  t0: number;
  t1: number;
  f_act: number;
  f_comp: number;
  f_inst: number;
  Z_act: number;
  Z_comp: number;
  Z_inst: number;
  p: number; // 0~1
  idx: number; // global idx after sorting
};

type DerivedRow = Row & {
  key: string; // group::subject::file
  pEma: number; // EMA(p)
  slope: number; // pEma(t)-pEma(t-1) within file
  T_adapt: number; // sigmoid(slope)
};

type Mode = "NORMAL" | "ADAPTIVE" | "CRITICAL";
type SubMode = "NONE" | "ASSIST" | "CONSTRAINT" | "DAMPING";

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function clamp01(x: number) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

/**
 * CSV 파서: 기본적인 quoted field 지원(쉼표/줄바꿈 포함 가능).
 * 전처리 CSV가 표준 형태라면 충분합니다.
 */
function parseCSV(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQuotes = false;

  const pushField = () => {
    cur.push(field);
    field = "";
  };
  const pushRow = () => {
    // 빈 줄 제거
    if (cur.length === 1 && cur[0].trim() === "") {
      cur = [];
      return;
    }
    rows.push(cur);
    cur = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = i + 1 < text.length ? text[i + 1] : "";

    if (c === '"' && inQuotes && next === '"') {
      // escaped quote ""
      field += '"';
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (c === "," && !inQuotes) {
      pushField();
      continue;
    }
    if ((c === "\n" || c === "\r") && !inQuotes) {
      // handle CRLF
      if (c === "\r" && next === "\n") i++;
      pushField();
      pushRow();
      continue;
    }
    field += c;
  }
  // 마지막 필드/행
  pushField();
  pushRow();

  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim());
  const out: Record<string, string>[] = [];

  for (let r = 1; r < rows.length; r++) {
    const cols = rows[r];
    const obj: Record<string, string> = {};
    for (let j = 0; j < header.length; j++) {
      obj[header[j]] = (cols[j] ?? "").trim();
    }
    // 헤더가 없는 완전 빈 행 제외
    const any = Object.values(obj).some((v) => v !== "");
    if (any) out.push(obj);
  }
  return out;
}

function percentile(sortedAsc: number[], p: number) {
  if (sortedAsc.length === 0) return 0;
  const rank = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  const w = rank - lo;
  return sortedAsc[lo] * (1 - w) + sortedAsc[hi] * w;
}

/**
 * ✅ 특허 정합 핵심: "파일 단위 EMA 리셋" + slope 계산 + T_adapt 계산
 */
function computeDerivedPerFile(
  rows: Row[],
  alpha: number,
  k_s: number,
  S_mid: number,
  T_min: number,
  T_base: number
): DerivedRow[] {
  const out: DerivedRow[] = [];

  let currentKey = "";
  let prevEma = 0;
  let prevEmaForSlope = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const key = `${r.group}::${r.subject}::${r.file}`;

    if (key !== currentKey) {
      // 파일 경계: EMA 리셋
      currentKey = key;
      prevEma = r.p;
      prevEmaForSlope = prevEma;
      const slope = 0; // 파일 첫 window는 slope=0
      const denom = 1 + Math.exp(k_s * (slope - S_mid));
      const T_adapt = T_min + (T_base - T_min) / denom;

      out.push({ ...r, key, pEma: prevEma, slope, T_adapt });
      continue;
    }

    // 같은 파일 내부: EMA 갱신
    prevEma = alpha * r.p + (1 - alpha) * prevEma;
    const slope = prevEma - prevEmaForSlope;
    prevEmaForSlope = prevEma;

    const denom = 1 + Math.exp(k_s * (slope - S_mid));
    const T_adapt = T_min + (T_base - T_min) / denom;

    out.push({ ...r, key, pEma: prevEma, slope, T_adapt });
  }

  return out;
}

/**
 * 대용량(10만+) 그래프 성능을 위한 다운샘플링
 * - displayPoints 개수로 줄여서 SVG polyline 부담을 줄임
 */
function downsampleSeries(series: number[], maxPoints: number) {
  const n = series.length;
  if (n <= maxPoints) {
    return series.map((v, i) => ({ i, v }));
  }
  const step = (n - 1) / (maxPoints - 1);
  const out: { i: number; v: number }[] = [];
  for (let k = 0; k < maxPoints; k++) {
    const idx = Math.round(k * step);
    out.push({ i: idx, v: series[idx] });
  }
  return out;
}

export default function RehabSimulator() {
  // ===== 파라미터(명세서) =====
  const [alpha, setAlpha] = useState(0.3);

  const [k_s, setK_s] = useState(10);
  const [S_mid, setS_mid] = useState(0.01);
  const [T_base, setT_base] = useState(0.5);
  const [T_min, setT_min] = useState(0.3);

  // 절대 임계치: Healthy 95th 자동 + fallback fixed
  const [useHealthyPercentile, setUseHealthyPercentile] = useState(true);
  const [T_abs_fixed, setT_abs_fixed] = useState(0.85);
  const T_abs_percentile = 95;

  // 파일별 초기 window 제거(옵션)
  const [dropPerFile, setDropPerFile] = useState(5);

  // Z-score 임계치
  const [theta_act, setThetaAct] = useState(2.0);
  const [theta_comp, setThetaComp] = useState(2.0);
  const [theta_inst, setThetaInst] = useState(2.0);

  // 임피던스(시뮬레이션)
  const [K0, setK0] = useState(1.0);
  const [D0, setD0] = useState(1.0);
  const [gammaK, setGammaK] = useState(2.0);
  const [gammaD, setGammaD] = useState(2.0);

  // 원인별 보정
  const [assistKDown, setAssistKDown] = useState(0.5);
  const [guideGain, setGuideGain] = useState(3.0);
  const [epsilon0, setEpsilon0] = useState(1.0);
  const [epsilonMin, setEpsilonMin] = useState(0.2);

  // 채터링 방지
  const [minHoldWindows, setMinHoldWindows] = useState(10);
  const [hyst, setHyst] = useState(0.02);

  // ===== 데이터/재생 =====
  const [data, setData] = useState<Row[]>([]);
  const [derived, setDerived] = useState<DerivedRow[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const timerRef = useRef<number | null>(null);

  // ✅ 업로드 없이 자동 로드
  useEffect(() => {
    let cancelled = false;

    async function loadCSV() {
      const res = await fetch("/data/window_features_with_p.csv", {
        cache: "no-store",
      });
      if (!res.ok) {
        throw new Error(`CSV 로드 실패: ${res.status} ${res.statusText}`);
      }
      const text = await res.text();
      const raw = parseCSV(text);

      const parsed: Row[] = raw
        .map((r, i) => {
          const group = String(r["group"] ?? "");
          const subject = toNumber(r["subject"]) ?? 0;
          const file = String(r["file"] ?? "");

          const t0 = toNumber(r["t0"]) ?? i;
          const t1 = toNumber(r["t1"]) ?? i;

          const f_act = toNumber(r["f_act"]) ?? 0;
          const f_comp = toNumber(r["f_comp"]) ?? 0;
          const f_inst = toNumber(r["f_inst"]) ?? 0;

          const Z_act = toNumber(r["Z_act"]) ?? 0;
          const Z_comp = toNumber(r["Z_comp"]) ?? 0;
          const Z_inst = toNumber(r["Z_inst"]) ?? 0;

          const p = clamp01(toNumber(r["p"]) ?? 0);

          return {
            group,
            subject,
            file,
            t0,
            t1,
            f_act,
            f_comp,
            f_inst,
            Z_act,
            Z_comp,
            Z_inst,
            p,
            idx: i,
          };
        })
        .filter((r) => r.file.length > 0);

      // 파일별 정렬 + 초기 window drop
      const buckets = new Map<string, Row[]>();
      for (const r of parsed) {
        const key = `${r.group}::${r.subject}::${r.file}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key)!.push(r);
      }

      const kept: Row[] = [];
      for (const rows of buckets.values()) {
        rows.sort((a, b) => a.t0 - b.t0);
        kept.push(...rows.slice(dropPerFile));
      }

      // 전체 정렬: 파일 단위로 묶이면서 시간 순서(t0) 기준
      kept.sort((a, b) => {
        const ka = `${a.group}::${a.subject}::${a.file}`;
        const kb = `${b.group}::${b.subject}::${b.file}`;
        if (ka < kb) return -1;
        if (ka > kb) return 1;
        return a.t0 - b.t0;
      });

      const normalized = kept.map((r, i) => ({ ...r, idx: i }));

      if (!cancelled) {
        setData(normalized);
        setCurrentIdx(0);
        setIsPlaying(false);
      }
    }

    loadCSV().catch((e) => {
      console.error(e);
      // 로드 실패 시 빈 상태 유지 (화면에 경고 표시는 아래에서 처리)
    });

    return () => {
      cancelled = true;
    };
  }, [dropPerFile]);

  // T_abs 계산 (Healthy p 95th)
  const T_abs = useMemo(() => {
    if (!useHealthyPercentile) return T_abs_fixed;
    if (data.length === 0) return T_abs_fixed;

    const healthyP = data
      .filter((r) => r.group.toLowerCase() === "healthy")
      .map((r) => r.p)
      .filter((v) => Number.isFinite(v))
      .sort((a, b) => a - b);

    if (healthyP.length < 50) return T_abs_fixed; // 표본 부족 시 고정값 사용
    return clamp01(percentile(healthyP, T_abs_percentile));
  }, [useHealthyPercentile, T_abs_fixed, data]);

  // ✅ derived 계산(파일 단위 리셋)
  useEffect(() => {
    if (data.length === 0) {
      setDerived([]);
      return;
    }
    const d = computeDerivedPerFile(data, alpha, k_s, S_mid, T_min, T_base);
    setDerived(d);
  }, [data, alpha, k_s, S_mid, T_min, T_base]);

  // 게이팅 + 임피던스 + 채터링 방지
  const gating = useMemo(() => {
    if (derived.length === 0) {
      return {
        mode: [] as Mode[],
        sub: [] as SubMode[],
        K: [] as number[],
        D: [] as number[],
        K_guide: [] as number[],
        eps: [] as number[],
        margin: [] as number[],
      };
    }

    const mode: Mode[] = [];
    const sub: SubMode[] = [];
    const K_arr: number[] = [];
    const D_arr: number[] = [];
    const Kg_arr: number[] = [];
    const eps_arr: number[] = [];
    const margin_arr: number[] = [];

    let currentMode: Mode = "NORMAL";
    let hold = 0;
    let prevKey = "";

    for (let i = 0; i < derived.length; i++) {
      const r = derived[i];

      // 파일 경계에서: 채터링 억제 상태(hold)도 리셋하는 게 특허 의미에 더 부합
      if (r.key !== prevKey) {
        prevKey = r.key;
        currentMode = "NORMAL";
        hold = 0;
      }

      const pE = r.pEma;
      const Ta = r.T_adapt;

      // 히스테리시스
      const Ta_in = Ta;
      const Ta_out = Math.max(0, Ta - hyst);
      const Tabs_in = T_abs;
      const Tabs_out = Math.max(0, T_abs - hyst);

      const wantCritical = pE >= Tabs_in;
      const wantAdaptive = pE >= Ta_in && pE < Tabs_in;
      const wantNormal = pE < Ta_out;

      if (hold > 0) {
        hold -= 1;
      } else {
        if (currentMode === "CRITICAL") {
          if (pE < Tabs_out) {
            currentMode = pE >= Ta_in ? "ADAPTIVE" : "NORMAL";
            hold = minHoldWindows;
          }
        } else if (currentMode === "ADAPTIVE") {
          if (wantCritical) {
            currentMode = "CRITICAL";
            hold = minHoldWindows;
          } else if (wantNormal) {
            currentMode = "NORMAL";
            hold = minHoldWindows;
          }
        } else {
          if (wantCritical) {
            currentMode = "CRITICAL";
            hold = minHoldWindows;
          } else if (wantAdaptive) {
            currentMode = "ADAPTIVE";
            hold = minHoldWindows;
          }
        }
      }

      // 원인 분리(Z-score)
      let sm: SubMode = "NONE";
      if (r.Z_inst >= theta_inst) sm = "DAMPING";
      else if (r.Z_comp >= theta_comp) sm = "CONSTRAINT";
      else if (r.Z_act >= theta_act) sm = "ASSIST";

      // margin
      const m = pE - Ta;
      margin_arr.push(m);

      // 연속 임피던스 (명세서 예)
      let Kt = K0 + gammaK * Math.max(0, m);
      let Dt = D0 + gammaD * Math.max(0, m);
      let Kguide = 0;
      let eps = epsilon0;

      if (currentMode === "CRITICAL") {
        // 안전모드: 보수적으로 최소값에 가깝게 고정(시뮬레이션 표현)
        Kt = Math.max(0.1, Math.min(Kt, K0));
        Dt = Math.max(0.1, Math.min(Dt, D0));
        Kguide = 0;
        eps = epsilon0;
        sm = "NONE";
      } else if (currentMode === "ADAPTIVE") {
        if (sm === "DAMPING") {
          // 불안정: D 우선 증가
          Dt = Dt + guideGain * Math.max(0, m);
        } else if (sm === "CONSTRAINT") {
          // 보상: 궤적 구속
          Kguide = guideGain * (1 + Math.max(0, m));
          eps = Math.max(
            epsilonMin,
            epsilon0 * (1 - 0.5 * clamp01(Math.max(0, m)))
          );
        } else if (sm === "ASSIST") {
          // 과활성: K 감소(보조 증가)
          Kt = Math.max(0.1, Kt * (1 - assistKDown));
        }
      } else {
        // NORMAL
        Kguide = 0;
        eps = epsilon0;
        sm = "NONE";
      }

      mode.push(currentMode);
      sub.push(sm);
      K_arr.push(Kt);
      D_arr.push(Dt);
      Kg_arr.push(Kguide);
      eps_arr.push(eps);
    }

    return {
      mode,
      sub,
      K: K_arr,
      D: D_arr,
      K_guide: Kg_arr,
      eps: eps_arr,
      margin: margin_arr,
    };
  }, [
    derived,
    T_abs,
    hyst,
    minHoldWindows,
    theta_act,
    theta_comp,
    theta_inst,
    K0,
    D0,
    gammaK,
    gammaD,
    assistKDown,
    guideGain,
    epsilon0,
    epsilonMin,
  ]);

  // 재생
  useEffect(() => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (isPlaying && currentIdx < derived.length - 1) {
      timerRef.current = window.setTimeout(
        () => setCurrentIdx((p) => p + 1),
        50
      );
    } else if (currentIdx >= derived.length - 1 && derived.length > 0) {
      setIsPlaying(false);
    }
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [isPlaying, currentIdx, derived.length]);

  const current = derived[currentIdx];

  // 그래프용 (다운샘플링)
  const chart = useMemo(() => {
    if (derived.length === 0) return null;

    const pRaw = derived.map((r) => r.p);
    const pEma = derived.map((r) => r.pEma);
    const Tadapt = derived.map((r) => r.T_adapt);

    const maxPoints = 2000; // 성능 보호
    return {
      pRawDS: downsampleSeries(pRaw, maxPoints),
      pEmaDS: downsampleSeries(pEma, maxPoints),
      TadaptDS: downsampleSeries(Tadapt, maxPoints),
    };
  }, [derived]);

  const modeLabel = (m: Mode) =>
    m === "CRITICAL"
      ? "Critical Safety Mode"
      : m === "ADAPTIVE"
      ? "Adaptive Intervention Mode"
      : "Normal Mode";
  const subLabel = (s: SubMode) =>
    s === "DAMPING"
      ? "Damping Mode (D↑)"
      : s === "CONSTRAINT"
      ? "Constraint Mode (K_guide↑, ε↓)"
      : s === "ASSIST"
      ? "Assist Mode (K↓)"
      : "-";

  const modeColor: Record<Mode, string> = {
    NORMAL: "#16a34a",
    ADAPTIVE: "#f97316",
    CRITICAL: "#dc2626",
  };
  const subColor: Record<SubMode, string> = {
    NONE: "#6b7280",
    ASSIST: "#2563eb",
    CONSTRAINT: "#ea580c",
    DAMPING: "#7c3aed",
  };

  const loadOk = derived.length > 0;

  return (
    <div
      style={{
        background: "#0b1220",
        color: "white",
        minHeight: "100vh",
        padding: 20,
      }}
    >
      <div
        style={{
          maxWidth: 1200,
          margin: "0 auto",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: 28 }}>
            Rehab Simulator (TSX, CSV Auto-Load)
          </h1>
          <div style={{ color: "#94a3b8", marginTop: 6 }}>
            Dual Threshold (T_abs, T_adapt) + Z-score + Chattering Suppression +
            Impedance Update
          </div>
          <div style={{ color: "#94a3b8", marginTop: 6, fontSize: 13 }}>
            CSV 경로: <code>/public/data/window_features_with_p.csv</code>
          </div>
        </div>

        {!loadOk && (
          <div
            style={{
              background: "#111827",
              border: "1px solid #334155",
              padding: 14,
              borderRadius: 10,
              color: "#fca5a5",
            }}
          >
            CSV를 불러오지 못했습니다. 파일이{" "}
            <code>public/data/window_features_with_p.csv</code>에 있는지
            확인하십시오.
          </div>
        )}

        {loadOk && (
          <div
            style={{
              background: "#111827",
              border: "1px solid #334155",
              padding: 14,
              borderRadius: 10,
            }}
          >
            <div
              style={{
                display: "flex",
                gap: 14,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <button
                onClick={() => setIsPlaying((p) => !p)}
                style={{
                  background: "#2563eb",
                  border: 0,
                  color: "white",
                  padding: "10px 14px",
                  borderRadius: 10,
                  cursor: "pointer",
                }}
              >
                {isPlaying ? "Pause" : "Play"}
              </button>
              <button
                onClick={() => {
                  setCurrentIdx(0);
                  setIsPlaying(false);
                }}
                style={{
                  background: "#334155",
                  border: 0,
                  color: "white",
                  padding: "10px 14px",
                  borderRadius: 10,
                  cursor: "pointer",
                }}
              >
                Reset
              </button>

              <div style={{ flex: 1, minWidth: 280 }}>
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, derived.length - 1)}
                  value={Math.min(currentIdx, Math.max(0, derived.length - 1))}
                  onChange={(e) => setCurrentIdx(Number(e.target.value))}
                  style={{ width: "100%" }}
                />
                <div style={{ color: "#94a3b8", fontSize: 13, marginTop: 6 }}>
                  window: {currentIdx + 1} / {derived.length}{" "}
                  <span style={{ marginLeft: 10 }}>
                    T_abs: <b>{T_abs.toFixed(3)}</b> (
                    {useHealthyPercentile ? "Healthy 95th" : "fixed"})
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Chart */}
        {loadOk && chart && (
          <div
            style={{
              background: "#111827",
              border: "1px solid #334155",
              padding: 14,
              borderRadius: 10,
            }}
          >
            <h2 style={{ margin: "0 0 10px 0", fontSize: 18 }}>
              p(t), EMA, Threshold
            </h2>
            <div
              style={{ background: "#0b1220", borderRadius: 10, padding: 10 }}
            >
              <svg width="100%" height="260" viewBox="0 0 1000 260">
                {/* T_abs line */}
                <line
                  x1={0}
                  y1={260 * (1 - T_abs)}
                  x2={1000}
                  y2={260 * (1 - T_abs)}
                  stroke="#ef4444"
                  strokeWidth={2}
                  strokeDasharray="6,6"
                />

                {/* T_adapt (downsampled) */}
                <polyline
                  points={chart.TadaptDS.map(
                    (p) =>
                      `${(p.i / Math.max(1, derived.length - 1)) * 1000},${
                        260 * (1 - p.v)
                      }`
                  ).join(" ")}
                  fill="none"
                  stroke="#f97316"
                  strokeWidth={2}
                  strokeDasharray="6,6"
                />

                {/* p raw */}
                <polyline
                  points={chart.pRawDS
                    .map(
                      (p) =>
                        `${(p.i / Math.max(1, derived.length - 1)) * 1000},${
                          260 * (1 - p.v)
                        }`
                    )
                    .join(" ")}
                  fill="none"
                  stroke="rgba(148,163,184,0.45)"
                  strokeWidth={1}
                />

                {/* p EMA */}
                <polyline
                  points={chart.pEmaDS
                    .map(
                      (p) =>
                        `${(p.i / Math.max(1, derived.length - 1)) * 1000},${
                          260 * (1 - p.v)
                        }`
                    )
                    .join(" ")}
                  fill="none"
                  stroke="#3b82f6"
                  strokeWidth={3}
                />

                {/* current index marker */}
                <line
                  x1={(currentIdx / Math.max(1, derived.length - 1)) * 1000}
                  y1={0}
                  x2={(currentIdx / Math.max(1, derived.length - 1)) * 1000}
                  y2={260}
                  stroke="white"
                  strokeWidth={2}
                />
              </svg>
            </div>
          </div>
        )}

        {/* Current panel */}
        {loadOk && current && (
          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}
          >
            <div
              style={{
                background: "#111827",
                border: "1px solid #334155",
                padding: 14,
                borderRadius: 10,
              }}
            >
              <h2 style={{ margin: "0 0 10px 0", fontSize: 18 }}>Current</h2>
              <div style={{ color: "#94a3b8", fontSize: 13 }}>
                key: <code>{current.key}</code>
              </div>

              <div
                style={{
                  marginTop: 10,
                  display: "grid",
                  gridTemplateColumns: "170px 1fr",
                  rowGap: 6,
                  columnGap: 10,
                  fontSize: 14,
                }}
              >
                <div style={{ color: "#94a3b8" }}>p(raw)</div>
                <div>
                  <code>{current.p.toFixed(3)}</code>
                </div>

                <div style={{ color: "#94a3b8" }}>p(EMA)</div>
                <div>
                  <code>{current.pEma.toFixed(3)}</code>
                </div>

                <div style={{ color: "#94a3b8" }}>slope</div>
                <div>
                  <code>{current.slope.toFixed(4)}</code>
                </div>

                <div style={{ color: "#94a3b8" }}>T_adapt</div>
                <div>
                  <code style={{ color: "#fdba74" }}>
                    {current.T_adapt.toFixed(3)}
                  </code>
                </div>

                <div style={{ color: "#94a3b8" }}>T_abs</div>
                <div>
                  <code style={{ color: "#fca5a5" }}>{T_abs.toFixed(3)}</code>
                </div>

                <div style={{ color: "#94a3b8" }}>Mode</div>
                <div>
                  <span
                    style={{
                      background: modeColor[gating.mode[currentIdx]],
                      padding: "3px 10px",
                      borderRadius: 999,
                      fontSize: 12,
                      fontWeight: 700,
                    }}
                  >
                    {modeLabel(gating.mode[currentIdx])}
                  </span>
                </div>

                <div style={{ color: "#94a3b8" }}>Sub</div>
                <div>
                  <span
                    style={{
                      background: subColor[gating.sub[currentIdx]],
                      padding: "3px 10px",
                      borderRadius: 999,
                      fontSize: 12,
                      fontWeight: 700,
                    }}
                  >
                    {subLabel(gating.sub[currentIdx])}
                  </span>
                </div>

                <div style={{ color: "#94a3b8" }}>m = pEma - T_adapt</div>
                <div>
                  <code>{gating.margin[currentIdx].toFixed(3)}</code>
                </div>

                <div style={{ color: "#94a3b8" }}>K(t)</div>
                <div>
                  <code>{gating.K[currentIdx].toFixed(3)}</code>
                </div>

                <div style={{ color: "#94a3b8" }}>D(t)</div>
                <div>
                  <code>{gating.D[currentIdx].toFixed(3)}</code>
                </div>

                <div style={{ color: "#94a3b8" }}>K_guide</div>
                <div>
                  <code>{gating.K_guide[currentIdx].toFixed(3)}</code>
                </div>

                <div style={{ color: "#94a3b8" }}>ε</div>
                <div>
                  <code>{gating.eps[currentIdx].toFixed(3)}</code>
                </div>
              </div>
            </div>

            <div
              style={{
                background: "#111827",
                border: "1px solid #334155",
                padding: 14,
                borderRadius: 10,
              }}
            >
              <h2 style={{ margin: "0 0 10px 0", fontSize: 18 }}>
                Z-score & Features
              </h2>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "170px 1fr",
                  rowGap: 6,
                  columnGap: 10,
                  fontSize: 14,
                }}
              >
                <div style={{ color: "#94a3b8" }}>Z_act</div>
                <div>
                  <code>{current.Z_act.toFixed(2)}</code>
                </div>

                <div style={{ color: "#94a3b8" }}>Z_comp</div>
                <div>
                  <code>{current.Z_comp.toFixed(2)}</code>
                </div>

                <div style={{ color: "#94a3b8" }}>Z_inst</div>
                <div>
                  <code>{current.Z_inst.toFixed(2)}</code>
                </div>

                <div style={{ color: "#94a3b8" }}>f_act</div>
                <div>
                  <code>{current.f_act.toFixed(4)}</code>
                </div>

                <div style={{ color: "#94a3b8" }}>f_comp</div>
                <div>
                  <code>{current.f_comp.toFixed(4)}</code>
                </div>

                <div style={{ color: "#94a3b8" }}>f_inst</div>
                <div>
                  <code>{current.f_inst.toFixed(4)}</code>
                </div>

                <div style={{ color: "#94a3b8" }}>t0, t1</div>
                <div>
                  <code>
                    {current.t0.toFixed(3)} ~ {current.t1.toFixed(3)}
                  </code>
                </div>
              </div>

              <div
                style={{
                  marginTop: 14,
                  color: "#94a3b8",
                  fontSize: 13,
                  lineHeight: 1.5,
                }}
              >
                원인 분리 우선순위: <b>불안정(Z_inst)</b> → <b>보상(Z_comp)</b>{" "}
                → <b>과활성(Z_act)</b>
                <br />
                (특허 설명의 “불안정 감쇠 우선” 반영)
              </div>
            </div>
          </div>
        )}

        {/* Settings */}
        {loadOk && (
          <div
            style={{
              background: "#111827",
              border: "1px solid #334155",
              padding: 14,
              borderRadius: 10,
            }}
          >
            <h2 style={{ margin: "0 0 10px 0", fontSize: 18 }}>Settings</h2>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr 1fr",
                gap: 12,
              }}
            >
              <div
                style={{ background: "#0b1220", padding: 12, borderRadius: 10 }}
              >
                <div style={{ fontWeight: 700, marginBottom: 8 }}>
                  Threshold
                </div>

                <label
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                    fontSize: 14,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={useHealthyPercentile}
                    onChange={(e) => setUseHealthyPercentile(e.target.checked)}
                  />
                  <span>Healthy 95th 사용</span>
                </label>

                {!useHealthyPercentile && (
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      marginTop: 8,
                      fontSize: 14,
                    }}
                  >
                    <span style={{ color: "#94a3b8" }}>T_abs fixed</span>
                    <input
                      value={T_abs_fixed}
                      onChange={(e) => setT_abs_fixed(Number(e.target.value))}
                      type="number"
                      step="0.01"
                      style={{ width: 100 }}
                    />
                  </div>
                )}

                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    marginTop: 8,
                    fontSize: 14,
                  }}
                >
                  <span style={{ color: "#94a3b8" }}>drop/file</span>
                  <input
                    value={dropPerFile}
                    onChange={(e) => setDropPerFile(Number(e.target.value))}
                    type="number"
                    step="1"
                    style={{ width: 100 }}
                  />
                </div>
              </div>

              <div
                style={{ background: "#0b1220", padding: 12, borderRadius: 10 }}
              >
                <div style={{ fontWeight: 700, marginBottom: 8 }}>
                  T_adapt (sigmoid)
                </div>

                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    marginTop: 6,
                    fontSize: 14,
                  }}
                >
                  <span style={{ color: "#94a3b8" }}>T_base</span>
                  <input
                    value={T_base}
                    onChange={(e) => setT_base(Number(e.target.value))}
                    type="number"
                    step="0.01"
                    style={{ width: 100 }}
                  />
                </div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    marginTop: 6,
                    fontSize: 14,
                  }}
                >
                  <span style={{ color: "#94a3b8" }}>T_min</span>
                  <input
                    value={T_min}
                    onChange={(e) => setT_min(Number(e.target.value))}
                    type="number"
                    step="0.01"
                    style={{ width: 100 }}
                  />
                </div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    marginTop: 6,
                    fontSize: 14,
                  }}
                >
                  <span style={{ color: "#94a3b8" }}>k_s</span>
                  <input
                    value={k_s}
                    onChange={(e) => setK_s(Number(e.target.value))}
                    type="number"
                    step="1"
                    style={{ width: 100 }}
                  />
                </div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    marginTop: 6,
                    fontSize: 14,
                  }}
                >
                  <span style={{ color: "#94a3b8" }}>S_mid</span>
                  <input
                    value={S_mid}
                    onChange={(e) => setS_mid(Number(e.target.value))}
                    type="number"
                    step="0.001"
                    style={{ width: 100 }}
                  />
                </div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    marginTop: 6,
                    fontSize: 14,
                  }}
                >
                  <span style={{ color: "#94a3b8" }}>alpha(EMA)</span>
                  <input
                    value={alpha}
                    onChange={(e) => setAlpha(Number(e.target.value))}
                    type="number"
                    step="0.05"
                    style={{ width: 100 }}
                  />
                </div>
              </div>

              <div
                style={{ background: "#0b1220", padding: 12, borderRadius: 10 }}
              >
                <div style={{ fontWeight: 700, marginBottom: 8 }}>
                  Chattering & Z
                </div>

                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    marginTop: 6,
                    fontSize: 14,
                  }}
                >
                  <span style={{ color: "#94a3b8" }}>hyst</span>
                  <input
                    value={hyst}
                    onChange={(e) => setHyst(Number(e.target.value))}
                    type="number"
                    step="0.01"
                    style={{ width: 100 }}
                  />
                </div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    marginTop: 6,
                    fontSize: 14,
                  }}
                >
                  <span style={{ color: "#94a3b8" }}>min hold</span>
                  <input
                    value={minHoldWindows}
                    onChange={(e) => setMinHoldWindows(Number(e.target.value))}
                    type="number"
                    step="1"
                    style={{ width: 100 }}
                  />
                </div>

                <div
                  style={{
                    borderTop: "1px solid #1f2937",
                    marginTop: 10,
                    paddingTop: 10,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      marginTop: 6,
                      fontSize: 14,
                    }}
                  >
                    <span style={{ color: "#94a3b8" }}>θ_act</span>
                    <input
                      value={theta_act}
                      onChange={(e) => setThetaAct(Number(e.target.value))}
                      type="number"
                      step="0.1"
                      style={{ width: 100 }}
                    />
                  </div>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      marginTop: 6,
                      fontSize: 14,
                    }}
                  >
                    <span style={{ color: "#94a3b8" }}>θ_comp</span>
                    <input
                      value={theta_comp}
                      onChange={(e) => setThetaComp(Number(e.target.value))}
                      type="number"
                      step="0.1"
                      style={{ width: 100 }}
                    />
                  </div>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      marginTop: 6,
                      fontSize: 14,
                    }}
                  >
                    <span style={{ color: "#94a3b8" }}>θ_inst</span>
                    <input
                      value={theta_inst}
                      onChange={(e) => setThetaInst(Number(e.target.value))}
                      type="number"
                      step="0.1"
                      style={{ width: 100 }}
                    />
                  </div>
                </div>
              </div>
            </div>

            <div style={{ marginTop: 12, color: "#94a3b8", fontSize: 13 }}>
              주의: 이 시뮬레이터는 <b>전처리 CSV에 이미 포함된 p</b>를
              사용합니다(브라우저에서 joblib 추론 없음).
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
