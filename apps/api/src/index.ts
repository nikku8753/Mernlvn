import { createServer } from 'node:http';
import { createApp } from './app.js';
import { config } from './config.js';
import { realtime } from './realtime.js';
import { flushAll } from './documents.js';
import { db } from './db.js';
const server=createServer(createApp());const io=realtime(server);
server.listen(config.PORT,()=>console.log(`CodeSync API listening on ${config.PORT}`));
let stopping=false;
async function shutdown(){if(stopping)return;stopping=true;try{await new Promise<void>(resolve=>io.close(()=>resolve()));await flushAll();await db.$disconnect();process.exit(0);}catch(e){console.error(e);process.exit(1);}}
process.on('SIGTERM',()=>void shutdown());process.on('SIGINT',()=>void shutdown());
