import 'dotenv/config';
import express, { Request, Response } from 'express';
import axios from 'axios';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const app = express();
app.use(express.json());
app.use(cors());

// Health Check
app.get('/health', (_req: Request, res: Response) => res.json({ status: 'ok' }));

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
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

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

    res.status(201).json({ success: true, data: order });
  } catch (err) {
    console.error(err);
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

const server = app.listen(process.env.PORT, () =>
  console.log(`[order-service] :${process.env.PORT}`)
);

process.on('SIGTERM', async () => {
  console.log('[order-service] SIGTERM received, shutting down...');
  await prisma.$disconnect();
  server.close(() => process.exit(0));
});
