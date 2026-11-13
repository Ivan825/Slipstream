#!/usr/bin/env node
import { startSimulator } from './runner.js';

const sim = startSimulator();
const shutdown = () => { sim.stop(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
