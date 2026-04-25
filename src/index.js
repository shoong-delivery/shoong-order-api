require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const app = express();
app.use(express.json());

const cors = require("cors");
app.use(cors());

// Health Check (EKS probe용)
app.get("/health", (req, res) => res.json({ status: "ok" }));

// 메뉴 조회: GET /order/menu
app.get("/order/menu", async (req, res) => {
  try {
    const menus = await prisma.menu.findMany();
    res.json({
      menus: menus.map((m) => ({
        id: String(m.id),
        name: m.name,
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 오래된 주문 삭제: DELETE /order/old
app.delete("/order/old", async (req, res) => {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);

    const deleted = await prisma.order.deleteMany({
      where: { created_at: { lt: cutoff } },
    });

    res.json({ success: true, deleted: deleted.count });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 주문 생성: POST /order
app.post("/order/:menuId", async (req, res) => {
  try {
    const menuId = Number(req.params.menuId);
    const userName = req.query.userName;

    // userName으로 user 조회
    const user = await prisma.user.findUnique({
      where: { username: userName },
    });

    if (!user)
      return res.status(404).json({ success: false, error: "User not found" });

    const order = await prisma.order.create({
      data: { user_id: user.id, menu_id: menuId, status: "PENDING" },
    });

    await axios.post(`${process.env.KITCHEN_URL}/kitchen/start`, {
      order_id: order.id,
    });

    await axios.post(`${process.env.NOTIFICATION_URL}/alarms`, {
      type: "order",
      message: "주문이 생성되었습니다",
      user_id: order.user_id,
      order_id: order.id,
    });

    res.status(201).json({ success: true, data: order });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 주문 조회: GET /order/:orderId
const STATUS_MAP = {
  PENDING: "주문수락전",
  COOKING: "조리중",
  COOKED: "라이더배차완료",
  DELIVERING: "라이더픽업완료",
  DELIVERED: "배달완료",
};

app.get("/orders", async (req, res) => {
  try {
    const { userName } = req.query;

    const user = await prisma.user.findUnique({
      where: { username: userName },
    });

    if (!user)
      return res.status(404).json({ success: false, error: "User not found" });

    const orders = await prisma.order.findMany({
      where: { user_id: user.id },
      include: { Menu: true },
    });

    res.json({
      orders: orders.map((o) => ({
        menu: {
          id: String(o.Menu.id),
          name: o.Menu.name,
        },
        status: STATUS_MAP[o.status] ?? o.status,
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 주문 상태 변경: PATCH /order/:orderId/status
app.patch("/order/:orderId/status", async (req, res) => {
  try {
    const order = await prisma.order.update({
      where: { id: Number(req.params.orderId) },
      data: { status: req.body.status },
    });
    res.json({ success: true, data: order });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const server = app.listen(process.env.PORT, () =>
  console.log(`[order-service] :${process.env.PORT}`)
);

process.on("SIGTERM", async () => {
  console.log("[order-service] SIGTERM received, shutting down...");
  await prisma.$disconnect();
  server.close(() => process.exit(0));
});