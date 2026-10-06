import { createServer } from 'node:http';
import { createApp } from './app.js';
import { config } from './config.js';
import { db } from './db.js';
import { realtime } from './realtime.js';
import { documentOperation, flushAll } from './documents.js';
const server=createServer(createApp());
const sockets=realtime(server);
server.listen(config.PORT,()=>console.log(`CodeSync API listening on ${config.PORT}`));
let stopping=false;
async function shutdown(){if(stopping)return;stopping=true;try{await new Promise<void>(resolve=>sockets.close(()=>resolve()));await documentOperation(flushAll);await db.$disconnect();process.exit(0);}catch(e){console.error(e);process.exit(1);}}
process.on('SIGTERM',()=>void shutdown());process.on('SIGINT',()=>void shutdown());
