import { Injectable, Logger } from '@nestjs/common';
import { ChildProcess, spawn } from 'child_process';
import { PrismaService } from '../common/prisma.service';
import { randomUUID } from 'crypto';
import * as readline from 'readline';

export interface AiEventCallback {
  (event: AiEvent): void;
}

export type AiEvent =
  | { type: 'system'; subtype: string; sessionId: string; data?: unknown }
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use_start'; toolId: string; toolName: string }
  | { type: 'tool_use_input'; toolId: string; json: string }
  | { type: 'tool_use_done'; toolId: string; toolName: string; input: unknown }
  | { type: 'tool_result'; toolId: string; output: string; isError: boolean }
  | { type: 'result'; sessionId: string; cost?: number; duration?: number; numTurns?: number; isError: boolean; errorMessage?: string }
  | { type: 'error'; message: string };

/** Stored message format (persisted to DB as JSON) */
interface StoredToolCall {
  toolId: string;
  toolName: string;
  input: string;
  output: string;
  isError: boolean;
}

interface StoredMessage {
  role: 'user' | 'assistant';
  text: string;
  thinking?: string;
  toolCalls?: StoredToolCall[];
}

interface ActiveProcess {
  proc: ChildProcess;
  userId: string;
  dbSessionId: string;
  claudeSessionId: string | null;
  /** Accumulated messages for this session (loaded from DB + new) */
  messages: StoredMessage[];
  /** Current assistant message being built during streaming */
  currentAssistant: StoredMessage | null;
  /** Current tool call being built */
  currentToolId: string;
  currentToolName: string;
  /** AskUserQuestion detected — will kill process on block stop */
  questionPending: boolean;
  /** Process was killed intentionally — skip further event processing */
  killed: boolean;
}

@Injectable()
export class AiService {
  private readonly logger = new Logger('AiService');
  private readonly active = new Map<string, ActiveProcess>();

  constructor(private readonly prisma: PrismaService) {}

  async startSession(
    userId: string,
    prompt: string,
    onEvent: AiEventCallback,
    options?: { cwd?: string; resumeSessionId?: string },
  ): Promise<string> {
    // Kill any existing process for this user
    for (const [key, ap] of this.active) {
      if (ap.userId === userId) {
        this.killProcess(key);
      }
    }

    const processId = randomUUID();
    let claudeSessionId: string | null = null;
    let dbSessionId: string | null = null;
    let existingMessages: StoredMessage[] = [];

    // If resuming, look up the claude session id and load messages
    if (options?.resumeSessionId) {
      const existing = await this.prisma.aiSession.findFirst({
        where: { id: options.resumeSessionId, userId },
      });
      if (existing) {
        claudeSessionId = existing.claudeSessionId;
        dbSessionId = existing.id;
        try {
          const parsed = JSON.parse(existing.messages ?? '[]');
          existingMessages = Array.isArray(parsed) ? (parsed as StoredMessage[]) : [];
        } catch {
          existingMessages = [];
        }
      }
    }

    // cwd: по умолчанию — корень Meowbox, а не `/`, чтобы Claude не получал
    // прямой доступ к /etc, /root и т.п. без явного указания. Клиент может
    // задать свой cwd, но он обязан существовать и не быть system-путём.
    const defaultCwd = process.env.AI_DEFAULT_CWD || process.cwd();
    const cwd = this.resolveSafeCwd(options?.cwd, defaultCwd);

    const systemPrompt = [
      'Ты AI-ассистент для управления сервером через панель Meowbox.',
      'Отвечай на русском языке. Будь краток и конкретен.',
      'Когда нужно задать пользователю вопросы — ВСЕГДА используй инструмент AskUserQuestion с интерактивными кнопками.',
      'Никогда не пиши вопросы обычным текстом — только через AskUserQuestion.',
    ].join(' ');

    // Permission mode настраивается через env. Default остаётся bypass
    // (иначе UI зависнет на интерактивных prompt-ах Claude), но на production
    // админ может выставить AI_PERMISSION_MODE=acceptEdits, чтобы Claude не
    // выполнял произвольные bash-команды без подтверждения.
    const permissionMode = process.env.AI_PERMISSION_MODE || 'bypassPermissions';
    const allowedModes = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
    const effectiveMode = allowedModes.includes(permissionMode)
      ? permissionMode
      : 'bypassPermissions';

    const args = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode', effectiveMode,
      '--append-system-prompt', systemPrompt,
    ];

    if (claudeSessionId) {
      args.push('--resume', claudeSessionId);
    }

    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    this.logger.log(`Spawning claude process (processId=${processId}, resume=${claudeSessionId || 'new'})`);

    const proc = spawn('claude', args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.stdin.end();

    // Add user message to accumulated messages
    const messages = [...existingMessages, { role: 'user' as const, text: prompt }];

    const ap: ActiveProcess = {
      proc,
      userId,
      dbSessionId: dbSessionId || '',
      claudeSessionId,
      messages,
      currentAssistant: null,
      currentToolId: '',
      currentToolName: '',
      questionPending: false,
      killed: false,
    };
    this.active.set(processId, ap);

    const rl = readline.createInterface({ input: proc.stdout!, crlfDelay: Infinity });

    rl.on('line', (line) => {
      if (ap.killed || !line.trim()) return;
      try {
        const msg = JSON.parse(line);
        this.handleMessage(msg, processId, ap, onEvent);
      } catch {
        // Non-JSON line — ignore
      }
    });

    let stderrBuf = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    proc.on('close', (code, signal) => {
      this.active.delete(processId);
      this.logger.log(`Claude process exited (processId=${processId}, code=${code}, signal=${signal})`);
      if (code !== 0 && code !== null && code !== 143 && code !== 137) {
        const errMsg = stderrBuf.trim().slice(0, 500) || `Claude process exited with code ${code}`;
        onEvent({ type: 'error', message: errMsg });
      }
    });

    proc.on('error', (err) => {
      this.active.delete(processId);
      onEvent({ type: 'error', message: err.message });
      this.logger.error(`Claude process error: ${err.message}`);
    });

    return processId;
  }

  /**
   * Нормализует запрошенный cwd. Разрешены только абсолютные пути внутри
   * SITES_BASE_PATH, BACKUP_LOCAL_PATH или корня проекта Meowbox. Иначе —
   * `defaultCwd`. Защищает от «claude --cwd /etc» через payload.
   */
  private resolveSafeCwd(requested: string | undefined, defaultCwd: string): string {
    if (!requested || typeof requested !== 'string') return defaultCwd;
    const path = require('path') as typeof import('path');
    const fs = require('fs') as typeof import('fs');

    if (!path.isAbsolute(requested) || requested.includes('\0')) return defaultCwd;
    const resolved = path.resolve(requested);

    const allowedRoots = [
      process.env.SITES_BASE_PATH || '/var/www',
      process.env.BACKUP_LOCAL_PATH || '/var/meowbox/backups',
      process.cwd(),
      defaultCwd,
    ].map((p) => path.resolve(p));

    const ok = allowedRoots.some(
      (root) => resolved === root || resolved.startsWith(root + path.sep),
    );
    if (!ok) {
      this.logger.warn(`AI cwd rejected (outside allowed roots): ${requested}`);
      return defaultCwd;
    }

    try {
      if (!fs.statSync(resolved).isDirectory()) return defaultCwd;
    } catch {
      return defaultCwd;
    }
    return resolved;
  }

  private ensureAssistant(ap: ActiveProcess): StoredMessage {
    if (!ap.currentAssistant) {
      ap.currentAssistant = { role: 'assistant', text: '', thinking: '', toolCalls: [] };
    }
    return ap.currentAssistant;
  }

  private handleMessage(
    msg: Record<string, unknown>,
    processId: string,
    ap: ActiveProcess,
    onEvent: AiEventCallback,
  ) {
    const type = msg.type as string;

    if (type === 'system') {
      const sessionId = msg.session_id as string;
      if (sessionId && !ap.claudeSessionId) {
        ap.claudeSessionId = sessionId;
      }
      onEvent({ type: 'system', subtype: msg.subtype as string, sessionId: sessionId || '', data: msg });
      return;
    }

    if (type === 'assistant') {
      const content = msg.content as Array<Record<string, unknown>> | undefined;
      if (!content) return;
      // Complete assistant message — extract tool_use blocks
      const msgObj = (msg.message || msg) as Record<string, unknown>;
      const blocks = (msgObj.content || content) as Array<Record<string, unknown>>;
      for (const block of blocks) {
        if (block.type === 'tool_use') {
          onEvent({
            type: 'tool_use_done',
            toolId: block.id as string,
            toolName: block.name as string,
            input: block.input,
          });
          // Update stored tool call input with final parsed version
          const assistant = this.ensureAssistant(ap);
          const tc = assistant.toolCalls?.find(t => t.toolId === block.id);
          if (tc) {
            try { tc.input = JSON.stringify(block.input, null, 2); } catch { /* keep raw */ }
          }
        }
      }
      return;
    }

    if (type === 'user') {
      const content = msg.content as Array<Record<string, unknown>> | undefined;
      if (!content) return;
      for (const block of content) {
        if (block.type === 'tool_result') {
          let output = '';
          const c = block.content;
          if (typeof c === 'string') {
            output = c;
          } else if (Array.isArray(c)) {
            output = (c as Array<Record<string, unknown>>)
              .filter((b) => b.type === 'text')
              .map((b) => b.text as string)
              .join('\n');
          }
          const trimmedOutput = output.slice(0, 50_000);
          onEvent({
            type: 'tool_result',
            toolId: block.tool_use_id as string,
            output: trimmedOutput,
            isError: !!block.is_error,
          });
          // Store in current assistant
          const assistant = this.ensureAssistant(ap);
          const tc = assistant.toolCalls?.find(t => t.toolId === block.tool_use_id);
          if (tc) {
            tc.output = trimmedOutput.slice(0, 5_000); // Trim for DB storage
            tc.isError = !!block.is_error;
          }
        }
      }
      return;
    }

    if (type === 'result') {
      // Finalize current assistant message and save
      if (ap.currentAssistant) {
        ap.messages.push(ap.currentAssistant);
        ap.currentAssistant = null;
      }

      const claudeSid = msg.session_id as string;
      if (claudeSid) {
        ap.claudeSessionId = claudeSid;
      }

      // Save session FIRST, then emit result (so ap.dbSessionId is set)
      const emitResult = () => {
        onEvent({
          type: 'result',
          sessionId: ap.dbSessionId || claudeSid || '',
          cost: msg.total_cost_usd as number | undefined,
          duration: msg.duration_ms as number | undefined,
          numTurns: msg.num_turns as number | undefined,
          isError: !!msg.is_error,
          errorMessage: msg.is_error ? (msg.result as string) : undefined,
        });
      };

      if (claudeSid) {
        this.saveSession(ap, claudeSid).then(emitResult).catch((err) => {
          this.logger.error(`Failed to save session: ${(err as Error).message}`);
          emitResult();
        });
      } else {
        emitResult();
      }
      return;
    }

    if (type === 'stream_event') {
      this.handleStreamEvent(msg.event as Record<string, unknown>, processId, ap, onEvent);
      return;
    }
  }

  private handleStreamEvent(
    event: Record<string, unknown>,
    processId: string,
    ap: ActiveProcess,
    onEvent: AiEventCallback,
  ) {
    if (!event) return;
    const eventType = event.type as string;

    if (eventType === 'content_block_start') {
      const block = event.content_block as Record<string, unknown> | undefined;
      if (block?.type === 'tool_use') {
        const id = (block.id as string) || '';
        const name = (block.name as string) || '';
        ap.currentToolId = id;
        ap.currentToolName = name;
        if (name === 'AskUserQuestion') {
          ap.questionPending = true;
        }
        onEvent({ type: 'tool_use_start', toolId: id, toolName: name });
        // Add to stored assistant
        const assistant = this.ensureAssistant(ap);
        assistant.toolCalls!.push({ toolId: id, toolName: name, input: '', output: '', isError: false });
      }
    }

    // When AskUserQuestion tool input is complete — kill process before auto-answer
    if (eventType === 'content_block_stop' && ap.questionPending && ap.currentToolName === 'AskUserQuestion') {
      this.logger.log(`AskUserQuestion detected — pausing for user answer (dbSession=${ap.dbSessionId})`);
      ap.killed = true;

      // Kill process immediately to prevent auto-answer
      try { ap.proc.kill('SIGTERM'); } catch { /* ignore */ }
      this.active.delete(processId);

      // Finalize current assistant and save session
      if (ap.currentAssistant) {
        ap.messages.push(ap.currentAssistant);
        ap.currentAssistant = null;
      }

      const emitQuestionResult = () => {
        onEvent({
          type: 'result',
          sessionId: ap.dbSessionId || ap.claudeSessionId || '',
          isError: false,
        });
      };

      if (ap.claudeSessionId) {
        this.saveSession(ap, ap.claudeSessionId).then(emitQuestionResult).catch(err => {
          this.logger.error(`Failed to save session on question pause: ${(err as Error).message}`);
          emitQuestionResult();
        });
      } else {
        emitQuestionResult();
      }
      return;
    }

    if (eventType === 'content_block_delta') {
      const delta = event.delta as Record<string, unknown> | undefined;
      if (!delta) return;

      if (delta.type === 'text_delta') {
        const text = delta.text as string;
        onEvent({ type: 'text', text });
        this.ensureAssistant(ap).text += text;
      } else if (delta.type === 'thinking_delta') {
        const text = delta.thinking as string;
        onEvent({ type: 'thinking', text });
        const a = this.ensureAssistant(ap);
        a.thinking = (a.thinking || '') + text;
      } else if (delta.type === 'input_json_delta') {
        const json = delta.partial_json as string;
        onEvent({
          type: 'tool_use_input',
          toolId: ap.currentToolId,
          json,
        });
        // Accumulate raw input in stored tool call
        const tc = this.ensureAssistant(ap).toolCalls?.find(t => t.toolId === ap.currentToolId);
        if (tc) tc.input += json;
      }
    }
  }

  private async saveSession(ap: ActiveProcess, claudeSessionId: string) {
    const messagesJson = JSON.stringify(ap.messages);
    if (ap.dbSessionId) {
      await this.prisma.aiSession.update({
        where: { id: ap.dbSessionId },
        data: { claudeSessionId, messages: messagesJson, updatedAt: new Date() },
      });
    } else {
      const session = await this.prisma.aiSession.create({
        data: {
          userId: ap.userId,
          claudeSessionId,
          messages: messagesJson,
          cwd: '/',
        },
      });
      ap.dbSessionId = session.id;
    }
  }

  stopForUser(userId: string) {
    for (const [key, ap] of this.active) {
      if (ap.userId === userId) {
        this.killProcess(key);
      }
    }
  }

  private killProcess(processId: string) {
    const ap = this.active.get(processId);
    if (!ap) return;
    try {
      ap.proc.kill('SIGTERM');
    } catch { /* ignore */ }
    this.active.delete(processId);
  }

  async listSessions(userId: string) {
    return this.prisma.aiSession.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        title: true,
        cwd: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async getSession(id: string, userId: string) {
    const s = await this.prisma.aiSession.findFirst({
      where: { id, userId },
      select: {
        id: true,
        title: true,
        cwd: true,
        messages: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!s) return null;
    let messages: unknown[] = [];
    try {
      const parsed = JSON.parse(s.messages ?? '[]');
      messages = Array.isArray(parsed) ? parsed : [];
    } catch {
      messages = [];
    }
    return { ...s, messages };
  }

  async deleteSession(id: string, userId: string) {
    return this.prisma.aiSession.deleteMany({
      where: { id, userId },
    });
  }

  async renameSession(id: string, userId: string, title: string) {
    return this.prisma.aiSession.updateMany({
      where: { id, userId },
      data: { title },
    });
  }

  isActive(userId: string): boolean {
    for (const ap of this.active.values()) {
      if (ap.userId === userId) return true;
    }
    return false;
  }

  getActiveDbSessionId(userId: string): string | null {
    for (const ap of this.active.values()) {
      if (ap.userId === userId) return ap.dbSessionId || null;
    }
    return null;
  }
}
