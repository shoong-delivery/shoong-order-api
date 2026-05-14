import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';
import { PrismaClient } from '@prisma/client';

export const registry = new Registry();

// process_cpu_*, nodejs_eventloop_lag 등 기본 메트릭
collectDefaultMetrics({ register: registry });

// 주문 생성 시도 횟수 (성공/실패 라벨)
export const orderCreateTotal = new Counter({
  name: 'order_create_total',
  help: 'Total order creation attempts',
  labelNames: ['result'] as const,
  registers: [registry],
});

// 상태별 주문 수 (스크랩 시점에 DB 조회로 갱신)
export const orderStatusCount = new Gauge({
  name: 'order_status_count',
  help: 'Current number of orders in each status',
  labelNames: ['status'] as const,
  registers: [registry],
});

// COOKED인데 Delivery 레코드 없는 주문 수 (체인 호출 실패 신호)
export const orderOrphanCookedCount = new Gauge({
  name: 'order_orphan_cooked_count',
  help: 'Orders stuck in COOKED status without Delivery record',
  registers: [registry],
});

const KNOWN_STATUSES = ['PENDING', 'COOKING', 'COOKED', 'DELIVERING', 'DELIVERED'];

// /metrics 호출 시점에 게이지를 DB 기준으로 갱신
export async function refreshGauges(prisma: PrismaClient): Promise<void> {
  const grouped = await prisma.order.groupBy({
    by: ['status'],
    _count: { _all: true },
  });

  const countMap = new Map(grouped.map((g) => [g.status, g._count._all]));
  for (const status of KNOWN_STATUSES) {
    orderStatusCount.labels(status).set(countMap.get(status) ?? 0);
  }

  const orphans = await prisma.order.count({
    where: { status: 'COOKED', Delivery: null },
  });
  orderOrphanCookedCount.set(orphans);
}
