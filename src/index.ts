import 'dotenv/config';
import express, { Request, Response } from 'express';
import axios from 'axios';
import cors from 'cors';
import pinoHttp from 'pino-http';
import { PrismaClient } from '@prisma/client';
import { registry, refreshGauges, orderCreateTotal } from './metrics';
import { logger } from './logger';

const prisma = new PrismaClient();
const app = express();
app.use(express.json());
app.use(cors());
app.use(
  pinoHttp({
    logger,
    autoLogging: {
      ignore: (req) => req.url === '/health' || req.url === '/metrics',
    },
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
  }),
);

// Health Check
app.get('/health', (_req: Request, res: Response) => res.json({ status: 'ok' }));

// Prometheus 스크랩 엔드포인트
app.get('/metrics', async (_req: Request, res: Response) => {
  try {
    await refreshGauges(prisma);
    res.set('Content-Type', registry.contentType);
    res.end(await registry.metrics());
  } catch (err) {
    logger.error({ err }, '[metrics] refresh failed');
    res.status(500).end();
  }
});

// 메뉴 조회: GET /menu
app.get('/menu', async (_req: Request, res: Response) => {
  try {
    const menus = await prisma.menu.findMany();
    res.json({
      menus: menus.map((m: { id: number; name: string }) => ({
        id: String(m.id),
        name: m.name,
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// 주문 생성: POST /:menuId
app.post('/:menuId', async (req: Request, res: Response) => {
  try {
    const menuId = Number(req.params.menuId);
    const userName = req.query.userName as string;

    const user = await prisma.user.findUnique({ where: { username: userName } });
    if (!user) {
      orderCreateTotal.labels('fail').inc();
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const order = await prisma.order.create({
      data: { user_id: user.id, menu_id: menuId, status: 'PENDING' },
    });

    await axios.post(`${process.env.KITCHEN_API_URL}/start`, { order_id: order.id });
    await axios.post(`${process.env.NOTIFICATION_API_URL}`, {
      type: 'order',
      message: '주문이 생성되었습니다',
      user_id: order.user_id,
      order_id: order.id,
    });

    orderCreateTotal.labels('success').inc();
    logger.info({ order_id: order.id, user_id: user.id, menu_id: menuId }, 'order created');
    res.status(201).json({ success: true, data: order });
  } catch (err) {
    orderCreateTotal.labels('fail').inc();
    logger.error({ err }, 'order create failed');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

const STATUS_MAP: Record<string, string> = {
  PENDING: '주문수락전',
  COOKING: '조리중',
  COOKED: '라이더배차완료',
  DELIVERING: '라이더픽업완료',
  DELIVERED: '배달완료',
};

// 주문 목록 조회: GET /list
app.get('/list', async (req: Request, res: Response) => {
  try {
    const { userName } = req.query as { userName: string };

    const user = await prisma.user.findUnique({ where: { username: userName } });
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    const orders = await prisma.order.findMany({
      where: { user_id: user.id },
      include: { Menu: true },
    });

    res.json({
      orders: orders.map((o: { Menu: { id: number; name: string }; status: string }) => ({
        menu: { id: String(o.Menu.id), name: o.Menu.name },
        status: STATUS_MAP[o.status] ?? o.status,
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// 적체 주문 조회: GET /orders/overdue?status=COOKING&minutes=3
// 배치(shoong-batch)가 자동 진행시킬 대상을 찾기 위해 사용
app.get('/orders/overdue', async (req: Request, res: Response) => {
  try {
    const status = req.query.status as string;
    const minutes = Number(req.query.minutes);

    if (!status || !Number.isFinite(minutes) || minutes <= 0) {
      return res.status(400).json({
        success: false,
        error: 'status and positive minutes are required',
      });
    }

    const cutoff = new Date(Date.now() - minutes * 60 * 1000);
    let orderIds: number[] = [];

    if (status === 'COOKING') {
      const rows = await prisma.kitchenOrder.findMany({
        where: { status: 'COOKING', cook_started_at: { lt: cutoff } },
        select: { order_id: true },
        take: 100,
      });
      orderIds = rows.map((r) => r.order_id);
    } else if (status === 'DELIVERING') {
      const rows = await prisma.delivery.findMany({
        where: { status: 'DELIVERING', delivery_started_at: { lt: cutoff } },
        select: { order_id: true },
        take: 100,
      });
      orderIds = rows.map((r) => r.order_id);
    } else {
      return res.status(400).json({
        success: false,
        error: 'status must be COOKING or DELIVERING',
      });
    }

    res.json({ success: true, order_ids: orderIds });
  } catch (err) {
    logger.error({ err }, '[overdue] query failed');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// 오래된 주문 삭제: DELETE /orders/old (7일 이상)
app.delete('/orders/old', async (_req: Request, res: Response) => {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);

    const oldOrders = await prisma.order.findMany({
      where: { created_at: { lt: cutoff } },
      select: { id: true },
    });

    const orderIds = oldOrders.map((o) => o.id);

    if (orderIds.length === 0) {
      return res.json({ success: true, deleted: 0 });
    }

    await prisma.$transaction([
      prisma.notification.deleteMany({ where: { order_id: { in: orderIds } } }),
      prisma.delivery.deleteMany({ where: { order_id: { in: orderIds } } }),
      prisma.kitchenOrder.deleteMany({ where: { order_id: { in: orderIds } } }),
      prisma.order.deleteMany({ where: { id: { in: orderIds } } }),
    ]);

    logger.info({ deleted: orderIds.length }, '[cleanup] old orders deleted');
    res.json({ success: true, deleted: orderIds.length });
  } catch (err) {
    logger.error({ err }, '[cleanup] delete failed');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// 주문 상태 변경: PATCH /:orderId/status
app.patch('/:orderId/status', async (req: Request, res: Response) => {
  try {
    const order = await prisma.order.update({
      where: { id: Number(req.params.orderId) },
      data: { status: req.body.status },
    });
    res.json({ success: true, data: order });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () =>
  logger.info({ port: PORT }, 'order-service listening'),
);

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down');
  await prisma.$disconnect();
  server.close(() => process.exit(0));
});
