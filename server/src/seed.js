import mongoose from 'mongoose';
import { config } from './config.js';
import { ensureDemoUsers, DEMO_PASSWORD } from './auth.js';
import { apiKeyFor } from './lib/keys.js';
import { CARS } from '@slipstream/shared';

await mongoose.connect(config.mongoUri);
await ensureDemoUsers();
console.log(`Demo users ready. Password for every account: ${DEMO_PASSWORD}`);
console.log('Data-source API keys (derived from INGEST_SECRET):');
for (const c of CARS.slice(0, 3)) console.log(`  ${c.id.padEnd(4)} ${apiKeyFor(c.id, config.ingestSecret)}`);
console.log('  ...');
await mongoose.disconnect();
