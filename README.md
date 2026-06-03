# shoong-order-api

Shoong 배달 서비스의 **주문(order) 마이크로서비스**입니다.
메뉴 조회·주문 생성·주문 목록·상태 변경을 담당하며, 주문이 생성되면 주방·알림 서비스를 연쇄 호출하는 흐름의 시작점입니다.

---

## Shoong 프로젝트

Shoong은 음식 배달 도메인을 여러 개의 마이크로서비스로 나눠 구현하고,
Kubernetes(EKS) 위에서 GitOps로 배포·운영하는 클라우드 인프라 프로젝트입니다.

주문 → 조리 → 배달 → 알림으로 이어지는 흐름을 서비스 단위로 분리하고,
그 아래 인프라(IaC) → 이미지 빌드(CI) → 배포(GitOps/CD)까지의 파이프라인을 직접 구성했습니다.

### 레포지토리 구성

전체 시스템은 역할별로 레포지토리가 나뉘어 있습니다.

**플랫폼 / 인프라**

| 레포 | 역할 |
| --- | --- |
| [shoong-terraform](https://github.com/shoong-delivery/shoong-terraform) | AWS 인프라 프로비저닝 (IaC) |
| [shoong-gitops](https://github.com/shoong-delivery/shoong-gitops) | ArgoCD 앱 정의 / Helm 차트 관리 (CD) |

**애플리케이션**

| 레포 | 역할 | 포트 |
| --- | --- | --- |
| [shoong-order-api](https://github.com/shoong-delivery/shoong-order-api) | 주문 서비스 | 3001 |
| [shoong-kitchen-api](https://github.com/shoong-delivery/shoong-kitchen-api) | 주방 서비스 | 3002 |
| [shoong-delivery-api](https://github.com/shoong-delivery/shoong-delivery-api) | 배달 서비스 | 3003 |
| [shoong-notification-api](https://github.com/shoong-delivery/shoong-notification-api) | 알림 서비스 | 3004 |
| [shoong-batch](https://github.com/shoong-delivery/shoong-batch) | 오래된 주문 정리 배치 (CronJob) | - |
| [shoong-frontend](https://github.com/shoong-delivery/shoong-frontend) | 프론트엔드 | - |

### 레포 간 관계

```
shoong-terraform ──(EKS / ECR / RDS / OIDC / SSM 생성)──┐
                                                        ▼
  앱 레포 (order·kitchen·delivery·notification·batch·frontend)
        └─ GitHub Actions(OIDC)로 이미지 빌드 → ECR push
                                                        ▼
                                                shoong-gitops
                                    (ArgoCD가 Helm 차트로 EKS에 배포)
```

- **shoong-terraform** 이 클러스터·레지스트리·DB·CI 인증 기반을 먼저 만든다.
- 각 **앱 레포**는 GitHub Actions에서 OIDC로 AWS에 인증해 이미지를 빌드하고 ECR에 푸시한다.
- **shoong-gitops** 의 ArgoCD가 변경을 감지해 EKS에 배포한다.

---

## 이 레포의 역할

주문 도메인을 담당하는 서비스입니다. 주문 생성 시 다음 서비스를 연쇄 호출해 전체 흐름을 시작합니다.

```
[Client] ─▶ order ─┬─▶ kitchen   (POST /start  : 조리 시작)
                   └─▶ notification (POST /     : 주문 생성 알림)
```

이후 주방·배달 서비스가 진행 상황에 따라 order의 `PATCH /:orderId/status` 를 호출해 주문 상태를 갱신합니다.

### 주문 상태 흐름

| 상태 | 표시명 | 갱신 주체 |
| --- | --- | --- |
| `PENDING` | 주문수락전 | order (생성 시) |
| `COOKING` | 조리중 | kitchen |
| `COOKED` | 라이더배차완료 | kitchen |
| `DELIVERING` | 라이더픽업완료 | delivery |
| `DELIVERED` | 배달완료 | delivery |

## 기술 스택

- **런타임** — Node.js 20, TypeScript, Express 5
- **DB** — PostgreSQL (Prisma ORM)
- **서비스 간 호출** — axios
- **관측성** — pino(구조화 로그) · prom-client(메트릭) · OpenTelemetry(분산 트레이싱)

## API

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| `GET` | `/health` | 헬스체크 |
| `GET` | `/metrics` | Prometheus 스크랩 엔드포인트 |
| `GET` | `/menu` | 메뉴 목록 |
| `POST` | `/:menuId?userName={userName}` | 주문 생성 (kitchen·notification 연쇄 호출) |
| `GET` | `/list?userName={userName}` | 사용자 주문 목록 |
| `GET` | `/orders/overdue?status={COOKING\|DELIVERING}&minutes={n}` | 적체 주문 조회 (배치가 사용) |
| `DELETE` | `/orders/old` | 7일 이상 지난 주문 삭제 (배치가 사용) |
| `PATCH` | `/:orderId/status` | 주문 상태 변경 (서비스 간 내부 호출용) |

> `/orders/overdue`, `/orders/old` 는 [shoong-batch](https://github.com/shoong-delivery/shoong-batch) 의 CronJob이 호출합니다.

## 데이터 모델

Prisma 스키마로 `User`, `Menu`, `Order`, `KitchenOrder`, `Delivery`, `Notification` 을 정의합니다([prisma/schema.prisma](prisma/schema.prisma)).
주문 삭제 시 연관 레코드(Notification·Delivery·KitchenOrder)를 트랜잭션으로 함께 정리합니다.

## 관측성 (Observability)

- **로그** — pino-http 로 요청을 구조화 로깅. `/health`·`/metrics` 는 노이즈라 제외, 4xx는 warn / 5xx는 error로 레벨 분기.
- **메트릭** — `/metrics` 에서 노출:
  - `order_create_total{result}` — 주문 생성 성공/실패 카운터
  - `order_status_count{status}` — 상태별 주문 수 (스크랩 시점 DB 조회로 갱신)
  - `order_orphan_cooked_count` — COOKED인데 Delivery 레코드가 없는 주문 수 (체인 호출 실패 감지용)
- **트레이싱** — `instrumentation.js` 를 `--require` 로 먼저 로드해 OTLP(gRPC)로 트레이스 전송. 엔드포인트·서비스명은 K8s ConfigMap의 env로 주입.

## CI/CD

[.github/workflows/ci.yml](.github/workflows/ci.yml) — 브랜치 전략에 따라 동작합니다.

- **PR** → lint · typecheck · test 실행. `main` 대상 PR은 `develop` 에서만 머지 가능하도록 강제.
- **`develop` push** → Docker 빌드 → Trivy 스캔(CRITICAL/HIGH) → ECR push(`dev-{sha}`) → [shoong-gitops](https://github.com/shoong-delivery/shoong-gitops) 의 `envs/dev/shoong-order.yaml` 이미지 태그 갱신.
- **`main` push** → 동일 흐름으로 `prod-{sha}` 태그 배포.
- AWS 인증은 OIDC(`AWS_ROLE_ARN`)로 처리하며, 각 단계 결과를 Slack으로 통지.

GitOps 레포의 태그가 갱신되면 ArgoCD가 이를 감지해 EKS에 롤아웃합니다.

## 로컬 실행

```bash
npm install
npx prisma generate

# 로컬 DB 포함 실행
docker compose up

# 또는 개발 모드 (별도 DB 필요)
npm run dev
```

### 주요 환경변수

| 변수 | 설명 |
| --- | --- |
| `PORT` | 서비스 포트 (기본 3001) |
| `DATABASE_URL` | PostgreSQL 접속 문자열 |
| `KITCHEN_API_URL` | 주방 서비스 base URL |
| `NOTIFICATION_API_URL` | 알림 서비스 base URL |

> 운영 환경에서는 위 값들이 SSM Parameter Store / Secrets Manager에 저장되고, External Secrets Operator가 Pod에 주입합니다.
