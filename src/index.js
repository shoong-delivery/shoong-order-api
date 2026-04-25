require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { prisma } = require('../database');

const app = express();
app.use(express.json());

// 주문 생성: POST /orders
app.post('/orders', async (req, res) => {
  try {
    const { user_id, menu_id } = req.body;

    const order = await prisma.order.create({
      data: {
        user_id,
        menu_id,
        status: 'PENDING',
      },
    });

    // Kitchen 호출
    await axios.post(`${process.env.KITCHEN_URL}/kitchen/start`, {
      order_id: order.id,
    });

    // Notification 호출
    await axios.post(`${process.env.NOTIFICATION_URL}/notify`, {
      type: 'order',
      message: '주문이 생성되었습니다',
      user_id: order.user_id,
      order_id: order.id,
    });

    res.status(201).json({ success: true, data: order });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 주문 조회: GET /orders/:orderId
app.get('/orders/:orderId', async (req, res) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: Number(req.params.orderId) },
    });
    if (!order) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, data: order });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 주문 상태 변경 (내부용): PATCH /orders/:orderId/status
app.patch('/orders/:orderId/status', async (req, res) => {
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

// 오래된 주문 삭제 (batch용): DELETE /orders/old
app.delete('/orders/old', async (req, res) => {
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

app.listen(process.env.PORT, () =>
  console.log(`[order-service] :${process.env.PORT}`)
);