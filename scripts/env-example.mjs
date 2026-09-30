// Write .env.example from the settings table (src/settings.js): `npm run settings:example`.
import { writeFileSync } from 'node:fs';
import { renderEnvExample } from '../src/settings.js';

writeFileSync(new URL('../.env.example', import.meta.url), renderEnvExample());
console.log('wrote .env.example from src/settings.js');
