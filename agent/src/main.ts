import { AgentService } from './agent.service';
import { childProcessRegistry } from './process-registry';

const agent = new AgentService();
agent.start();

// Graceful shutdown.
// Порядок важен:
// 1. Убиваем всех spawned-детей (restic dump'ы и т.п.) — иначе они
//    станут осиротевшими (PPID=1) и продолжат впустую дампить.
// 2. Останавливаем сам agent (закрываем socket).
// 3. process.exit.
//
// PM2 default kill_timeout = 5s; в ecosystem.config.js поднят до 30s,
// чтобы успеть прибить активные restic-процессы и закрыть стримы.
let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Agent] Shutting down (signal=${signal})...`);
  try {
    // 5s SIGTERM grace, потом SIGKILL остаткам.
    await childProcessRegistry.killAll(5000);
  } catch (e) {
    console.warn(`[Agent] killAll failed: ${(e as Error).message}`);
  }
  try {
    agent.stop();
  } catch (e) {
    console.warn(`[Agent] stop failed: ${(e as Error).message}`);
  }
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
