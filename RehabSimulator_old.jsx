// import React, { useEffect, useMemo, useRef, useState } from "react";
// import { Play, Pause, RotateCcw } from "lucide-react";

// /**
//  * 입력 CSV (window_features_with_p.csv) 필수 컬럼:
//  * group, subject, file, t0, t1, f_act, f_comp, f_inst, Z_act, Z_comp, Z_inst, p
//  */

// function toNumber(v) {
//   if (v === null || v === undefined) return null;
//   const s = String(v).trim();
//   if (!s) return null;
//   const n = Number(s);
//   return Number.isFinite(n) ? n : null;
// }

// function clamp01(x) {
//   if (!Number.isFinite(x)) return 0;
//   return Math.max(0, Math.min(1, x));
// }

// function parseCSV(text) {
//   const lines = text
//     .split(/\r?\n/)
//     .map((l) => l.trim())
//     .filter((l) => l.length > 0);

//   if (lines.length < 2) return [];
//   const header = lines[0].split(",").map((h) => h.trim());
//   const out = [];

//   for (let i = 1; i < lines.length; i++) {
//     const cols = lines[i].split(",");
//     const row = {};
//     for (let j = 0; j < header.length; j++) {
//       row[header[j]] = (cols[j] ?? "").trim();
//     }
//     out.push(row);
//   }
//   return out;
// }

// function percentile(sortedAsc, p) {
//   if (!sortedAsc.length) return 0;
//   const rank = (p / 100) * (sortedAsc.length - 1);
//   const lo = Math.floor(rank);
//   const hi = Math.ceil(rank);
//   if (lo === hi) return sortedAsc[lo];
//   const w = rank - lo;
//   return sortedAsc[lo] * (1 - w) + sortedAsc[hi] * w;
// }

// function ema(values, alpha) {
//   if (!values.length) return [];
//   const out = [values[0]];
//   for (let i = 1; i < values.length; i++) {
//     out.push(alpha * values[i] + (1 - alpha) * out[i - 1]);
//   }
//   return out;
// }

// export default function RehabSimulator() {
//   // ===== 파라미터(명세서) =====
//   const [alpha, setAlpha] = useState(0.3);

//   const [k_s, setK_s] = useState(10);
//   const [S_mid, setS_mid] = useState(0.01);
//   const [T_base, setT_base] = useState(0.5);
//   const [T_min, setT_min] = useState(0.3);

//   // T_abs: Healthy 95th 자동 또는 fixed
//   const [useHealthyPercentile, setUseHealthyPercentile] = useState(true);
//   const [T_abs_fixed, setT_abs_fixed] = useState(0.85);
//   const T_abs_percentile = 95;

//   // Z-score 임계치
//   const [theta_act, setThetaAct] = useState(2.0);
//   const [theta_comp, setThetaComp] = useState(2.0);
//   const [theta_inst, setThetaInst] = useState(2.0);

//   // 임피던스(시뮬레이션용)
//   const [K0, setK0] = useState(1.0);
//   const [D0, setD0] = useState(1.0);
//   const [gammaK, setGammaK] = useState(2.0);
//   const [gammaD, setGammaD] = useState(2.0);

//   // 원인별 보정(예시)
//   const [assistKDown, setAssistKDown] = useState(0.5);
//   const [guideGain, setGuideGain] = useState(3.0);
//   const [epsilon0, setEpsilon0] = useState(1.0);
//   const [epsilonMin, setEpsilonMin] = useState(0.2);

//   // 채터링 방지
//   const [minHoldWindows, setMinHoldWindows] = useState(10);
//   const [hyst, setHyst] = useState(0.02);

//   // 파일별 초기 window 제거
//   const [dropPerFile, setDropPerFile] = useState(5);

//   // ===== 상태 =====
//   const [data, setData] = useState([]); // Row[]
//   const [currentIdx, setCurrentIdx] = useState(0);
//   const [isPlaying, setIsPlaying] = useState(false);
//   const timerRef = useRef(null);

//   const onUpload = async (file) => {
//     if (!file) return;
//     const raw = parseCSV(await file.text());

//     const parsed = raw
//       .map((r, i) => {
//         const group = String(r.group ?? "");
//         const subject = toNumber(r.subject) ?? 0;
//         const fileName = String(r.file ?? "");

//         const t0 = toNumber(r.t0) ?? i;
//         const t1 = toNumber(r.t1) ?? i;

//         const f_act = toNumber(r.f_act) ?? 0;
//         const f_comp = toNumber(r.f_comp) ?? 0;
//         const f_inst = toNumber(r.f_inst) ?? 0;

//         const Z_act = toNumber(r.Z_act) ?? 0;
//         const Z_comp = toNumber(r.Z_comp) ?? 0;
//         const Z_inst = toNumber(r.Z_inst) ?? 0;

//         const p = clamp01(toNumber(r.p) ?? 0);

//         return {
//           group,
//           subject,
//           file: fileName,
//           t0,
//           t1,
//           f_act,
//           f_comp,
//           f_inst,
//           Z_act,
//           Z_comp,
//           Z_inst,
//           p,
//           idx: i,
//         };
//       })
//       .filter((r) => r.file && r.file.length > 0);

//     // 파일별 초기 window 제거
//     const buckets = new Map();
//     for (const r of parsed) {
//       const key = `${r.group}::${r.subject}::${r.file}`;
//       if (!buckets.has(key)) buckets.set(key, []);
//       buckets.get(key).push(r);
//     }

//     const kept = [];
//     for (const rows of buckets.values()) {
//       rows.sort((a, b) => a.t0 - b.t0);
//       kept.push(...rows.slice(dropPerFile));
//     }

//     kept.sort((a, b) => a.t0 - b.t0);
//     const normalized = kept.map((r, i) => ({ ...r, idx: i }));

//     setData(normalized);
//     setCurrentIdx(0);
//     setIsPlaying(false);
//   };

//   // T_abs 계산
//   const T_abs = useMemo(() => {
//     if (!useHealthyPercentile) return T_abs_fixed;
//     if (data.length === 0) return T_abs_fixed;

//     const healthyP = data
//       .filter((r) => String(r.group).toLowerCase() === "healthy")
//       .map((r) => r.p)
//       .filter((v) => Number.isFinite(v))
//       .sort((a, b) => a - b);

//     if (healthyP.length < 10) return T_abs_fixed;
//     return clamp01(percentile(healthyP, T_abs_percentile));
//   }, [useHealthyPercentile, T_abs_fixed, data]);

//   // EMA + slope + T_adapt
//   const derived = useMemo(() => {
//     if (!data.length) return { pRaw: [], pEma: [], slope: [], T_adapt: [] };

//     const pRaw = data.map((r) => r.p);
//     const pEma = ema(pRaw, alpha);

//     const slope = pEma.map((v, i) => (i === 0 ? 0 : v - pEma[i - 1]));

//     const T_adapt = slope.map((s) => {
//       const denom = 1 + Math.exp(k_s * (s - S_mid));
//       return T_min + (T_base - T_min) / denom;
//     });

//     return { pRaw, pEma, slope, T_adapt };
//   }, [data, alpha, k_s, S_mid, T_min, T_base]);

//   // 게이팅 + 채터링 방지 + 임피던스
//   const gating = useMemo(() => {
//     if (!data.length) {
//       return {
//         mode: [],
//         subMode: [],
//         K: [],
//         D: [],
//         K_guide: [],
//         epsilon: [],
//         margin: [],
//       };
//     }

//     const mode = [];
//     const subMode = [];

//     const K_arr = [];
//     const D_arr = [];
//     const K_guide_arr = [];
//     const eps_arr = [];
//     const margin_arr = [];

//     let currentMode = "NORMAL";
//     let hold = 0;

//     for (let i = 0; i < data.length; i++) {
//       const pE = derived.pEma[i];
//       const Ta = derived.T_adapt[i];

//       const Ta_in = Ta;
//       const Ta_out = Math.max(0, Ta - hyst);
//       const Tabs_in = T_abs;
//       const Tabs_out = Math.max(0, T_abs - hyst);

//       const wantCritical = pE >= Tabs_in;
//       const wantAdaptive = pE >= Ta_in && pE < Tabs_in;
//       const wantNormal = pE < Ta_out;

//       if (hold > 0) {
//         hold -= 1;
//       } else {
//         if (currentMode === "CRITICAL") {
//           if (pE < Tabs_out) {
//             currentMode = pE >= Ta_in ? "ADAPTIVE" : "NORMAL";
//             hold = minHoldWindows;
//           }
//         } else if (currentMode === "ADAPTIVE") {
//           if (wantCritical) {
//             currentMode = "CRITICAL";
//             hold = minHoldWindows;
//           } else if (wantNormal) {
//             currentMode = "NORMAL";
//             hold = minHoldWindows;
//           }
//         } else {
//           if (wantCritical) {
//             currentMode = "CRITICAL";
//             hold = minHoldWindows;
//           } else if (wantAdaptive) {
//             currentMode = "ADAPTIVE";
//             hold = minHoldWindows;
//           }
//         }
//       }

//       const zA = data[i].Z_act;
//       const zC = data[i].Z_comp;
//       const zI = data[i].Z_inst;

//       let sm = "NONE";
//       if (zI >= theta_inst) sm = "DAMPING";
//       else if (zC >= theta_comp) sm = "CONSTRAINT";
//       else if (zA >= theta_act) sm = "ASSIST";

//       const m = pE - Ta;
//       margin_arr.push(m);

//       let Kt = K0 + gammaK * Math.max(0, m);
//       let Dt = D0 + gammaD * Math.max(0, m);

//       let Kguide = 0;
//       let eps = epsilon0;

//       if (currentMode === "CRITICAL") {
//         Kt = Math.max(0.1, Math.min(Kt, K0));
//         Dt = Math.max(0.1, Math.min(Dt, D0));
//         Kguide = 0;
//         eps = epsilon0;
//         sm = "NONE";
//       } else if (currentMode === "ADAPTIVE") {
//         if (sm === "DAMPING") {
//           Dt = Dt + guideGain * Math.max(0, m);
//         } else if (sm === "CONSTRAINT") {
//           Kguide = guideGain * (1 + Math.max(0, m));
//           eps = Math.max(
//             epsilonMin,
//             epsilon0 * (1 - 0.5 * clamp01(Math.max(0, m)))
//           );
//         } else if (sm === "ASSIST") {
//           Kt = Math.max(0.1, Kt * (1 - assistKDown));
//         }
//       } else {
//         Kguide = 0;
//         eps = epsilon0;
//         sm = "NONE";
//       }

//       mode.push(currentMode);
//       subMode.push(sm);
//       K_arr.push(Kt);
//       D_arr.push(Dt);
//       K_guide_arr.push(Kguide);
//       eps_arr.push(eps);
//     }

//     return {
//       mode,
//       subMode,
//       K: K_arr,
//       D: D_arr,
//       K_guide: K_guide_arr,
//       epsilon: eps_arr,
//       margin: margin_arr,
//     };
//   }, [
//     data,
//     derived.pEma,
//     derived.T_adapt,
//     T_abs,
//     hyst,
//     minHoldWindows,
//     theta_act,
//     theta_comp,
//     theta_inst,
//     K0,
//     D0,
//     gammaK,
//     gammaD,
//     assistKDown,
//     guideGain,
//     epsilon0,
//     epsilonMin,
//   ]);

//   // 재생
//   useEffect(() => {
//     if (timerRef.current) {
//       window.clearTimeout(timerRef.current);
//       timerRef.current = null;
//     }
//     if (isPlaying && currentIdx < data.length - 1) {
//       timerRef.current = window.setTimeout(
//         () => setCurrentIdx((p) => p + 1),
//         100
//       );
//     } else if (currentIdx >= data.length - 1) {
//       setIsPlaying(false);
//     }
//     return () => {
//       if (timerRef.current) window.clearTimeout(timerRef.current);
//     };
//   }, [isPlaying, currentIdx, data.length]);

//   const current = data[currentIdx];

//   const modeLabel = (m) => {
//     if (m === "CRITICAL") return "Critical Safety Mode";
//     if (m === "ADAPTIVE") return "Adaptive Intervention Mode";
//     return "Normal Mode";
//   };

//   const subLabel = (s) => {
//     if (s === "DAMPING") return "Damping Mode (D↑)";
//     if (s === "CONSTRAINT") return "Constraint Mode (K_guide↑, ε↓)";
//     if (s === "ASSIST") return "Assist Mode (K↓)";
//     return "-";
//   };

//   const modeColor = {
//     NORMAL: "bg-green-600",
//     ADAPTIVE: "bg-orange-600",
//     CRITICAL: "bg-red-700",
//   };
//   const subColor = {
//     NONE: "bg-gray-600",
//     ASSIST: "bg-blue-700",
//     CONSTRAINT: "bg-orange-700",
//     DAMPING: "bg-purple-700",
//   };

//   return (
//     <div className="w-full min-h-screen bg-gray-900 text-white p-6">
//       <div className="max-w-7xl mx-auto space-y-6">
//         <div>
//           <h1 className="text-3xl font-bold">Rehab Simulator</h1>
//           <p className="text-gray-400">
//             Dual Threshold + Z-score + Impedance (JSX build)
//           </p>
//         </div>

//         <div className="bg-gray-800 rounded-lg p-6 space-y-3">
//           <div className="text-sm text-gray-300">
//             입력 CSV:{" "}
//             <span className="font-mono">window_features_with_p.csv</span>
//           </div>
//           <input
//             type="file"
//             accept=".csv,text/csv"
//             onChange={(e) => onUpload(e.target.files?.[0] ?? null)}
//             className="block w-full text-sm text-gray-200
//               file:mr-4 file:py-2 file:px-4
//               file:rounded-lg file:border-0
//               file:text-sm file:font-semibold
//               file:bg-blue-600 file:text-white
//               hover:file:bg-blue-700"
//           />
//           {data.length > 0 && (
//             <div className="text-xs text-gray-400">
//               rows: {data.length.toLocaleString()} / T_abs: {T_abs.toFixed(3)}{" "}
//               {useHealthyPercentile ? "(Healthy 95th)" : "(fixed)"}
//             </div>
//           )}
//         </div>

//         <div className="bg-gray-800 rounded-lg p-6">
//           <div className="flex items-center gap-3">
//             <button
//               onClick={() => setIsPlaying((p) => !p)}
//               disabled={!data.length}
//               className="flex items-center gap-2 px-5 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 rounded-lg"
//             >
//               {isPlaying ? <Pause size={18} /> : <Play size={18} />}
//               {isPlaying ? "Pause" : "Play"}
//             </button>
//             <button
//               onClick={() => {
//                 setCurrentIdx(0);
//                 setIsPlaying(false);
//               }}
//               disabled={!data.length}
//               className="flex items-center gap-2 px-5 py-3 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-600 rounded-lg"
//             >
//               <RotateCcw size={18} />
//               Reset
//             </button>

//             <div className="flex-1 px-4">
//               <input
//                 type="range"
//                 min={0}
//                 max={Math.max(0, data.length - 1)}
//                 value={Math.min(currentIdx, Math.max(0, data.length - 1))}
//                 onChange={(e) => setCurrentIdx(parseInt(e.target.value, 10))}
//                 className="w-full"
//                 disabled={!data.length}
//               />
//               <div className="text-sm text-gray-400 mt-1">
//                 window: {data.length ? currentIdx + 1 : 0} / {data.length}
//               </div>
//             </div>
//           </div>
//         </div>

//         <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
//           <div className="lg:col-span-2 bg-gray-800 rounded-lg p-6">
//             <h2 className="text-xl font-bold mb-4">p(t), EMA, Threshold</h2>
//             <div className="relative h-64 bg-gray-900 rounded">
//               <svg width="100%" height="100%" viewBox="0 0 800 256">
//                 <line
//                   x1="0"
//                   y1={256 * (1 - T_abs)}
//                   x2="800"
//                   y2={256 * (1 - T_abs)}
//                   stroke="#ef4444"
//                   strokeWidth="2"
//                   strokeDasharray="5,5"
//                 />
//                 {!!data.length && (
//                   <polyline
//                     points={derived.T_adapt.map(
//                       (t, i) =>
//                         `${(i / Math.max(1, data.length - 1)) * 800},${
//                           256 * (1 - t)
//                         }`
//                     ).join(" ")}
//                     fill="none"
//                     stroke="#f97316"
//                     strokeWidth="2"
//                     strokeDasharray="5,5"
//                   />
//                 )}
//                 {!!data.length && (
//                   <polyline
//                     points={derived.pRaw
//                       .map(
//                         (r, i) =>
//                           `${(i / Math.max(1, data.length - 1)) * 800},${
//                             256 * (1 - r)
//                           }`
//                       )
//                       .join(" ")}
//                     fill="none"
//                     stroke="rgba(156, 163, 175, 0.55)"
//                     strokeWidth="1"
//                   />
//                 )}
//                 {!!data.length && (
//                   <polyline
//                     points={derived.pEma
//                       .map(
//                         (r, i) =>
//                           `${(i / Math.max(1, data.length - 1)) * 800},${
//                             256 * (1 - r)
//                           }`
//                       )
//                       .join(" ")}
//                     fill="none"
//                     stroke="#3b82f6"
//                     strokeWidth="3"
//                   />
//                 )}
//                 {!!data.length && (
//                   <line
//                     x1={(currentIdx / Math.max(1, data.length - 1)) * 800}
//                     y1="0"
//                     x2={(currentIdx / Math.max(1, data.length - 1)) * 800}
//                     y2="256"
//                     stroke="white"
//                     strokeWidth="2"
//                   />
//                 )}
//               </svg>
//             </div>
//           </div>

//           <div className="bg-gray-800 rounded-lg p-6">
//             <h2 className="text-xl font-bold mb-4">Current</h2>
//             {current ? (
//               <div className="space-y-2 text-sm">
//                 <div className="text-xs text-gray-400">
//                   file: <span className="font-mono">{current.file}</span>
//                 </div>

//                 <div className="flex justify-between">
//                   <span className="text-gray-400">p(raw)</span>
//                   <span className="font-mono">{current.p.toFixed(3)}</span>
//                 </div>
//                 <div className="flex justify-between">
//                   <span className="text-gray-400">p(EMA)</span>
//                   <span className="font-mono">
//                     {derived.pEma[currentIdx].toFixed(3)}
//                   </span>
//                 </div>
//                 <div className="flex justify-between">
//                   <span className="text-gray-400">T_adapt</span>
//                   <span className="font-mono text-orange-300">
//                     {derived.T_adapt[currentIdx].toFixed(3)}
//                   </span>
//                 </div>
//                 <div className="flex justify-between">
//                   <span className="text-gray-400">T_abs</span>
//                   <span className="font-mono text-red-300">
//                     {T_abs.toFixed(3)}
//                   </span>
//                 </div>

//                 <div className="pt-3 border-t border-gray-700 space-y-2">
//                   <div className="flex justify-between items-center">
//                     <span className="text-gray-400">Mode</span>
//                     <span
//                       className={`px-3 py-1 rounded-full text-xs font-semibold ${
//                         modeColor[gating.mode[currentIdx]]
//                       }`}
//                     >
//                       {modeLabel(gating.mode[currentIdx])}
//                     </span>
//                   </div>
//                   <div className="flex justify-between items-center">
//                     <span className="text-gray-400">Sub</span>
//                     <span
//                       className={`px-3 py-1 rounded-full text-xs font-semibold ${
//                         subColor[gating.subMode[currentIdx]]
//                       }`}
//                     >
//                       {subLabel(gating.subMode[currentIdx])}
//                     </span>
//                   </div>
//                 </div>

//                 <div className="pt-3 border-t border-gray-700 space-y-1">
//                   <div className="flex justify-between">
//                     <span className="text-gray-400">m</span>
//                     <span className="font-mono">
//                       {gating.margin[currentIdx].toFixed(3)}
//                     </span>
//                   </div>
//                   <div className="flex justify-between">
//                     <span className="text-gray-400">K(t)</span>
//                     <span className="font-mono">
//                       {gating.K[currentIdx].toFixed(3)}
//                     </span>
//                   </div>
//                   <div className="flex justify-between">
//                     <span className="text-gray-400">D(t)</span>
//                     <span className="font-mono">
//                       {gating.D[currentIdx].toFixed(3)}
//                     </span>
//                   </div>
//                   <div className="flex justify-between">
//                     <span className="text-gray-400">K_guide</span>
//                     <span className="font-mono">
//                       {gating.K_guide[currentIdx].toFixed(3)}
//                     </span>
//                   </div>
//                   <div className="flex justify-between">
//                     <span className="text-gray-400">ε</span>
//                     <span className="font-mono">
//                       {gating.epsilon[currentIdx].toFixed(3)}
//                     </span>
//                   </div>
//                 </div>

//                 <div className="pt-3 border-t border-gray-700 space-y-1">
//                   <div className="flex justify-between">
//                     <span className="text-gray-400">Z_act</span>
//                     <span className="font-mono">
//                       {current.Z_act.toFixed(2)}
//                     </span>
//                   </div>
//                   <div className="flex justify-between">
//                     <span className="text-gray-400">Z_comp</span>
//                     <span className="font-mono">
//                       {current.Z_comp.toFixed(2)}
//                     </span>
//                   </div>
//                   <div className="flex justify-between">
//                     <span className="text-gray-400">Z_inst</span>
//                     <span className="font-mono">
//                       {current.Z_inst.toFixed(2)}
//                     </span>
//                   </div>
//                 </div>
//               </div>
//             ) : (
//               <div className="text-gray-400">CSV 업로드 필요</div>
//             )}
//           </div>
//         </div>

//         {/* 최소 설정만 남김(필요 시 확장) */}
//         <div className="bg-gray-800 rounded-lg p-6">
//           <h2 className="text-xl font-bold mb-3">Settings</h2>

//           <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
//             <div className="bg-gray-900 rounded p-4 space-y-2">
//               <div className="font-semibold">T_abs</div>
//               <label className="flex items-center gap-2">
//                 <input
//                   type="checkbox"
//                   checked={useHealthyPercentile}
//                   onChange={(e) => setUseHealthyPercentile(e.target.checked)}
//                 />
//                 <span>Healthy 95th 사용</span>
//               </label>
//               {!useHealthyPercentile && (
//                 <div className="flex justify-between">
//                   <span className="text-gray-400">T_abs fixed</span>
//                   <input
//                     className="w-24 bg-gray-800 rounded px-2 py-1"
//                     type="number"
//                     step="0.01"
//                     value={T_abs_fixed}
//                     onChange={(e) => setT_abs_fixed(Number(e.target.value))}
//                   />
//                 </div>
//               )}
//               <div className="flex justify-between">
//                 <span className="text-gray-400">drop/file</span>
//                 <input
//                   className="w-24 bg-gray-800 rounded px-2 py-1"
//                   type="number"
//                   step="1"
//                   value={dropPerFile}
//                   onChange={(e) => setDropPerFile(Number(e.target.value))}
//                 />
//               </div>
//             </div>

//             <div className="bg-gray-900 rounded p-4 space-y-2">
//               <div className="font-semibold">T_adapt</div>
//               <div className="flex justify-between">
//                 <span className="text-gray-400">T_base</span>
//                 <input
//                   className="w-24 bg-gray-800 rounded px-2 py-1"
//                   type="number"
//                   step="0.01"
//                   value={T_base}
//                   onChange={(e) => setT_base(Number(e.target.value))}
//                 />
//               </div>
//               <div className="flex justify-between">
//                 <span className="text-gray-400">T_min</span>
//                 <input
//                   className="w-24 bg-gray-800 rounded px-2 py-1"
//                   type="number"
//                   step="0.01"
//                   value={T_min}
//                   onChange={(e) => setT_min(Number(e.target.value))}
//                 />
//               </div>
//               <div className="flex justify-between">
//                 <span className="text-gray-400">k_s</span>
//                 <input
//                   className="w-24 bg-gray-800 rounded px-2 py-1"
//                   type="number"
//                   step="1"
//                   value={k_s}
//                   onChange={(e) => setK_s(Number(e.target.value))}
//                 />
//               </div>
//               <div className="flex justify-between">
//                 <span className="text-gray-400">S_mid</span>
//                 <input
//                   className="w-24 bg-gray-800 rounded px-2 py-1"
//                   type="number"
//                   step="0.001"
//                   value={S_mid}
//                   onChange={(e) => setS_mid(Number(e.target.value))}
//                 />
//               </div>
//               <div className="flex justify-between">
//                 <span className="text-gray-400">alpha</span>
//                 <input
//                   className="w-24 bg-gray-800 rounded px-2 py-1"
//                   type="number"
//                   step="0.05"
//                   value={alpha}
//                   onChange={(e) => setAlpha(Number(e.target.value))}
//                 />
//               </div>
//             </div>

//             <div className="bg-gray-900 rounded p-4 space-y-2">
//               <div className="font-semibold">Chattering</div>
//               <div className="flex justify-between">
//                 <span className="text-gray-400">hyst</span>
//                 <input
//                   className="w-24 bg-gray-800 rounded px-2 py-1"
//                   type="number"
//                   step="0.01"
//                   value={hyst}
//                   onChange={(e) => setHyst(Number(e.target.value))}
//                 />
//               </div>
//               <div className="flex justify-between">
//                 <span className="text-gray-400">min hold</span>
//                 <input
//                   className="w-24 bg-gray-800 rounded px-2 py-1"
//                   type="number"
//                   step="1"
//                   value={minHoldWindows}
//                   onChange={(e) => setMinHoldWindows(Number(e.target.value))}
//                 />
//               </div>
//               <div className="text-xs text-gray-500 pt-2">
//                 Z-임계치(θ_act/θ_comp/θ_inst)와 임피던스 파라미터는 필요 시 UI에
//                 추가로 노출하면 됩니다.
//               </div>
//             </div>
//           </div>
//         </div>
//       </div>
//     </div>
//   );
// }
