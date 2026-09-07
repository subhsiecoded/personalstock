import express from 'express';
import { market } from '../services/brokerService.js';
import { asyncHandler, AppError } from '../utils/errors.js';
const router = express.Router();

const TRANSACTION_TYPES = ['BUY', 'SELL'];
const PRODUCTS = ['CNC', 'MIS', 'NRML'];
const ORDER_TYPES = ['MARKET', 'LIMIT', 'SL', 'SL-M'];
const VALIDITIES = ['DAY', 'IOC', 'TTL'];

function validateOrderPayload(body) {
  const {
    exchange, tradingsymbol, transaction_type, quantity,
    product, order_type, price, trigger_price, validity,
  } = body || {};

  if (!exchange || !tradingsymbol) throw new AppError('exchange and tradingsymbol are required.', 400, 'ORDER_INPUT_REQUIRED');
  if (!TRANSACTION_TYPES.includes(transaction_type)) throw new AppError('transaction_type must be BUY or SELL.', 400, 'ORDER_INPUT_REQUIRED');
  if (!Number.isFinite(Number(quantity)) || Number(quantity) <= 0) throw new AppError('quantity must be a positive number.', 400, 'ORDER_INPUT_REQUIRED');
  if (!PRODUCTS.includes(product)) throw new AppError('product must be one of CNC, MIS, NRML.', 400, 'ORDER_INPUT_REQUIRED');
  if (!ORDER_TYPES.includes(order_type)) throw new AppError('order_type must be one of MARKET, LIMIT, SL, SL-M.', 400, 'ORDER_INPUT_REQUIRED');
  if (['LIMIT', 'SL'].includes(order_type) && !(Number(price) > 0)) throw new AppError('price is required for LIMIT/SL orders.', 400, 'ORDER_INPUT_REQUIRED');
  if (['SL', 'SL-M'].includes(order_type) && !(Number(trigger_price) > 0)) throw new AppError('trigger_price is required for SL/SL-M orders.', 400, 'ORDER_INPUT_REQUIRED');

  return {
    exchange: String(exchange).toUpperCase(),
    tradingsymbol: String(tradingsymbol).toUpperCase(),
    transaction_type,
    quantity: Number(quantity),
    product,
    order_type,
    price: price != null ? Number(price) : undefined,
    trigger_price: trigger_price != null ? Number(trigger_price) : undefined,
    validity: VALIDITIES.includes(validity) ? validity : 'DAY',
    variety: body.variety || 'regular',
    tag: body.tag ? String(body.tag).slice(0, 20) : undefined,
  };
}

router.post('/', asyncHandler(async (req, res) => {
  const payload = validateOrderPayload(req.body);
  const result = await market.placeOrder(payload);
  res.json({ ok: true, data: result });
}));

router.put('/:orderId', asyncHandler(async (req, res) => {
  const { orderId } = req.params;
  const { order_type, quantity, price, trigger_price, validity, variety } = req.body || {};
  if (!orderId) throw new AppError('orderId is required.', 400, 'ORDER_INPUT_REQUIRED');
  const result = await market.modifyOrder(orderId, {
    order_type, quantity: quantity != null ? Number(quantity) : undefined,
    price: price != null ? Number(price) : undefined,
    trigger_price: trigger_price != null ? Number(trigger_price) : undefined,
    validity, variety,
  });
  res.json({ ok: true, data: result });
}));

router.delete('/:orderId', asyncHandler(async (req, res) => {
  const { orderId } = req.params;
  const variety = req.query.variety || 'regular';
  const result = await market.cancelOrder(orderId, variety);
  res.json({ ok: true, data: result });
}));

router.get('/:orderId/history', asyncHandler(async (req, res) => {
  res.json({ ok: true, data: await market.getOrderHistory(req.params.orderId) });
}));

router.get('/:orderId/trades', asyncHandler(async (req, res) => {
  res.json({ ok: true, data: await market.getOrderTrades(req.params.orderId) });
}));

router.post('/margins', asyncHandler(async (req, res) => {
  const orders = Array.isArray(req.body?.orders) ? req.body.orders : [];
  if (!orders.length) throw new AppError('orders must be a non-empty array.', 400, 'ORDER_INPUT_REQUIRED');
  res.json({ ok: true, data: await market.getOrderMargins(orders) });
}));

export default router;
