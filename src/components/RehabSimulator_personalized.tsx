import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * ✅ 입력 CSV (public/data/)
 * - window_features_with_p_ML.csv  (p_hat, sub_tree 포함)
 *
 * ✅ 필수 컬럼:
 * group, subject, file, t0, t1, f_act, f_comp, f_inst, Z_act, Z_comp, Z_inst, p
 *
 * ✅ (A안 ML 추가) 선택 컬럼:
 * - p_hat: SVM 예측 위험도 (0~1). 있으면 p 대신 사용
 * - sub_tree: Decision Tree 예측 SubMode ("ASSIST"|"CONSTRAINT"|"DAMPING"|"NONE"). 있으면 Z-rule 대신 사용
 */

type Mode = "NORMAL" | "ADAPTIVE" | "CRITICAL";
type SubMode = "NONE" | "ASSIST" | "CONSTRAINT" | "DAMPING";

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

  // --- 위험도 입력 ---
  p: number; // 실제 시뮬레이터에서 사용할 위험도(0~1). p_hat이 있으면 p_hat으로 덮어씀
  p_raw_in: number; // CSV 원본 p

  // --- (선택) ML 위험도 ---
  p_hat: number | null; // SVM 예측 위험도(0~1), 없으면 null

  p_hat_cal: number | null; // SVM 예측 위험도 보정값, 없으면 null

  // --- (선택) Tree SubMode ---
  sub_tree: SubMode | null; // Decision Tree 예측 SubMode, 없으면 null

  idx: number;
};

type DerivedRow = Row & {
  key: string; // group::subject::file
  pEma: number; // EMA(p)
  slope: number; // pEma(t)-pEma(t-1) within file
  T_adapt: number; // sigmoid(slope)
};

type PersonalThreshold = {
  T_base_user: number;
  T_min_user: number;
  severity: number;
};

function clamp(x: number, lo: number, hi: number) {
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

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

function parseSubMode(v: unknown): SubMode | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toUpperCase();
  if (!s) return null;
  if (s === "NONE") return "NONE";
  if (s === "ASSIST") return "ASSIST";
  if (s === "CONSTRAINT") return "CONSTRAINT";
  if (s === "DAMPING") return "DAMPING";
  return null;
}

/**
 * CSV 파서: 기본적인 quoted field 지원(쉼표/줄바꿈 포함 가능).
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
      if (c === "\r" && next === "\n") i++;
      pushField();
      pushRow();
      continue;
    }
    field += c;
  }
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
 * ✅ 파일 단위 EMA 리셋 + slope 계산 + T_adapt 계산
 */
function computeDerivedPerFile(
  rows: Row[],
  alpha: number,
  k_s: number,
  S_mid: number,
  getTMin: (r: Row) => number,
  getTBase: (r: Row) => number
): DerivedRow[] {
  const out: DerivedRow[] = [];

  let currentKey = "";
  let prevEma = 0;
  let prevEmaForSlope = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const key = `${r.group}::${r.subject}::${r.file}`;

    const T_min = getTMin(r);
    const T_base = getTBase(r);

    if (key !== currentKey) {
      currentKey = key;
      prevEma = r.p;
      prevEmaForSlope = prevEma;
      const slope = 0;
      const denom = 1 + Math.exp(k_s * (slope - S_mid));
      const T_adapt = T_min + (T_base - T_min) / denom;

      out.push({ ...r, key, pEma: prevEma, slope, T_adapt });
      continue;
    }

    prevEma = alpha * r.p + (1 - alpha) * prevEma;
    const slope = prevEma - prevEmaForSlope;
    prevEmaForSlope = prevEma;

    const denom = 1 + Math.exp(k_s * (slope - S_mid));
    const T_adapt = T_min + (T_base - T_min) / denom;

    out.push({ ...r, key, pEma: prevEma, slope, T_adapt });
  }

  return out;
}

function downsampleSeries(series: number[], maxPoints: number) {
  const n = series.length;
  if (n <= maxPoints) return series.map((v, i) => ({ i, v }));
  const step = (n - 1) / (maxPoints - 1);
  const out: { i: number; v: number }[] = [];
  for (let k = 0; k < maxPoints; k++) {
    const idx = Math.round(k * step);
    out.push({ i: idx, v: series[idx] });
  }
  return out;
}

export default function RehabSimulator_personalized() {
  // ✅ CSV 경로를 한 곳에서 관리 (UI 표시/로딩 메시지/fetch 모두 동일)
  const CSV_PATH = "/data/window_features_with_p_ML.csv";

  // ===== 파라미터 =====
  const [alpha, setAlpha] = useState(0.3);

  const [k_s, setK_s] = useState(10);
  const [S_mid, setS_mid] = useState(0.01);
  const [T_base, setT_base] = useState(0.5);
  const [T_min, setT_min] = useState(0.3);

  // (A안) ML 위험도 사용 여부: p_hat 있으면 그걸 p로 사용
  const [useMLRisk, setUseMLRisk] = useState(true);

  // (A안) Tree SubMode 사용 여부: sub_tree 있으면 그걸 사용, 없으면 Z-rule fallback
  const [useTreeSubMode, setUseTreeSubMode] = useState(true);

  // 개인화(바이오마커 → 개인 기준 임계치)
  const [usePersonalThreshold, setUsePersonalThreshold] = useState(true);
  const [personalBySubject, setPersonalBySubject] = useState<
    Map<number, PersonalThreshold>
  >(new Map());

  // 바이오마커→severity 가중치/매핑
  const [w_rms, setW_rms] = useState(0.35);
  const [w_cv, setW_cv] = useState(0.35);
  const [w_mf, setW_mf] = useState(0.2); // MF 낮을수록 위험 → -z_mf
  const [w_active, setW_active] = useState(0.1);
  const [a_base, setA_base] = useState(0.06);
  const [b_min, setB_min] = useState(0.04);

  const T_base_bounds: [number, number] = [0.35, 0.8];
  const T_min_bounds: [number, number] = [0.1, 0.6];

  // 절대 임계치: Healthy 95th 자동 + fallback fixed
  const [useHealthyPercentile, setUseHealthyPercentile] = useState(true);
  const [T_abs_fixed, setT_abs_fixed] = useState(0.85);
  const T_abs_percentile = 95;

  // 파일별 초기 window 제거(옵션)
  const [dropPerFile, setDropPerFile] = useState(5);

  // Z-score 임계치(규칙 fallback에만 사용)
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
      const res = await fetch(CSV_PATH, { cache: "no-store" });
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

          // 원본 p
          const p_raw_in = clamp01(toNumber(r["p"]) ?? 0);

          // (A안) SVM 예측 위험도 p_hat (없으면 null)
          const p_hat_val = toNumber(r["p_hat"]);
          const p_hat = p_hat_val === null ? null : clamp01(p_hat_val);

          const p_hat_cal_val = toNumber(r["p_hat_cal"]);
          const p_hat_cal =
            p_hat_cal_val === null ? null : clamp01(p_hat_cal_val);

          // (A안) Tree 예측 SubMode (없으면 null)
          const sub_tree = parseSubMode(r["sub_tree"]);

          const p_used = useMLRisk
            ? p_hat_cal !== null
              ? p_hat_cal
              : p_hat !== null
              ? p_hat
              : p_raw_in
            : p_raw_in;

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

            p: p_used,
            p_raw_in,
            p_hat,
            p_hat_cal,
            sub_tree,

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
      if (!cancelled) {
        setData([]);
        setDerived([]);
        setIsPlaying(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [CSV_PATH, dropPerFile, useMLRisk]);

  // ✅ 바이오마커 로드(개인 임계치용)
  useEffect(() => {
    let cancelled = false;

    async function loadBiomarkers() {
      const [resBm, resAct] = await Promise.all([
        fetch("/data/biomarkers_all_subjects.csv", { cache: "no-store" }),
        fetch("/data/activation_summary_all_subjects.csv", {
          cache: "no-store",
        }),
      ]);

      if (!resBm.ok) {
        throw new Error(
          `biomarkers CSV 로드 실패: ${resBm.status} ${resBm.statusText}`
        );
      }
      if (!resAct.ok) {
        throw new Error(
          `activation CSV 로드 실패: ${resAct.status} ${resAct.statusText}`
        );
      }

      const [txtBm, txtAct] = await Promise.all([resBm.text(), resAct.text()]);
      const bmRaw = parseCSV(txtBm);
      const actRaw = parseCSV(txtAct);

      type Agg = {
        group: string;
        subject: number;
        rms_sum: number;
        cv_sum: number;
        mf_sum: number;
        n: number;
        active_sum: number;
        n_active: number;
      };

      const agg = new Map<number, Agg>();

      const getAgg = (group: string, subject: number) => {
        if (!agg.has(subject)) {
          agg.set(subject, {
            group,
            subject,
            rms_sum: 0,
            cv_sum: 0,
            mf_sum: 0,
            n: 0,
            active_sum: 0,
            n_active: 0,
          });
        }
        return agg.get(subject)!;
      };

      for (const r of bmRaw) {
        const group = String(r["Group"] ?? r["group"] ?? "");
        const subject = toNumber(r["Subject"] ?? r["subject"]) ?? null;
        if (subject === null) continue;

        const rms = toNumber(r["RMS"] ?? r["rms"]);
        const cv = toNumber(r["CV"] ?? r["cv"]);
        const mf = toNumber(r["MF"] ?? r["mf"]);
        if (rms === null || cv === null || mf === null) continue;

        const a = getAgg(group, subject);
        a.rms_sum += rms;
        a.cv_sum += cv;
        a.mf_sum += mf;
        a.n += 1;
      }

      for (const r of actRaw) {
        const group = String(r["Group"] ?? r["group"] ?? "");
        const subject = toNumber(r["Subject"] ?? r["subject"]) ?? null;
        if (subject === null) continue;

        const ar = toNumber(
          r["active_ratio"] ?? r["Active_Ratio"] ?? r["activeRatio"]
        );
        if (ar === null) continue;

        const a = getAgg(group, subject);
        a.active_sum += ar;
        a.n_active += 1;
      }

      const healthy = Array.from(agg.values()).filter((a) =>
        a.group.toLowerCase().includes("healthy")
      );

      if (healthy.length < 3) {
        if (!cancelled) setPersonalBySubject(new Map());
        return;
      }

      const toMean = (x_sum: number, n: number) => (n > 0 ? x_sum / n : NaN);

      const hrms = healthy
        .map((a) => toMean(a.rms_sum, a.n))
        .filter(Number.isFinite);
      const hcv = healthy
        .map((a) => toMean(a.cv_sum, a.n))
        .filter(Number.isFinite);
      const hmf = healthy
        .map((a) => toMean(a.mf_sum, a.n))
        .filter(Number.isFinite);
      const har = healthy
        .map((a) => toMean(a.active_sum, a.n_active))
        .filter(Number.isFinite);

      const mean = (xs: number[]) =>
        xs.reduce((s, v) => s + v, 0) / Math.max(1, xs.length);
      const std = (xs: number[]) => {
        if (xs.length < 2) return 1;
        const m = mean(xs);
        const v =
          xs.reduce((s, x) => s + (x - m) * (x - m), 0) /
          Math.max(1, xs.length - 1);
        const sd = Math.sqrt(v);
        return sd > 1e-12 ? sd : 1;
      };

      const mu_rms = mean(hrms),
        sd_rms = std(hrms);
      const mu_cv = mean(hcv),
        sd_cv = std(hcv);
      const mu_mf = mean(hmf),
        sd_mf = std(hmf);
      const mu_ar = mean(har),
        sd_ar = std(har);

      const map = new Map<number, PersonalThreshold>();

      for (const a of agg.values()) {
        const rms = toMean(a.rms_sum, a.n);
        const cv = toMean(a.cv_sum, a.n);
        const mf = toMean(a.mf_sum, a.n);
        const ar = toMean(a.active_sum, a.n_active);

        if (
          !Number.isFinite(rms) ||
          !Number.isFinite(cv) ||
          !Number.isFinite(mf)
        )
          continue;

        const ar_filled = Number.isFinite(ar) ? ar : mu_ar;

        const z_rms = (rms - mu_rms) / sd_rms;
        const z_cv = (cv - mu_cv) / sd_cv;
        const z_mf = (mf - mu_mf) / sd_mf;
        const z_ar = (ar_filled - mu_ar) / sd_ar;

        const severity =
          w_rms * z_rms + w_cv * z_cv + w_mf * -z_mf + w_active * z_ar;

        let T_base_user = T_base - a_base * severity;
        let T_min_user = T_min - b_min * severity;

        T_base_user = clamp(T_base_user, T_base_bounds[0], T_base_bounds[1]);
        T_min_user = clamp(T_min_user, T_min_bounds[0], T_min_bounds[1]);

        if (T_min_user >= T_base_user - 0.01) {
          T_min_user = Math.max(T_min_bounds[0], T_base_user - 0.01);
        }

        map.set(a.subject, { T_base_user, T_min_user, severity });
      }

      if (!cancelled) {
        setPersonalBySubject(map);
      }
    }

    loadBiomarkers().catch((e) => {
      console.error(e);
      if (!cancelled) setPersonalBySubject(new Map());
    });

    return () => {
      cancelled = true;
    };
  }, [T_base, T_min, w_rms, w_cv, w_mf, w_active, a_base, b_min]);

  // T_abs 계산 (Healthy p 95th) — 여기서의 p는 “현재 선택된 p”(p_hat 우선)가 반영됨
  const T_abs = useMemo(() => {
    if (!useHealthyPercentile) return T_abs_fixed;
    if (data.length === 0) return T_abs_fixed;

    const healthyP = data
      .filter((r) => r.group.toLowerCase() === "healthy")
      .map((r) => r.p_raw_in)
      .filter((v) => Number.isFinite(v))
      .sort((a, b) => a - b);

    if (healthyP.length < 50) return T_abs_fixed;
    return clamp01(percentile(healthyP, T_abs_percentile));
  }, [useHealthyPercentile, T_abs_fixed, data]);

  // ✅ derived 계산(파일 단위 리셋)
  useEffect(() => {
    if (data.length === 0) {
      setDerived([]);
      return;
    }
    const getTMin = (r: Row) => {
      if (!usePersonalThreshold) return T_min;
      const pt = personalBySubject.get(r.subject);
      return pt ? pt.T_min_user : T_min;
    };
    const getTBase = (r: Row) => {
      if (!usePersonalThreshold) return T_base;
      const pt = personalBySubject.get(r.subject);
      return pt ? pt.T_base_user : T_base;
    };
    const d = computeDerivedPerFile(data, alpha, k_s, S_mid, getTMin, getTBase);
    setDerived(d);
  }, [
    data,
    alpha,
    k_s,
    S_mid,
    T_min,
    T_base,
    usePersonalThreshold,
    personalBySubject,
  ]);

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

      // 파일 경계에서 리셋
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

      // ---- SubMode 결정 (A안) ----
      // 1) useTreeSubMode=true && r.sub_tree가 있으면 그걸 사용
      // 2) 없으면 기존 Z-score 규칙 fallback
      let sm: SubMode = "NONE";
      if (useTreeSubMode && r.sub_tree) {
        sm = r.sub_tree;
      } else {
        if (r.Z_inst >= theta_inst) sm = "DAMPING";
        else if (r.Z_comp >= theta_comp) sm = "CONSTRAINT";
        else if (r.Z_act >= theta_act) sm = "ASSIST";
        else sm = "NONE";
      }

      // margin
      const m = pE - Ta;
      margin_arr.push(m);

      // 연속 임피던스
      let Kt = K0 + gammaK * Math.max(0, m);
      let Dt = D0 + gammaD * Math.max(0, m);
      let Kguide = 0;
      let eps = epsilon0;

      if (currentMode === "CRITICAL") {
        // 안전모드: 보수적으로 제한
        Kt = Math.max(0.1, Math.min(Kt, K0));
        Dt = Math.max(0.1, Math.min(Dt, D0));
        Kguide = 0;
        eps = epsilon0;
        sm = "NONE";
      } else if (currentMode === "ADAPTIVE") {
        if (sm === "DAMPING") {
          Dt = Dt + guideGain * Math.max(0, m);
        } else if (sm === "CONSTRAINT") {
          Kguide = guideGain * (1 + Math.max(0, m));
          eps = Math.max(
            epsilonMin,
            epsilon0 * (1 - 0.5 * clamp01(Math.max(0, m)))
          );
        } else if (sm === "ASSIST") {
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
    useTreeSubMode,
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

    const pUsed = derived.map((r) => r.p_raw_in);
    const pEma = derived.map((r) => r.pEma);
    const Tadapt = derived.map((r) => r.T_adapt);

    const maxPoints = 2000;
    return {
      pUsedDS: downsampleSeries(pUsed, maxPoints),
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
            Rehab Simulator (SVM p_hat + Tree sub_tree, rule gating kept)
          </h1>
          <div style={{ color: "#94a3b8", marginTop: 6 }}>
            Dual Threshold (T_abs, T_adapt) + (optional) ML Risk p_hat +
            (optional) Tree SubMode + Chattering Suppression + Impedance Update
          </div>
          <div style={{ color: "#94a3b8", marginTop: 6, fontSize: 13 }}>
            CSV 경로: <code>{CSV_PATH}</code>
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
            CSV를 불러오는 중입니다. <code>{CSV_PATH}</code>
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

              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  color: "#e2e8f0",
                }}
              >
                <input
                  type="checkbox"
                  checked={useMLRisk}
                  onChange={(e) => setUseMLRisk(e.target.checked)}
                />
                <span>SVM p_hat 사용</span>
              </label>

              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  color: "#e2e8f0",
                }}
              >
                <input
                  type="checkbox"
                  checked={useTreeSubMode}
                  onChange={(e) => setUseTreeSubMode(e.target.checked)}
                />
                <span>Tree sub_tree 사용</span>
              </label>

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
              p(t) used, EMA, Threshold
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

                {/* T_adapt */}
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

                {/* p used */}
                <polyline
                  points={chart.pUsedDS
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

                {/* current marker */}
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
                <div style={{ color: "#94a3b8" }}>p used</div>
                <div>
                  <code>{current.p.toFixed(3)}</code>
                  <span
                    style={{ color: "#94a3b8", marginLeft: 8, fontSize: 12 }}
                  >
                    (raw p={current.p_raw_in.toFixed(3)}
                    {current.p_hat !== null
                      ? `, p_hat=${current.p_hat.toFixed(3)}`
                      : ", p_hat=NA"}
                    )
                  </span>
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
                  <span
                    style={{ color: "#94a3b8", marginLeft: 8, fontSize: 12 }}
                  >
                    (sub_tree={current.sub_tree ?? "NA"})
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
                Z-score & Features (fallback용)
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
                SubMode 결정 우선순위: <b>Tree(sub_tree)</b> 사용(옵션) → 없으면{" "}
                <b>Z-score 규칙</b> fallback
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
