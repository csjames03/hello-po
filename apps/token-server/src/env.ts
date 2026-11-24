// Loads the repo-root .env. Imported first by index.ts, so every other module sees the values
// when it is evaluated (ES module imports run before the importing module's own code).
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });
