import { EV, NS } from '@slipstream/shared';
import { config } from '../config.js';
import { verifyApiKey } from '../lib/keys.js';
import { log } from '../lib/log.js';

/**
 * /ingest namespace: data sources (one socket per car) and the simulator
 * controller. Authenticated with HMAC API keys; every telemetry batch is
 * acknowledged with what happened to it.
 */
export function attachIngest(io, hub) {
  const nsp = io.of(NS.INGEST);
  hub.sources = new Map();

  nsp.use((socket, next) => {
    const source = verifyApiKey(socket.handshake.auth?.apiKey, config.ingestSecret);
    if (!source) return next(new Error('unauthorized: invalid api key'));
    socket.data.source = source;
    next();
  });

  nsp.on('connection', (socket) => {
    const source = socket.data.source;
    if (source === 'sim') {
      socket.join('controllers');
      socket.emit(EV.SIM_STATE, hub.simState());
      log.info('simulator controller connected');
      return;
    }
    hub.sources.set(source, (hub.sources.get(source) || 0) + 1);
    let floods = 0;

    socket.on(EV.TELEMETRY, (batch, ack) => {
      const res = hub.ingest(source, batch);
      if (typeof ack === 'function') ack(res);
      // a source that keeps blowing through its rate limit gets disconnected
      floods = res.limited > 0 ? floods + 1 : Math.max(0, floods - 1);
      if (floods > 100) {
        log.warn(`source ${source} disconnected for flooding`);
        socket.disconnect(true);
      }
    });

    socket.on('disconnect', () => {
      const n = (hub.sources.get(source) || 1) - 1;
      if (n <= 0) hub.sources.delete(source); else hub.sources.set(source, n);
    });
  });

  hub.on('sim:state', (s) => nsp.to('controllers').emit(EV.SIM_STATE, s));
  hub.on('sim:command', (cmd) => nsp.to('controllers').emit(EV.SIM_COMMAND, cmd));
  return nsp;
}
