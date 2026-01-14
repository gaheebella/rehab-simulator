import pandas as pd
import numpy as np

from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.svm import SVC
from sklearn.calibration import CalibratedClassifierCV
from sklearn.tree import DecisionTreeClassifier

IN_CSV  = "public/data/window_features_with_p.csv"
OUT_CSV = "public/data/window_features_with_p_ML.csv"

FEATURES = ["f_act","f_comp","f_inst","Z_act","Z_comp","Z_inst"]

def make_risk_label_from_p(p: pd.Series, q: float = 0.80) -> pd.Series:
    thr = float(p.quantile(q))
    return (p >= thr).astype(int)

def make_submode_label_from_z(df: pd.DataFrame, th_act=2.0, th_comp=2.0, th_inst=2.0) -> pd.Series:
    sub = np.array(["NONE"] * len(df), dtype=object)
    sub[df["Z_inst"] >= th_inst] = "DAMPING"
    mask = (df["Z_inst"] < th_inst) & (df["Z_comp"] >= th_comp)
    sub[mask] = "CONSTRAINT"
    mask = (df["Z_inst"] < th_inst) & (df["Z_comp"] < th_comp) & (df["Z_act"] >= th_act)
    sub[mask] = "ASSIST"
    return pd.Series(sub)

def main():
    df = pd.read_csv(IN_CSV)

    required = ["p","f_act","f_comp","f_inst","Z_act","Z_comp","Z_inst"]
    miss = [c for c in required if c not in df.columns]
    if miss:
        raise ValueError(f"필수 컬럼 누락: {miss}")

    df2 = df.dropna(subset=required).copy()

    # --- (1) SVM용 약라벨 ---
    y_risk = make_risk_label_from_p(df2["p"], q=0.80)
    X = df2[FEATURES].to_numpy()

    # 기본 SVM(확률 X) + 캘리브레이션
    base_svm = Pipeline([
        ("scaler", StandardScaler()),
        ("svc", SVC(kernel="rbf", class_weight="balanced", random_state=0))
    ])

    # 캘리브레이션: sigmoid(Platt scaling)
    clf = CalibratedClassifierCV(base_svm, method="sigmoid", cv=3)

    Xtr, Xte, ytr, yte = train_test_split(X, y_risk, test_size=0.2, random_state=0, stratify=y_risk)
    clf.fit(Xtr, ytr)

    p_hat_cal = clf.predict_proba(X)[:, 1]
    p_hat_cal = np.clip(p_hat_cal, 0.0, 1.0)

    # --- (2) Decision Tree용 약라벨 ---
    y_sub = make_submode_label_from_z(df2, th_act=2.0, th_comp=2.0, th_inst=2.0)
    tree = DecisionTreeClassifier(max_depth=4, min_samples_leaf=50, class_weight="balanced", random_state=0)
    tree.fit(X, y_sub)
    sub_tree = tree.predict(X)

    # --- (3) 출력 CSV ---
    out = df.copy()
    out["p_hat_cal"] = np.nan
    out["sub_tree"] = ""

    out.loc[df2.index, "p_hat_cal"] = p_hat_cal
    out.loc[df2.index, "sub_tree"] = sub_tree

    # 혹시 결측이면 raw p로 대체(안전)
    out["p_hat_cal"] = out["p_hat_cal"].fillna(out["p"])

    out.to_csv(OUT_CSV, index=False, encoding="utf-8-sig")
    print(f"[OK] saved: {OUT_CSV} (added p_hat_cal, sub_tree)")

if __name__ == "__main__":
    main()
