import 'dotenv/config';
import { z } from 'zod';
export const config = z.object({
  DATABASE_URL: z.string().min(1), PORT: z.coerce.number().default(4000),
  WEB_ORIGIN: z.url().default('http://localhost:3000'),
  NODE_ENV: z.enum(['development','test','production']).default('development'),
  COOKIE_CROSS_SITE: z.enum(['true','false']).default('false'),
  EXECUTION_URL: z.string().default(''), EXECUTION_API_KEY: z.string().default(''),
}).parse(process.env);
