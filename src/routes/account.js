import express from 'express';
import { market } from '../services/brokerService.js';
import { asyncHandler } from '../utils/errors.js';
const router = express.Router();
router.get('/profile', asyncHandler(async (_req,res)=>res.json({ok:true,data:await market.getProfile()})));
router.get('/margins', asyncHandler(async (_req,res)=>res.json({ok:true,data:await market.getMargins()})));
router.get('/holdings', asyncHandler(async (_req,res)=>res.json({ok:true,data:await market.getHoldings()})));
router.get('/positions', asyncHandler(async (_req,res)=>res.json({ok:true,data:await market.getPositions()})));
router.get('/orders', asyncHandler(async (_req,res)=>res.json({ok:true,data:await market.getOrders()})));
router.get('/trades', asyncHandler(async (_req,res)=>res.json({ok:true,data:await market.getTrades()})));
router.get('/gtts', asyncHandler(async (_req,res)=>res.json({ok:true,data:await market.getGTTs()})));
router.post('/gtts', asyncHandler(async (req,res)=>{
  const { type, condition, orders } = req.body || {};
  if (!condition?.exchange || !condition?.tradingsymbol || !Array.isArray(condition?.trigger_values) || !Array.isArray(orders) || !orders.length) {
    return res.status(400).json({ ok: false, error: { code: 'GTT_INPUT_REQUIRED', message: 'condition (exchange, tradingsymbol, trigger_values) and orders are required.' } });
  }
  res.json({ ok: true, data: await market.placeGTT({ type, condition, orders }) });
}));
router.put('/gtts/:triggerId', asyncHandler(async (req,res)=>{
  const { type, condition, orders } = req.body || {};
  res.json({ ok: true, data: await market.modifyGTT(req.params.triggerId, { type, condition, orders }) });
}));
router.delete('/gtts/:triggerId', asyncHandler(async (req,res)=>{
  res.json({ ok: true, data: await market.deleteGTT(req.params.triggerId) });
}));
export default router;
