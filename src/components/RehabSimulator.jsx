import React, { useEffect, useMemo, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  AreaChart,
  Area,
} from "recharts";
import { Play, Pause, RotateCcw, TrendingUp } from "lucide-react";

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(",").map((s) => s.trim());
  return lines.slice(1).map((line) => {
    const cols = line.split(",");
    const obj = {};
    header.forEach((h, i) => {
      const v = cols[i];
      // 숫자면 number로
      const n = Number(v);
      obj[h] = Number.isFinite(n) && v !== "" ? n : v;
    });
    return obj;
  });
}

async function fetchJson(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`Fetch 실패: ${path}`);
  return r.json();
}

async function fetchCsv(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`Fetch 실패: ${path}`);
  const t = await r.text();
  return parseCsv(t);
}

const statusColor = (s) => {
  if (s === "EMERGENCY") return "#ef4444";
  if (s === "ADAPTIVE") return "#f59e0b";
  return "#10b981";
};

export default function RehabSimulator() {
  const [manifest, setManifest] = useState(null);
  const [selected, setSelected] = useState("");
  const [rows, setRows] = useState([]);
  const [isRunning, setIsRunning] = useState(false);
  const [idx, setIdx] = useState(0);
  const [err, setErr] = useState("");

  // 최초 manifest 로드
  useEffect(() => {
    (async () => {
      try {
        setErr("");
        const m = await fetchJson("/sim/manifest.json");
        setManifest(m);
        if (m.files?.length) setSelected(m.files[0].name);
      } catch (e) {
        setErr(String(e.message || e));
      }
    })();
  }, []);

  // 선택된 CSV 로드
  useEffect(() => {
    if (!selected) return;
    (async () => {
      try {
        setErr("");
        const data = await fetchCsv(`/sim/${selected}`);
        setRows(data);
        setIdx(0);
        setIsRunning(false);
      } catch (e) {
        setErr(String(e.message || e));
      }
    })();
  }, [selected]);

  // 재생 타이머
  useEffect(() => {
    if (!isRunning) return;
    if (!rows.length) return;
    if (idx >= rows.length - 1) {
      setIsRunning(false);
      return;
    }
    const t = setTimeout(() => setIdx((v) => v + 1), 200);
    return () => clearTimeout(t);
  }, [isRunning, idx, rows.length]);

  const cur = rows[idx] || null;
  const view = useMemo(
    () => rows.slice(Math.max(0, idx - 120), idx + 1),
    [rows, idx]
  );

  const handleStep = () => {
    if (!rows.length) return;
    setIdx((v) => Math.min(rows.length - 1, v + 1));
  };

  const handleReset = () => {
    setIsRunning(false);
    setIdx(0);
  };

  return (
    <div
      style={{
        padding: 18,
        fontFamily: "system-ui",
        background: "#0b1220",
        minHeight: "100vh",
        color: "#e5e7eb",
      }}
    >
      <div style={{ maxWidth: 1300, margin: "0 auto" }}>
        <h2 style={{ marginBottom: 6 }}>
          특허 정합 시뮬레이션 (Mendeley 기반)
        </h2>
        <div style={{ color: "#94a3b8", marginBottom: 14 }}>
          SVM 확률 p(t) + EMA + Dual Threshold(T_abs/T_adapt) + Z-score 원인
          분리 + 임피던스(K,D)
        </div>

        {err && (
          <div
            style={{
              background: "#3b0a0a",
              border: "1px solid #ef4444",
              padding: 10,
              borderRadius: 8,
              marginBottom: 12,
            }}
          >
            {err}
          </div>
        )}

        {/* 상단 컨트롤 */}
        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            flexWrap: "wrap",
            marginBottom: 12,
          }}
        >
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            style={{
              padding: "10px 12px",
              borderRadius: 8,
              border: "1px solid #334155",
              background: "#0f172a",
              color: "#e5e7eb",
            }}
          >
            {manifest?.files?.map((f) => (
              <option key={f.name} value={f.name}>
                {f.name}
              </option>
            ))}
          </select>

          <button
            onClick={() => setIsRunning((v) => !v)}
            disabled={!rows.length}
            style={{
              display: "inline-flex",
              gap: 8,
              alignItems: "center",
              padding: "10px 14px",
              borderRadius: 8,
              border: "1px solid #334155",
              background: "#111827",
              color: "#e5e7eb",
              cursor: "pointer",
            }}
          >
            {isRunning ? <Pause size={18} /> : <Play size={18} />}
            {isRunning ? "일시정지" : "시작"}
          </button>

          <button
            onClick={handleStep}
            disabled={isRunning || !rows.length}
            style={{
              display: "inline-flex",
              gap: 8,
              alignItems: "center",
              padding: "10px 14px",
              borderRadius: 8,
              border: "1px solid #334155",
              background: "#111827",
              color: "#e5e7eb",
              cursor: "pointer",
              opacity: isRunning || !rows.length ? 0.6 : 1,
            }}
          >
            <TrendingUp size={18} />
            단계 실행
          </button>

          <button
            onClick={handleReset}
            disabled={!rows.length}
            style={{
              display: "inline-flex",
              gap: 8,
              alignItems: "center",
              padding: "10px 14px",
              borderRadius: 8,
              border: "1px solid #334155",
              background: "#111827",
              color: "#e5e7eb",
              cursor: "pointer",
            }}
          >
            <RotateCcw size={18} />
            초기화
          </button>

          <div style={{ marginLeft: "auto", color: "#94a3b8" }}>
            step: <b style={{ color: "#e5e7eb" }}>{cur?.step ?? "-"}</b> /{" "}
            {rows.length ? rows[rows.length - 1].step : "-"}
          </div>
        </div>

        {/* 현재 상태 카드 */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
            gap: 10,
            marginBottom: 12,
          }}
        >
          <div
            style={{
              background: "#0f172a",
              border: "1px solid #334155",
              borderRadius: 10,
              padding: 12,
            }}
          >
            <div style={{ color: "#94a3b8", fontSize: 12 }}>STATUS</div>
            <div
              style={{
                fontSize: 20,
                fontWeight: 700,
                color: statusColor(cur?.status),
              }}
            >
              {cur?.status ?? "-"}
            </div>
          </div>
          <div
            style={{
              background: "#0f172a",
              border: "1px solid #334155",
              borderRadius: 10,
              padding: 12,
            }}
          >
            <div style={{ color: "#94a3b8", fontSize: 12 }}>MODE</div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>
              {cur?.mode ?? "-"}
            </div>
          </div>
          <div
            style={{
              background: "#0f172a",
              border: "1px solid #334155",
              borderRadius: 10,
              padding: 12,
            }}
          >
            <div style={{ color: "#94a3b8", fontSize: 12 }}>
              p_ema / T_adapt / T_abs
            </div>
            <div style={{ fontSize: 14 }}>
              {cur
                ? `${cur.p_ema.toFixed(3)} / ${cur.T_adapt.toFixed(
                    3
                  )} / ${cur.T_abs.toFixed(3)}`
                : "-"}
            </div>
          </div>
          <div
            style={{
              background: "#0f172a",
              border: "1px solid #334155",
              borderRadius: 10,
              padding: 12,
            }}
          >
            <div style={{ color: "#94a3b8", fontSize: 12 }}>K / D</div>
            <div style={{ fontSize: 14 }}>
              {cur ? `${cur.K.toFixed(1)} / ${cur.D.toFixed(1)}` : "-"}
            </div>
          </div>
        </div>

        {/* 그래프 */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 14 }}>
          <div
            style={{
              background: "#0f172a",
              border: "1px solid #334155",
              borderRadius: 12,
              padding: 12,
            }}
          >
            <div style={{ marginBottom: 8, fontWeight: 700 }}>
              Dual Threshold (p_ema, T_adapt, T_abs)
            </div>
            <ResponsiveContainer width="100%" height={320}>
              <AreaChart data={view}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="step" stroke="#94a3b8" />
                <YAxis domain={[0, 1]} stroke="#94a3b8" />
                <Tooltip />
                <Legend />
                <Area
                  type="monotone"
                  dataKey="p_ema"
                  name="p_ema"
                  stroke="#ef4444"
                  fillOpacity={0.15}
                  fill="#ef4444"
                />
                <Line
                  type="monotone"
                  dataKey="T_adapt"
                  name="T_adapt"
                  stroke="#f59e0b"
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="T_abs"
                  name="T_abs"
                  stroke="#dc2626"
                  dot={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          <div
            style={{
              background: "#0f172a",
              border: "1px solid #334155",
              borderRadius: 12,
              padding: 12,
            }}
          >
            <div style={{ marginBottom: 8, fontWeight: 700 }}>
              Z-scores (Healthy μσ 기반)
            </div>
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={view}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="step" stroke="#94a3b8" />
                <YAxis stroke="#94a3b8" />
                <Tooltip />
                <Legend />
                <Line
                  type="monotone"
                  dataKey="Z_act"
                  name="Z_act"
                  stroke="#3b82f6"
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="Z_comp"
                  name="Z_comp"
                  stroke="#22c55e"
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="Z_inst"
                  name="Z_inst"
                  stroke="#a855f7"
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div
            style={{
              background: "#0f172a",
              border: "1px solid #334155",
              borderRadius: 12,
              padding: 12,
            }}
          >
            <div style={{ marginBottom: 8, fontWeight: 700 }}>
              Impedance (K, D)
            </div>
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={view}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="step" stroke="#94a3b8" />
                <YAxis stroke="#94a3b8" />
                <Tooltip />
                <Legend />
                <Line
                  type="monotone"
                  dataKey="K"
                  name="K"
                  stroke="#06b6d4"
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="D"
                  name="D"
                  stroke="#f97316"
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div style={{ marginTop: 14, color: "#94a3b8", fontSize: 12 }}>
          참고: 이 UI는 “학습된 SVM 출력(p)”을 기반으로 재생합니다. 값이 매
          실행마다 달라지지 않습니다(입력 CSV가 동일하면 동일).
        </div>
      </div>
    </div>
  );
}
