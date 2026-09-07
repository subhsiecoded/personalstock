export function setupSocket(io, market) {
  io.on('connection', socket => {
    socket.emit('server_status', market.status());
    const offTick = market.onTick(tick => socket.emit('market_tick', tick));
    const offStatus = market.onStatus(status => socket.emit('server_status', status));
    const offOrder = market.onOrder(order => socket.emit('order_update', order));
    socket.on('subscribe', payload => market.subscribe(Array.isArray(payload?.tokens) ? payload.tokens : [], { focus: Boolean(payload?.focus) }));
    socket.on('focus', payload => market.focus(payload?.token));
    socket.on('unsubscribe', payload => market.unsubscribe(Array.isArray(payload?.tokens) ? payload.tokens : []));
    socket.on('disconnect', () => { offTick(); offStatus(); offOrder(); });
  });
}
