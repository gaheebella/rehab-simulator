# Design of a Dual-Threshold–Based Personalized Rehabilitation Robot Control System (Web Simulator)

A web application that simulates an adaptive intervention system for rehabilitation robots.
It determines intervention modes and computes impedance parameters in real time using a machine-learning-based risk prediction model and a dual-threshold system.

## 📋 Table of Contents

* [Key Features](#-key-features)
* [Technology Stack](#-technology-stack)
* [Project Structure](#-project-structure)
* [Installation and Execution](#-installation-and-execution)
* [Data Format](#-data-format)
* [System Overview](#-system-overview)

  * [Margin Computation](#6-margin-computation-core-of-impedance-calculation)
* [Parameter Description](#-parameter-description)
* [Usage Guide](#-usage-guide)

## 🎯 Key Features

### 1. Dual Threshold System

* **T_abs (Absolute Threshold)**: Criterion for entering Critical Safety Mode

  * Automatically computed as the **95th percentile of raw p values (window-level) from the Healthy group**, or set as a fixed value
* **T_adapt (Adaptive Threshold)**: Criterion for entering Adaptive Intervention Mode

  * Dynamically adjusted using a sigmoid function based on the EMA-based slope

### 2. Machine Learning–Based Prediction

* **SVM Risk Prediction (p_hat_cal)**:

  * Based on six features (f_act, f_comp, f_inst, Z_act, Z_comp, Z_inst)
  * Outputs calibrated probabilities (0–1) using **Platt scaling (sigmoid calibration)**
  * Calibration performed with 3-fold cross-validation
* **Decision Tree SubMode Prediction (sub_tree)**:

  * Predicts one of ASSIST, CONSTRAINT, DAMPING, or NONE
  * Can be used as a substitute for Z-score–based rules

### 3. Personalized Threshold

* Subject-specific threshold adjustment based on biomarkers
* Severity computed using RMS, CV, MF, and Active Ratio
* Z-scores computed relative to the Healthy group mean (μ) and standard deviation (σ):

  * `z_rms = (rms - μ_rms) / σ_rms`
  * `z_cv = (cv - μ_cv) / σ_cv`
  * `z_mf = (mf - μ_mf) / σ_mf`
  * `z_ar = (active_ratio - μ_ar) / σ_ar`
* Personalized threshold adjustment using weighted severity

### 4. Intervention Modes

* **NORMAL**: Normal mode, no intervention
* **ADAPTIVE**: Adaptive intervention mode

  * ASSIST: Decrease stiffness (K↓)
  * CONSTRAINT: Trajectory constraint (K_guide↑, ε↓)
  * DAMPING: Increase damping (D↑)
* **CRITICAL**: Safety mode with conservative restrictions

### 5. Chattering Prevention

* Minimum holding window constraint
* Mode transition stabilization using hysteresis

## 🛠 Technology Stack

### Frontend

* **React 19.2.0**: UI framework
* **TypeScript**: Type safety
* **Vite 7.2.4**: Build tool
* **Tailwind CSS 4.1.18**: Styling
* **Recharts 3.6.0**: Chart library
* **PapaParse 5.5.3**: CSV parsing
* **Lucide React**: Icons

### Backend / ML

* **Python**: Data preprocessing and ML model training
* **scikit-learn**: SVM and Decision Tree models
* **pandas, numpy**: Data processing

## 📁 Project Structure

```
rehab-simulator/
├── public/
│   └── data/
│       ├── window_features_with_p.csv          # Raw window-level feature data
│       ├── window_features_with_p_ML.csv        # Includes ML prediction results
│       ├── biomarkers_all_subjects.csv          # Biomarker data
│       └── activation_summary_all_subjects.csv # Activation summary data
├── src/
│   ├── components/
│   │   └── RehabSimulator_personalized.tsx     # Main simulator component
│   ├── simulator/
│   │   ├── simCore.js                          # Core simulation logic
│   │   └── percentile.js                       # Percentile computation
│   ├── App.jsx                                 # Application entry point
│   └── main.jsx                                # React rendering
├── make_ml_columns.py                          # ML training and prediction script
├── package.json
├── vite.config.js
└── README.md
```

## 🚀 Installation and Execution

### Prerequisites

* Node.js 18+
* Python 3.8+ (for ML model training)
* npm or yarn

### Installation

```bash
# Install dependencies
npm install
```

### ML Model Training (Optional)

To generate ML prediction results:

```bash
# Install Python dependencies
pip install pandas numpy scikit-learn

# Train ML models and generate prediction results
python make_ml_columns.py
```

This script reads `window_features_with_p.csv` and performs:

* **SVM Risk Prediction**:

  * Binary classification labels generated using the 80th percentile of p as a threshold
  * RBF-kernel SVM with **Platt scaling (sigmoid)** calibration for probability output
  * Results stored in the `p_hat_cal` column
* **Decision Tree SubMode Prediction**:

  * Trained using labels generated from Z-score rules
  * Results stored in the `sub_tree` column (ASSIST, CONSTRAINT, DAMPING, NONE)

The output is saved to `window_features_with_p_ML.csv`.

### Run Development Server

```bash
npm run dev
```

Access via browser at `http://localhost:5173`.

### Production Build

```bash
npm run build
npm run preview
```

## 📊 Data Format

### Required Input CSV Columns

`window_features_with_p_ML.csv` must include the following columns:

| Column Name                 | Description                                                    | Type   |
| --------------------------- | -------------------------------------------------------------- | ------ |
| `group`                     | Group name (e.g., "Healthy", "Patient")                        | string |
| `subject`                   | Subject ID                                                     | number |
| `file`                      | File name                                                      | string |
| `t0`, `t1`                  | Window start/end time                                          | number |
| `f_act`, `f_comp`, `f_inst` | Feature values                                                 | number |
| `Z_act`, `Z_comp`, `Z_inst` | Z-scores                                                       | number |
| `p`                         | Risk score (0–1)                                               | number |
| `p_hat`                     | Raw SVM-predicted risk (optional, used if p_hat_cal is absent) | number |
| `p_hat_cal`                 | Calibrated SVM-predicted risk (optional)                       | number |
| `sub_tree`                  | Tree-predicted SubMode (optional)                              | string |

### Biomarker CSV Files

`biomarkers_all_subjects.csv`:

* `Group`, `Subject`, `RMS`, `CV`, `MF`

`activation_summary_all_subjects.csv`:

* `Group`, `Subject`, `active_ratio`

## 🔬 System Overview

### 1. Data Loading and Preprocessing

* Automatic loading of CSV files (`/data/window_features_with_p_ML.csv`)
* File-wise sorting and **initial window removal** (warm-up period removal, default: first 5 windows per file)
* ML prediction priority: `p_hat_cal` → `p_hat` → `p`

### 2. EMA and Slope Computation

* EMA reset on a per-file basis
* `pEma = α * p + (1-α) * prevEma`
* `slope = pEma(t) - pEma(t-1)`

### 3. Adaptive Threshold Computation

```
T_adapt = T_min + (T_base - T_min) / (1 + exp(k_s * (slope - S_mid)))
```

### 4. Personalized Threshold (Optional)

**Z-score Computation**:

* Compute Healthy group mean (μ) and standard deviation (σ)
* Convert each subject’s biomarkers into Z-scores:

  ```
  z_rms = (rms - μ_rms) / σ_rms
  z_cv = (cv - μ_cv) / σ_cv
  z_mf = (mf - μ_mf) / σ_mf
  z_ar = (active_ratio - μ_ar) / σ_ar  (replaced with μ_ar if missing)
  ```

**Severity Computation**:

```
severity = w_rms * z_rms + w_cv * z_cv + w_mf * (-z_mf) + w_active * z_ar
```

(Note: MF is considered more dangerous when lower, hence `-z_mf`.)

**Subject-Specific Threshold Adjustment**:

```
T_base_user = clamp(T_base - a_base * severity, T_base_bounds[0], T_base_bounds[1])
T_min_user = clamp(T_min - b_min * severity, T_min_bounds[0], T_min_bounds[1])
```

(Higher severity lowers thresholds, enabling more sensitive responses.)

### 5. Gating Logic

* **Critical**: `pEma >= T_abs`
* **Adaptive**: `T_adapt <= pEma < T_abs`
* **Normal**: `pEma < T_adapt`

### 6. Margin Computation (Core of Impedance Calculation)

**Safety-margin definition**:

```
margin = max(0, pEma - T_adapt)
```

* `margin` is always constrained to be **non-negative** (prevents unintended decreases in K/D)
* Larger `margin` indicates higher risk and stronger intervention
* This value is used as the reference for all impedance parameters (K, D, K_guide, ε)

### 7. SubMode Determination

1. Use Tree prediction if available: `sub_tree`
2. Z-score–based rules (fallback, **applied in priority order**):

   * `Z_inst >= theta_inst` → **DAMPING** (highest priority)
   * `Z_comp >= theta_comp` → **CONSTRAINT**
   * `Z_act >= theta_act` → **ASSIST**
   * Otherwise → **NONE**

### 8. Impedance Parameter Computation

**Base impedance (common to all modes)**:

```
K_base = K0 + γK * margin
D_base = D0 + γD * margin
```

**Mode-specific adjustments**:

* **ASSIST**:

  ```
  K = max(0.1, K_base * (1 - assistKDown))
  ```

  Reduces stiffness to lower resistance

* **DAMPING**:

  ```
  D = D_base + guideGain * margin
  ```

  Increases damping to suppress instability
  (Note: `guideGain` is reused in the code; logically, this can be interpreted as a DAMPING-specific gain.)

* **CONSTRAINT**:

  ```
  K_guide = guideGain * (1 + margin)
  ε = max(ε_min, ε0 * (1 - 0.5 * clamp01(margin)))
  ```

  Increases trajectory constraint stiffness and reduces tolerance

* **CRITICAL**:

  ```
  K = clamp(K_base, 0.1, K0)
  D = clamp(D_base, 0.1, D0)
  K_guide = 0
  ε = ε0
  ```

  Safety mode: conservative limitation, SubMode forcibly set to NONE

## ⚙️ Parameter Description

### EMA Parameters

* **alpha** (0.3): EMA smoothing factor

### Adaptive Threshold Parameters

* **k_s** (10): Sigmoid slope
* **S_mid** (0.01): Sigmoid midpoint
* **T_base** (0.5): Base threshold
* **T_min** (0.3): Minimum threshold

### Personalization Parameters

* **w_rms, w_cv, w_mf, w_active**: Biomarker weights
* **a_base, b_min**: Severity adjustment coefficients

### Z-score Thresholds

* **theta_act, theta_comp, theta_inst** (2.0): Z-score thresholds

### Impedance Parameters

* **K0, D0** (1.0): Base stiffness/damping
* **gammaK, gammaD** (2.0): Margin-based increase coefficients
* **assistKDown** (0.5): Stiffness reduction ratio in ASSIST mode
* **guideGain** (3.0): Guide stiffness gain for CONSTRAINT mode (reused in DAMPING mode)
* **epsilon0, epsilonMin** (1.0, 0.2): Constraint tolerance parameters

### Chattering Prevention

* **minHoldWindows** (10): Minimum holding windows
* **hyst** (0.02): Hysteresis value

## 💻 Usage Guide

### Basic Usage

1. **Prepare data**: Place required CSV files in the `public/data/` folder
2. **Run application**: `npm run dev`
3. **Playback control**: Use Play/Pause buttons to control simulation playback
4. **Parameter adjustment**: Modify parameters in real time via the UI

### ML Model Usage

* **Use SVM risk**: Enable “Use SVM p_hat”
* **Use Tree SubMode**: Enable “Use Tree sub_tree”

### Personalized Threshold Usage

* Enable “Use personalized threshold”
* Personalized thresholds are automatically computed when biomarker data is loaded

### Graph Interpretation

* **Blue line**: p EMA (smoothed risk)
* **Orange dashed line**: T_adapt (adaptive threshold)
* **Red dashed line**: T_abs (absolute threshold)
* **Gray line**: Raw p values

## 📝 License

This project was developed for research and educational purposes.

## 🤝 Contribution

Please submit bug reports or feature suggestions via issues.

---
Last Updated: 2026-02-01

---
---

# 이중임계치 기반 순환형 개인맞춤 재활로봇 제어시스템 및 방법 (웹 시뮬레이터)

재활 로봇의 적응형 개입 시스템을 시뮬레이션하는 웹 애플리케이션입니다. 머신러닝 기반 위험도 예측과 이중 임계값 시스템을 통해 실시간으로 개입 모드를 결정하고 임피던스 파라미터를 계산합니다.

## 📋 목차

- [주요 기능](#주요-기능)
- [기술 스택](#기술-스택)
- [프로젝트 구조](#프로젝트-구조)
- [설치 및 실행](#설치-및-실행)
- [데이터 형식](#데이터-형식)
- [시스템 개요](#시스템-개요)
  - [Margin 계산](#6-margin-계산-임피던스-계산의-핵심)
- [파라미터 설명](#파라미터-설명)
- [사용 방법](#사용-방법)

## 🎯 주요 기능

### 1. 이중 임계값 시스템 (Dual Threshold)
- **T_abs (절대 임계값)**: Critical Safety Mode 진입 기준
  - Healthy 그룹의 **원본 p 값(윈도우 단위)의 95th 백분위수** 자동 계산 또는 고정값 사용
- **T_adapt (적응형 임계값)**: Adaptive Intervention Mode 진입 기준
  - EMA 기반 slope에 따라 동적으로 조정되는 시그모이드 함수

### 2. 머신러닝 기반 예측
- **SVM 위험도 예측 (p_hat_cal)**: 
  - 6개 특징(f_act, f_comp, f_inst, Z_act, Z_comp, Z_inst) 기반
  - **Platt scaling (sigmoid 캘리브레이션)**을 적용한 확률 출력 (0~1)
  - 3-fold cross-validation으로 캘리브레이션 수행
- **Decision Tree SubMode 예측 (sub_tree)**:
  - ASSIST, CONSTRAINT, DAMPING, NONE 중 예측
  - Z-score 규칙 대신 사용 가능

### 3. 개인화 임계값 (Personalized Threshold)
- 바이오마커 기반 개인별 임계값 조정
- RMS, CV, MF, Active Ratio를 활용한 severity 계산
- Healthy 그룹의 평균(μ)과 표준편차(σ)를 기준으로 Z-score 계산:
  - `z_rms = (rms - μ_rms) / σ_rms`
  - `z_cv = (cv - μ_cv) / σ_cv`
  - `z_mf = (mf - μ_mf) / σ_mf`
  - `z_ar = (active_ratio - μ_ar) / σ_ar`
- 가중치 기반 severity로 개인별 임계값 조정

### 4. 개입 모드
- **NORMAL**: 정상 모드, 개입 없음
- **ADAPTIVE**: 적응형 개입 모드
  - ASSIST: 강성 감소 (K↓)
  - CONSTRAINT: 궤적 구속 (K_guide↑, ε↓)
  - DAMPING: 감쇠 증가 (D↑)
- **CRITICAL**: 안전 모드, 보수적 제한

### 5. 채터링 방지
- 최소 유지 윈도우 수 설정
- 히스테리시스 적용으로 모드 전환 안정화

## 🛠 기술 스택

### Frontend
- **React 19.2.0**: UI 프레임워크
- **TypeScript**: 타입 안정성
- **Vite 7.2.4**: 빌드 도구
- **Tailwind CSS 4.1.18**: 스타일링
- **Recharts 3.6.0**: 차트 라이브러리
- **PapaParse 5.5.3**: CSV 파싱
- **Lucide React**: 아이콘

### Backend/ML
- **Python**: 데이터 전처리 및 ML 모델 학습
- **scikit-learn**: SVM, Decision Tree 모델
- **pandas, numpy**: 데이터 처리

## 📁 프로젝트 구조

```
rehab-simulator/
├── public/
│   └── data/
│       ├── window_features_with_p.csv          # 원본 윈도우 특징 데이터
│       ├── window_features_with_p_ML.csv        # ML 예측 결과 포함
│       ├── biomarkers_all_subjects.csv          # 바이오마커 데이터
│       └── activation_summary_all_subjects.csv # 활성화 요약 데이터
├── src/
│   ├── components/
│   │   └── RehabSimulator_personalized.tsx     # 메인 시뮬레이터 컴포넌트
│   ├── simulator/
│   │   ├── simCore.js                          # 핵심 시뮬레이션 로직
│   │   └── percentile.js                       # 백분위수 계산
│   ├── App.jsx                                 # 앱 진입점
│   └── main.jsx                                # React 렌더링
├── make_ml_columns.py                          # ML 모델 학습 및 예측 스크립트
├── package.json
├── vite.config.js
└── README.md
```

## 🚀 설치 및 실행

### 필수 요구사항
- Node.js 18+ 
- Python 3.8+ (ML 모델 학습용)
- npm 또는 yarn

### 설치

```bash
# 의존성 설치
npm install
```

### ML 모델 학습 (선택사항)

ML 예측 결과를 생성하려면:

```bash
# Python 의존성 설치
pip install pandas numpy scikit-learn

# ML 모델 학습 및 예측 결과 생성
python make_ml_columns.py
```

이 스크립트는 `window_features_with_p.csv`를 읽어서:
- **SVM 위험도 예측**: 
  - p의 80th 백분위수를 임계값으로 이진 분류 라벨 생성
  - RBF 커널 SVM + **Platt scaling (sigmoid)** 캘리브레이션으로 확률 출력
  - 결과를 `p_hat_cal` 컬럼에 저장
- **Decision Tree SubMode 예측**: 
  - Z-score 규칙으로 생성한 라벨로 학습
  - 결과를 `sub_tree` 컬럼에 저장 (ASSIST, CONSTRAINT, DAMPING, NONE)

를 수행하고 `window_features_with_p_ML.csv`에 저장합니다.

### 개발 서버 실행

```bash
npm run dev
```

브라우저에서 `http://localhost:5173` 접속

### 프로덕션 빌드

```bash
npm run build
npm run preview
```

## 📊 데이터 형식

### 입력 CSV 필수 컬럼

`window_features_with_p_ML.csv`는 다음 컬럼을 포함해야 합니다:

| 컬럼명 | 설명 | 타입 |
|--------|------|------|
| `group` | 그룹명 (예: "Healthy", "Patient") | string |
| `subject` | 피험자 ID | number |
| `file` | 파일명 | string |
| `t0`, `t1` | 시간 윈도우 시작/종료 | number |
| `f_act`, `f_comp`, `f_inst` | 특징값 | number |
| `Z_act`, `Z_comp`, `Z_inst` | Z-score | number |
| `p` | 위험도 (0~1) | number |
| `p_hat` | SVM 예측 위험도 원본 (선택, p_hat_cal이 없을 때 사용) | number |
| `p_hat_cal` | SVM 캘리브레이션된 예측 위험도 (선택) | number |
| `sub_tree` | Tree 예측 SubMode (선택) | string |

### 바이오마커 CSV

`biomarkers_all_subjects.csv`:
- `Group`, `Subject`, `RMS`, `CV`, `MF`

`activation_summary_all_subjects.csv`:
- `Group`, `Subject`, `active_ratio`

## 🔬 시스템 개요

### 1. 데이터 로딩 및 전처리
- CSV 파일 자동 로드 (`/data/window_features_with_p_ML.csv`)
- 파일별 정렬 및 **초기 윈도우 제거** (워밍업 구간 제거, 기본값: 파일당 5개 윈도우)
- ML 예측 결과 우선 사용: `p_hat_cal` → `p_hat` → `p` 순서로 사용

### 2. EMA 및 Slope 계산
- 파일 단위로 EMA 리셋
- `pEma = α * p + (1-α) * prevEma`
- `slope = pEma(t) - pEma(t-1)`

### 3. 적응형 임계값 계산
```
T_adapt = T_min + (T_base - T_min) / (1 + exp(k_s * (slope - S_mid)))
```

### 4. 개인화 임계값 (옵션)

**Z-score 계산**:
- Healthy 그룹의 평균(μ)과 표준편차(σ)를 계산
- 각 피험자의 바이오마커를 Z-score로 변환:
  ```
  z_rms = (rms - μ_rms) / σ_rms
  z_cv = (cv - μ_cv) / σ_cv
  z_mf = (mf - μ_mf) / σ_mf
  z_ar = (active_ratio - μ_ar) / σ_ar  (결측 시 μ_ar로 대체)
  ```

**Severity 계산**:
```
severity = w_rms * z_rms + w_cv * z_cv + w_mf * (-z_mf) + w_active * z_ar
```
(참고: MF는 낮을수록 위험하므로 `-z_mf` 사용)

**개인별 임계값 조정**:
```
T_base_user = clamp(T_base - a_base * severity, T_base_bounds[0], T_base_bounds[1])
T_min_user = clamp(T_min - b_min * severity, T_min_bounds[0], T_min_bounds[1])
```
(severity가 높을수록 임계값이 낮아져 더 민감하게 반응)

### 5. 게이팅 로직
- **Critical**: `pEma >= T_abs`
- **Adaptive**: `T_adapt <= pEma < T_abs`
- **Normal**: `pEma < T_adapt`

### 6. Margin 계산 (임피던스 계산의 핵심)
**안전 마진형** 정의:
```
margin = max(0, pEma - T_adapt)
```

- `margin`은 항상 **0 이상**으로 제한됩니다 (음수 시 K/D가 감소하는 비의도 동작 방지)
- `margin`이 클수록 위험도가 높아 개입 강도가 증가합니다
- 이 값이 모든 임피던스 파라미터(K, D, K_guide, ε) 계산의 기준이 됩니다

### 7. SubMode 결정
1. Tree 예측 사용 (옵션): `sub_tree` 컬럼 값
2. Z-score 규칙 (fallback, **우선순위 순서대로**):
   - `Z_inst >= theta_inst` → **DAMPING** (최우선)
   - `Z_comp >= theta_comp` → **CONSTRAINT** (차순위)
   - `Z_act >= theta_act` → **ASSIST** (차차순위)
   - 그 외 → **NONE**

### 8. 임피던스 파라미터 계산

**기본 임피던스** (모든 모드 공통):
```
K_base = K0 + γK * margin
D_base = D0 + γD * margin
```

**모드별 조정**:

- **ASSIST**: 
  ```
  K = max(0.1, K_base * (1 - assistKDown))
  ```
  강성 감소로 저항을 낮춤

- **DAMPING**: 
  ```
  D = D_base + guideGain * margin
  ```
  감쇠 증가로 불안정성 억제 (참고: 코드상 `guideGain`을 재사용하지만, 논리적으로는 DAMPING 전용 계수로 이해 가능)

- **CONSTRAINT**: 
  ```
  K_guide = guideGain * (1 + margin)
  ε = max(ε_min, ε0 * (1 - 0.5 * clamp01(margin)))
  ```
  궤적 구속 강성 증가 및 허용 오차 감소

- **CRITICAL**: 
  ```
  K = clamp(K_base, 0.1, K0)
  D = clamp(D_base, 0.1, D0)
  K_guide = 0
  ε = ε0
  ```
  안전 모드: 보수적으로 제한, SubMode는 NONE으로 강제

## ⚙️ 파라미터 설명

### EMA 파라미터
- **alpha** (0.3): EMA 평활화 계수

### 적응형 임계값 파라미터
- **k_s** (10): 시그모이드 기울기
- **S_mid** (0.01): 시그모이드 중간점
- **T_base** (0.5): 기본 임계값
- **T_min** (0.3): 최소 임계값

### 개인화 파라미터
- **w_rms, w_cv, w_mf, w_active**: 바이오마커 가중치
- **a_base, b_min**: severity 조정 계수

### Z-score 임계값
- **theta_act, theta_comp, theta_inst** (2.0): 각 Z-score 임계값

### 임피던스 파라미터
- **K0, D0** (1.0): 기본 강성/감쇠
- **gammaK, gammaD** (2.0): 마진 기반 증가 계수 (기본 임피던스 계산용)
- **assistKDown** (0.5): ASSIST 모드 강성 감소 비율
- **guideGain** (3.0): CONSTRAINT 모드 가이드 강성 증가 계수 (DAMPING 모드에서도 재사용)
- **epsilon0, epsilonMin** (1.0, 0.2): CONSTRAINT 모드 허용 오차 (ε0: 기본값, ε_min: 최소값)

### 채터링 방지
- **minHoldWindows** (10): 최소 유지 윈도우 수
- **hyst** (0.02): 히스테리시스 값

## 💻 사용 방법

### 기본 사용

1. **데이터 준비**: `public/data/` 폴더에 필요한 CSV 파일 배치
2. **앱 실행**: `npm run dev`
3. **재생 제어**: Play/Pause 버튼으로 시뮬레이션 재생
4. **파라미터 조정**: UI에서 실시간으로 파라미터 변경 가능

### ML 모델 사용

- **SVM 위험도 사용**: "SVM p_hat 사용" 체크박스 활성화
- **Tree SubMode 사용**: "Tree sub_tree 사용" 체크박스 활성화

### 개인화 임계값 사용

- "개인화 임계값 사용" 옵션 활성화
- 바이오마커 데이터가 로드되면 자동으로 개인별 임계값 계산

### 그래프 해석

- **파란색 선**: p EMA (평활화된 위험도)
- **주황색 점선**: T_adapt (적응형 임계값)
- **빨간색 점선**: T_abs (절대 임계값)
- **회색 선**: 원본 p 값

## 📝 라이선스

이 프로젝트는 연구 및 교육 목적으로 개발되었습니다.

## 🤝 기여

버그 리포트나 기능 제안은 이슈로 등록해주세요.

---
최종 업데이트: 2026-02-01
