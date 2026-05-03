<template>
  <div class="ai-page">
    <!-- Sessions sidebar -->
    <aside class="ai-sidebar" :class="{ 'ai-sidebar--open': showSidebar }">
      <div class="ai-sidebar__head">
        <span class="ai-sidebar__label">Чаты</span>
        <button class="ai-sidebar__new" @click="newChat" title="Новый чат">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
        </button>
      </div>
      <div class="ai-sidebar__list">
        <button
          v-for="s in sessions"
          :key="s.id"
          class="ai-session"
          :class="{ 'ai-session--active': activeSessionId === s.id }"
          @click="selectSession(s)"
        >
          <span class="ai-session__title">{{ s.title || 'Без названия' }}</span>
          <span class="ai-session__date">{{ formatDate(s.updatedAt) }}</span>
          <span class="ai-session__del" @click.stop="deleteSession(s.id)" title="Удалить">&times;</span>
        </button>
        <div v-if="!sessions.length && !sessionsLoading" class="ai-sidebar__empty">
          Нет чатов
        </div>
      </div>
    </aside>

    <!-- Chat area -->
    <div class="ai-chat">
      <!-- Mobile sidebar toggle -->
      <button class="ai-chat__toggle" @click="showSidebar = !showSidebar">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="15" y2="12" /><line x1="3" y1="18" x2="18" y2="18" /></svg>
      </button>

      <!-- Welcome state -->
      <div v-if="!messages.length && !isProcessing" class="ai-welcome">
        <div class="ai-welcome__glow" />
        <div class="ai-welcome__icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
          </svg>
        </div>
        <h2 class="ai-welcome__title">AI Ассистент</h2>
        <p class="ai-welcome__desc">Управляйте сервером через естественный язык</p>
        <div class="ai-welcome__hints">
          <button
            v-for="hint in suggestions"
            :key="hint"
            class="ai-welcome__hint"
            @click="sendSuggestion(hint)"
          >{{ hint }}</button>
        </div>
      </div>

      <!-- Messages -->
      <div v-else class="ai-messages" ref="messagesEl">
        <template v-for="msg in messages" :key="msg.id">
          <!-- User message -->
          <div v-if="msg.role === 'user'" class="ai-msg ai-msg--user">
            <div class="ai-msg__bubble">{{ msg.text }}</div>
          </div>

          <!-- Assistant message -->
          <div v-else class="ai-msg ai-msg--assistant">
            <!-- Thinking -->
            <div v-if="msg.thinking" class="ai-block ai-block--thinking">
              <button class="ai-block__head" @click="msg.thinkingOpen = !msg.thinkingOpen">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></svg>
                <span>Размышление</span>
                <svg class="ai-block__chevron" :class="{ 'ai-block__chevron--open': msg.thinkingOpen }" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9,18 15,12 9,6" /></svg>
              </button>
              <div v-show="msg.thinkingOpen" class="ai-block__body ai-block__body--thinking">{{ msg.thinking }}</div>
            </div>

            <!-- Ordered content blocks (text and tools interleaved) -->
            <template v-for="(block, bIdx) in msg.blocks" :key="bIdx">
              <!-- Text block -->
              <div v-if="block.type === 'text' && block.text" class="ai-msg__text" v-html="renderMd(block.text)" />

              <!-- Tool block -->
              <template v-else-if="block.type === 'tool'">
                <!-- AskUserQuestion — interactive question UI -->
                <div v-if="block.tc.toolName === 'AskUserQuestion'" class="ai-question-block" :class="{ 'ai-question-block--answered': !isQuestionActive(msg) }">
                  <template v-for="(q, qIdx) in parseQuestions(block.tc.input)" :key="q.question">
                    <p class="ai-question__text">
                      <span v-if="q.header" class="ai-question__header">{{ q.header }}</span>
                      {{ q.question }}
                    </p>
                    <div class="ai-question__options">
                      <button
                        v-for="opt in q.options"
                        :key="opt.label"
                        class="ai-question__opt"
                        :class="{
                          'ai-question__opt--selected': isOptSelected(block.tc.toolId, qIdx, opt.label),
                          'ai-question__opt--disabled': !isQuestionActive(msg),
                        }"
                        :disabled="!isQuestionActive(msg)"
                        @click="toggleOpt(block.tc.toolId, qIdx, opt.label, q.multiSelect)"
                      >
                        <span class="ai-question__opt-check">
                          <svg v-if="isOptSelected(block.tc.toolId, qIdx, opt.label)" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><polyline points="20,6 9,17 4,12" /></svg>
                        </span>
                        <span class="ai-question__opt-body">
                          <span class="ai-question__opt-label">{{ opt.label }}</span>
                          <span v-if="opt.description" class="ai-question__opt-desc">{{ opt.description }}</span>
                        </span>
                      </button>
                    </div>
                  </template>
                  <!-- Submit button -->
                  <button
                    v-if="isQuestionActive(msg)"
                    class="ai-question__submit"
                    :disabled="!hasAllAnswers(block.tc.toolId, parseQuestions(block.tc.input).length)"
                    @click="submitAnswers(block.tc.toolId, parseQuestions(block.tc.input))"
                  >
                    Отправить ответ{{ parseQuestions(block.tc.input).length > 1 ? 'ы' : '' }}
                  </button>
                </div>

                <!-- Regular tool call -->
                <div v-else class="ai-block ai-block--tool">
                  <button class="ai-block__head" @click="block.tc.open = !block.tc.open">
                    <span class="ai-tool-badge" :data-cat="getToolCategory(block.tc.toolName)">{{ block.tc.toolName }}</span>
                    <span v-if="!block.tc.done" class="ai-spinner-sm" />
                    <span v-else-if="block.tc.isError" class="ai-tool-status ai-tool-status--err">ошибка</span>
                    <span v-else class="ai-tool-status ai-tool-status--ok">OK</span>
                    <svg class="ai-block__chevron" :class="{ 'ai-block__chevron--open': block.tc.open }" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9,18 15,12 9,6" /></svg>
                  </button>
                  <div v-show="block.tc.open" class="ai-block__body">
                    <div v-if="block.tc.input" class="ai-tool-section">
                      <span class="ai-tool-label">Параметры</span>
                      <pre class="ai-tool-pre">{{ fmtToolInput(block.tc.input) }}</pre>
                    </div>
                    <div v-if="block.tc.output" class="ai-tool-section">
                      <span class="ai-tool-label">{{ block.tc.isError ? 'Ошибка' : 'Результат' }}</span>
                      <pre class="ai-tool-pre" :class="{ 'ai-tool-pre--err': block.tc.isError }">{{ block.tc.outputExpanded || block.tc.output.length <= 1500 ? block.tc.output : block.tc.output.slice(0, 1500) + '\n...' }}</pre>
                      <button v-if="block.tc.output.length > 1500" class="ai-tool-expand" @click="block.tc.outputExpanded = !block.tc.outputExpanded">
                        {{ block.tc.outputExpanded ? 'Свернуть' : `Показать всё (${Math.ceil(block.tc.output.length / 1000)}K)` }}
                      </button>
                    </div>
                  </div>
                </div>
              </template>
            </template>
          </div>
        </template>

        <!-- Processing indicator -->
        <div v-if="isProcessing" class="ai-dots">
          <span /><span /><span />
        </div>
      </div>

      <!-- Input bar -->
      <div class="ai-input">
        <textarea
          ref="inputEl"
          v-model="inputText"
          class="ai-input__field"
          placeholder="Введите сообщение..."
          rows="1"
          @keydown.enter.exact.prevent="sendMessage"
          @input="autoGrow"
        />
        <button
          v-if="isProcessing"
          class="ai-input__btn ai-input__btn--stop"
          @click="stopProcessing"
          title="Остановить"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
        </button>
        <button
          v-else
          class="ai-input__btn ai-input__btn--send"
          :disabled="!inputText.trim()"
          @click="sendMessage"
          title="Отправить"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22,2 15,22 11,13 2,9" /></svg>
        </button>
      </div>
    </div>

    <!-- Mobile overlay -->
    <Transition name="fade">
      <div v-if="showSidebar" class="ai-overlay" @click="showSidebar = false" />
    </Transition>
  </div>
</template>

<script setup lang="ts">
const api = useApi();
const { aiStart, aiMessage, aiStop, onAiEvent } = useSocket();

let _uid = 0;
function uid(): string {
  return `msg-${Date.now()}-${++_uid}`;
}

interface SessionItem {
  id: string;
  title: string | null;
  cwd: string;
  createdAt: string;
  updatedAt: string;
}

interface ToolCallItem {
  toolId: string;
  toolName: string;
  input: string;
  output: string;
  isError: boolean;
  done: boolean;
  open: boolean;
  outputExpanded: boolean;
}

type MsgBlock =
  | { type: 'text'; text: string }
  | { type: 'tool'; tc: ToolCallItem };

interface ChatMsg {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  thinking: string;
  thinkingOpen: boolean;
  toolCalls: ToolCallItem[];
  blocks: MsgBlock[];
  timestamp: Date;
}

// State
const sessions = ref<SessionItem[]>([]);
const sessionsLoading = ref(false);
const activeSessionId = ref<string | null>(null);
const messages = ref<ChatMsg[]>([]);
const inputText = ref('');
const isProcessing = ref(false);
const showSidebar = ref(false);

// Message cache per session (survives session switching within page lifetime)
const msgCache = new Map<string, ChatMsg[]>();

// Refs
const messagesEl = ref<HTMLDivElement | null>(null);
const inputEl = ref<HTMLTextAreaElement | null>(null);

const suggestions = [
  'Проверить состояние сервера',
  'Показать логи nginx за сегодня',
  'Обновить системные пакеты',
  'Настроить SSL для домена',
];

// --- Sessions ---

async function loadSessions() {
  sessionsLoading.value = true;
  try {
    sessions.value = await api.get<SessionItem[]>('/ai/sessions');
  } catch { /* ignore */ }
  sessionsLoading.value = false;
}

/** Convert stored messages from DB to ChatMsg[] for display */
function storedToChat(stored: Array<{ role: string; text: string; thinking?: string; toolCalls?: Array<{ toolId: string; toolName: string; input: string; output: string; isError: boolean }> }>): ChatMsg[] {
  return stored.map((m, i) => {
    const tcs = (m.toolCalls || []).map(tc => ({
      ...tc,
      done: true,
      open: false,
      outputExpanded: false,
    }));
    // For stored messages we don't have interleave info — tools first, then text
    const blocks: MsgBlock[] = [
      ...tcs.map(tc => ({ type: 'tool' as const, tc })),
      ...(m.text ? [{ type: 'text' as const, text: m.text }] : []),
    ];
    return {
      id: `stored-${i}`,
      role: m.role as 'user' | 'assistant',
      text: m.text || '',
      thinking: m.thinking || '',
      thinkingOpen: false,
      toolCalls: tcs,
      blocks,
      timestamp: new Date(),
    };
  });
}

async function selectSession(s: SessionItem) {
  activeSessionId.value = s.id;
  showSidebar.value = false;

  // Check memory cache first
  if (msgCache.has(s.id)) {
    messages.value = msgCache.get(s.id)!;
    nextTick(() => scrollToBottom(true));
    return;
  }

  // Load from API
  try {
    const data = await api.get<{ id: string; messages: unknown[] }>(`/ai/sessions/${s.id}`);
    if (data?.messages && Array.isArray(data.messages) && data.messages.length) {
      messages.value = storedToChat(data.messages as never[]);
      msgCache.set(s.id, [...messages.value]);
    } else {
      messages.value = [];
    }
  } catch {
    messages.value = [];
  }
  nextTick(() => scrollToBottom(true));
}

async function deleteSession(id: string) {
  // Деструктивная операция: история чата теряется безвозвратно. Спрашиваем
  // явное подтверждение — иначе любой случайный клик на × в боковой панели
  // удаляет чат без отмены.
  const ok = await useMbConfirm().ask({
    title: 'Удалить чат',
    message: 'Удалить этот чат? Историю не вернуть.',
    confirmText: 'Удалить',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.del(`/ai/sessions/${id}`);
    sessions.value = sessions.value.filter(s => s.id !== id);
    msgCache.delete(id);
    if (activeSessionId.value === id) {
      activeSessionId.value = null;
      messages.value = [];
    }
  } catch { /* ignore */ }
}

function newChat() {
  activeSessionId.value = null;
  messages.value = [];
  showSidebar.value = false;
  nextTick(() => inputEl.value?.focus());
}

// --- Messaging ---

function sendMessage() {
  const text = inputText.value.trim();
  if (!text || isProcessing.value) return;

  messages.value.push({
    id: uid(),
    role: 'user',
    text,
    thinking: '',
    thinkingOpen: false,
    toolCalls: [],
    blocks: [],
    timestamp: new Date(),
  });

  inputText.value = '';
  resetHeight();
  isProcessing.value = true;
  scrollToBottom(true);

  if (activeSessionId.value) {
    aiMessage(activeSessionId.value, text);
  } else {
    aiStart(text);
  }
}

function sendSuggestion(text: string) {
  inputText.value = text;
  sendMessage();
}

function stopProcessing() {
  aiStop();
  isProcessing.value = false;
}

// --- Event handlers ---

function getAssistantMsg(): ChatMsg {
  const last = messages.value[messages.value.length - 1];
  if (last?.role === 'assistant') return last;
  const msg: ChatMsg = {
    id: uid(),
    role: 'assistant',
    text: '',
    thinking: '',
    thinkingOpen: false,
    toolCalls: [],
    blocks: [],
    timestamp: new Date(),
  };
  messages.value.push(msg);
  return msg;
}

function onSystem(_p: Record<string, unknown>) {
  // init event — nothing to do
}

function onText(p: Record<string, unknown>) {
  const msg = getAssistantMsg();
  const t = p.text as string;
  msg.text += t;
  // Append to last text block or create new one
  const lastBlock = msg.blocks[msg.blocks.length - 1];
  if (lastBlock?.type === 'text') {
    lastBlock.text += t;
  } else {
    msg.blocks.push({ type: 'text', text: t });
  }
  scrollToBottom();
}

function onThinking(p: Record<string, unknown>) {
  getAssistantMsg().thinking += p.text as string;
  scrollToBottom();
}

function onToolStart(p: Record<string, unknown>) {
  const msg = getAssistantMsg();
  const tc: ToolCallItem = {
    toolId: p.toolId as string,
    toolName: p.toolName as string,
    input: '',
    output: '',
    isError: false,
    done: false,
    open: true,
    outputExpanded: false,
  };
  msg.toolCalls.push(tc);
  msg.blocks.push({ type: 'tool', tc }); // same reference — updates propagate
  scrollToBottom();
}

function onToolInput(p: Record<string, unknown>) {
  const tc = getAssistantMsg().toolCalls.find(t => t.toolId === p.toolId);
  if (tc) tc.input += p.json as string;
}

function onToolDone(p: Record<string, unknown>) {
  const tc = getAssistantMsg().toolCalls.find(t => t.toolId === p.toolId);
  if (tc) {
    try { tc.input = JSON.stringify(p.input, null, 2); } catch { /* keep raw */ }
  }
}

function onToolResult(p: Record<string, unknown>) {
  const tc = getAssistantMsg().toolCalls.find(t => t.toolId === p.toolId);
  if (tc) {
    tc.output = p.output as string;
    tc.isError = p.isError as boolean;
    tc.done = true;
    tc.open = false;
  }
  scrollToBottom();
}

function onResult(p: Record<string, unknown>) {
  isProcessing.value = false;
  const sessionId = p.sessionId as string;

  if (sessionId && !activeSessionId.value) {
    activeSessionId.value = sessionId;
    // Auto-title from first user message
    const first = messages.value.find(m => m.role === 'user');
    if (first?.text) {
      api.patch(`/ai/sessions/${sessionId}`, { title: first.text.slice(0, 60) }).catch(() => {});
    }
  }

  // Cache messages for this session
  if (activeSessionId.value) {
    msgCache.set(activeSessionId.value, [...messages.value]);
  }

  loadSessions();
  scrollToBottom();
}

function onError(p: Record<string, unknown>) {
  isProcessing.value = false;
  const msg = getAssistantMsg();
  msg.text += `\n\n**Ошибка:** ${p.message as string}`;
  scrollToBottom();
}

// --- Helpers ---

/**
 * Санитарно разрешённая схема URL в markdown-ссылках.
 * Блокируем `javascript:`, `data:`, `vbscript:` — всё, что умеет исполнять код.
 */
function sanitizeMdUrl(url: string): string {
  const trimmed = url.trim();
  // Экранируем двойные кавычки в любом случае — чтобы нельзя было вырваться из href="…".
  const escapeAttr = (s: string) => s.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Относительные ссылки и якоря — безопасны.
  if (/^(\/|#|\.\/|\.\.\/|\?)/.test(trimmed)) return escapeAttr(trimmed);
  // Явно допускаем только http(s) и mailto.
  if (/^(https?:|mailto:)/i.test(trimmed)) return escapeAttr(trimmed);
  // Всё прочее (javascript:, data:, file:, vbscript:) заменяем на безопасный хэш.
  return '#';
}

function renderMd(text: string): string {
  if (!text) return '';

  let h = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  // Extract code blocks
  const preserved: string[] = [];
  h = h.replace(/```(\w*)\n([\s\S]*?)```/g, (_, _lang, code) => {
    const i = preserved.length;
    preserved.push(`<pre class="ai-pre"><code>${code.trimEnd()}</code></pre>`);
    return `\x00P${i}\x00`;
  });

  // Extract tables (before line breaks)
  h = h.replace(/(?:^|\n)((?:\|.+\|\n)+)/g, (match, tableBlock: string) => {
    const rows = tableBlock.trim().split('\n').filter((r: string) => r.trim());
    if (rows.length < 2) return match;

    // Check if second row is separator (|---|---|)
    const sep = rows[1];
    if (!/^\|[\s\-:|]+\|$/.test(sep.trim())) return match;

    const headerCells = rows[0].split('|').filter((c: string, idx: number, arr: string[]) => idx > 0 && idx < arr.length - 1);
    const thead = '<thead><tr>' + headerCells.map((c: string) => `<th>${c.trim()}</th>`).join('') + '</tr></thead>';

    const bodyRows = rows.slice(2);
    const tbody = '<tbody>' + bodyRows.map((row: string) => {
      const cells = row.split('|').filter((c: string, idx: number, arr: string[]) => idx > 0 && idx < arr.length - 1);
      return '<tr>' + cells.map((c: string) => `<td>${c.trim()}</td>`).join('') + '</tr>';
    }).join('') + '</tbody>';

    const i = preserved.length;
    preserved.push(`<table class="ai-table">${thead}${tbody}</table>`);
    return `\n\x00P${i}\x00\n`;
  });

  // Inline code
  h = h.replace(/`([^`\n]+)`/g, '<code class="ai-icode">$1</code>');
  // Bold
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic
  h = h.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // Links — санитизируем URL (блокируем javascript:/data:) и добавляем noreferrer
  h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) => {
    return `<a href="${sanitizeMdUrl(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  // Headers
  h = h.replace(/^### (.+)$/gm, '<h4>$1</h4>');
  h = h.replace(/^## (.+)$/gm, '<h3>$1</h3>');
  h = h.replace(/^# (.+)$/gm, '<h2>$1</h2>');
  // Unordered lists
  h = h.replace(/^- (.+)$/gm, '<li>$1</li>');
  // Line breaks
  h = h.replace(/\n/g, '<br>');

  // Restore preserved blocks
  preserved.forEach((b, i) => { h = h.replace(`\x00P${i}\x00`, b); });

  return h;
}

function formatDate(d: string): string {
  const ms = Date.now() - new Date(d).getTime();
  if (ms < 60_000) return 'сейчас';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} мин`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} ч`;
  return new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function getToolCategory(name: string): string {
  if (['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'].includes(name)) return 'read';
  if (['Write', 'Edit', 'NotebookEdit'].includes(name)) return 'write';
  if (name === 'Bash') return 'exec';
  return 'other';
}

function fmtToolInput(input: string): string {
  try { return JSON.stringify(JSON.parse(input), null, 2); }
  catch { return input; }
}

interface ParsedQuestion {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

function parseQuestions(input: string): ParsedQuestion[] {
  try {
    const parsed = JSON.parse(input);
    return parsed.questions || [];
  } catch {
    return [];
  }
}

// Selections: toolId → { questionIdx → selectedLabels[] }
const selections = ref<Record<string, Record<number, string[]>>>({});

function toggleOpt(toolId: string, qIdx: number, label: string, multiSelect?: boolean) {
  if (!selections.value[toolId]) selections.value[toolId] = {};
  const sel = selections.value[toolId];
  if (!sel[qIdx]) sel[qIdx] = [];

  if (multiSelect) {
    const i = sel[qIdx].indexOf(label);
    if (i >= 0) sel[qIdx].splice(i, 1);
    else sel[qIdx].push(label);
  } else {
    sel[qIdx] = sel[qIdx][0] === label ? [] : [label];
  }
}

function isOptSelected(toolId: string, qIdx: number, label: string): boolean {
  return selections.value[toolId]?.[qIdx]?.includes(label) ?? false;
}

function hasAllAnswers(toolId: string, questionCount: number): boolean {
  const sel = selections.value[toolId];
  if (!sel) return false;
  for (let i = 0; i < questionCount; i++) {
    if (!sel[i]?.length) return false;
  }
  return true;
}

function submitAnswers(toolId: string, questions: ParsedQuestion[]) {
  const sel = selections.value[toolId];
  if (!sel) return;

  const parts: string[] = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const chosen = sel[i] || [];
    if (!chosen.length) continue;
    parts.push(`Ответ на вопрос «${q.question}»: ${chosen.join(', ')}`);
  }

  if (parts.length) {
    inputText.value = parts.join('\n');
    sendMessage();
  }
}

/** Question buttons are clickable only when this is the last msg and not processing */
function isQuestionActive(msg: ChatMsg): boolean {
  const last = messages.value[messages.value.length - 1];
  return last === msg && !isProcessing.value;
}

function scrollToBottom(force = false) {
  nextTick(() => {
    const el = messagesEl.value;
    if (!el) return;
    if (force || el.scrollHeight - el.scrollTop - el.clientHeight < 150) {
      el.scrollTop = el.scrollHeight;
    }
  });
}

function autoGrow(e: Event) {
  const el = e.target as HTMLTextAreaElement;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
}

function resetHeight() {
  nextTick(() => { if (inputEl.value) inputEl.value.style.height = 'auto'; });
}

// --- Lifecycle ---

const cleanups: Array<() => void> = [];

onMounted(() => {
  loadSessions();
  cleanups.push(onAiEvent('system', onSystem));
  cleanups.push(onAiEvent('text', onText));
  cleanups.push(onAiEvent('thinking', onThinking));
  cleanups.push(onAiEvent('tool_use_start', onToolStart));
  cleanups.push(onAiEvent('tool_use_input', onToolInput));
  cleanups.push(onAiEvent('tool_use_done', onToolDone));
  cleanups.push(onAiEvent('tool_result', onToolResult));
  cleanups.push(onAiEvent('result', onResult));
  cleanups.push(onAiEvent('error', onError));
});

onUnmounted(() => {
  cleanups.forEach(fn => fn());
});
</script>

<style scoped>
/* ---- Layout ---- */
.ai-page {
  margin: -2rem -2.5rem;
  height: 100vh;
  display: flex;
  position: relative;
  overflow: hidden;
}

/* ---- Sidebar ---- */
.ai-sidebar {
  width: 252px;
  min-width: 252px;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border);
  background: var(--bg-elevated);
}

.ai-sidebar__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1rem 0.75rem;
  border-bottom: 1px solid var(--border);
}

.ai-sidebar__label {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.ai-sidebar__new {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  border: 1px solid var(--border-secondary);
  background: var(--bg-surface);
  color: var(--text-tertiary);
  cursor: pointer;
  transition: all 0.15s;
}

.ai-sidebar__new:hover {
  color: var(--primary);
  border-color: var(--primary-border);
  background: var(--primary-bg);
}

.ai-sidebar__list {
  flex: 1;
  overflow-y: auto;
  padding: 0.5rem;
}

.ai-session {
  display: flex;
  flex-direction: column;
  width: 100%;
  padding: 0.6rem 0.75rem;
  border: none;
  border-radius: 8px;
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s;
  position: relative;
  font-family: inherit;
}

.ai-session:hover {
  background: var(--bg-surface-hover);
}

.ai-session--active {
  background: var(--primary-bg);
}

.ai-session--active:hover {
  background: var(--primary-bg-hover);
}

.ai-session__title {
  font-size: 0.82rem;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding-right: 1.2rem;
}

.ai-session__date {
  font-size: 0.68rem;
  color: var(--text-muted);
  margin-top: 0.15rem;
  font-family: 'JetBrains Mono', monospace;
}

.ai-session__del {
  position: absolute;
  right: 0.5rem;
  top: 50%;
  transform: translateY(-50%);
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  font-size: 1rem;
  color: var(--text-faint);
  cursor: pointer;
  opacity: 0;
  transition: all 0.15s;
}

.ai-session:hover .ai-session__del {
  opacity: 1;
}

.ai-session__del:hover {
  color: var(--danger);
  background: var(--danger-bg);
}

.ai-sidebar__empty {
  padding: 2rem 1rem;
  text-align: center;
  font-size: 0.78rem;
  color: var(--text-muted);
}

/* ---- Chat area ---- */
.ai-chat {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  position: relative;
}

.ai-chat__toggle {
  display: none;
  position: absolute;
  top: 0.75rem;
  left: 0.75rem;
  z-index: 5;
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  border-radius: 8px;
  color: var(--text-tertiary);
  padding: 0.4rem;
  cursor: pointer;
}

/* ---- Welcome ---- */
.ai-welcome {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 2rem;
  position: relative;
}

.ai-welcome__glow {
  position: absolute;
  width: 200px;
  height: 200px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(var(--primary-rgb), 0.06) 0%, transparent 70%);
  pointer-events: none;
}

.ai-welcome__icon {
  width: 56px;
  height: 56px;
  border-radius: 16px;
  background: var(--primary-bg);
  border: 1px solid var(--primary-border);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--primary);
  margin-bottom: 1rem;
}

.ai-welcome__title {
  font-size: 1.3rem;
  font-weight: 700;
  color: var(--text-heading);
  margin: 0 0 0.35rem;
}

.ai-welcome__desc {
  font-size: 0.85rem;
  color: var(--text-tertiary);
  margin: 0 0 1.5rem;
}

.ai-welcome__hints {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  justify-content: center;
  max-width: 480px;
}

.ai-welcome__hint {
  padding: 0.5rem 0.85rem;
  border-radius: 20px;
  border: 1px solid var(--border-secondary);
  background: var(--bg-surface);
  color: var(--text-secondary);
  font-size: 0.78rem;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.15s;
}

.ai-welcome__hint:hover {
  border-color: var(--primary-border);
  color: var(--primary-text);
  background: var(--primary-bg);
}

/* ---- Messages ---- */
.ai-messages {
  flex: 1;
  overflow-y: auto;
  padding: 1.5rem 2rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.ai-msg--user {
  display: flex;
  justify-content: flex-end;
}

.ai-msg__bubble {
  max-width: 70%;
  padding: 0.65rem 1rem;
  border-radius: 14px 14px 4px 14px;
  background: var(--primary-bg);
  border: 1px solid var(--primary-border);
  color: var(--text-primary);
  font-size: 0.85rem;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.ai-msg--assistant {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  max-width: 85%;
}

.ai-msg__text {
  font-size: 0.85rem;
  line-height: 1.65;
  color: var(--text-primary);
  word-break: break-word;
}

.ai-msg__text :deep(h2),
.ai-msg__text :deep(h3),
.ai-msg__text :deep(h4) {
  margin: 0.6rem 0 0.3rem;
  color: var(--text-heading);
  font-weight: 600;
}

.ai-msg__text :deep(h2) { font-size: 1.1rem; }
.ai-msg__text :deep(h3) { font-size: 1rem; }
.ai-msg__text :deep(h4) { font-size: 0.9rem; }

.ai-msg__text :deep(a) {
  color: var(--primary-text);
  text-decoration: none;
}

.ai-msg__text :deep(a:hover) {
  text-decoration: underline;
}

.ai-msg__text :deep(strong) {
  font-weight: 600;
  color: var(--text-heading);
}

/* ---- Collapsible blocks ---- */
.ai-block {
  border-radius: 8px;
  border: 1px solid var(--border);
  overflow: hidden;
}

.ai-block__head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.45rem 0.7rem;
  border: none;
  background: var(--bg-surface);
  color: var(--text-secondary);
  font-size: 0.75rem;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.15s;
}

.ai-block__head:hover {
  background: var(--bg-surface-hover);
}

.ai-block__chevron {
  margin-left: auto;
  color: var(--text-faint);
  transition: transform 0.2s;
  flex-shrink: 0;
}

.ai-block__chevron--open {
  transform: rotate(90deg);
}

.ai-block__body {
  padding: 0.6rem 0.7rem;
  border-top: 1px solid var(--border);
  font-size: 0.78rem;
  font-family: 'JetBrains Mono', monospace;
  line-height: 1.5;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 400px;
  overflow-y: auto;
}

.ai-block__body--thinking {
  color: var(--text-tertiary);
  font-family: inherit;
  font-style: italic;
}

/* ---- Tool badges ---- */
.ai-tool-badge {
  padding: 0.15rem 0.45rem;
  border-radius: 4px;
  font-size: 0.7rem;
  font-weight: 600;
  font-family: 'JetBrains Mono', monospace;
  letter-spacing: 0.02em;
}

.ai-tool-badge[data-cat="read"] {
  background: rgba(59, 130, 246, 0.12);
  color: #60a5fa;
}

.ai-tool-badge[data-cat="write"] {
  background: rgba(34, 197, 94, 0.12);
  color: #4ade80;
}

.ai-tool-badge[data-cat="exec"] {
  background: rgba(168, 85, 247, 0.12);
  color: #c084fc;
}

.ai-tool-badge[data-cat="other"] {
  background: var(--primary-bg);
  color: var(--primary-text);
}

.ai-tool-status {
  font-size: 0.68rem;
  font-weight: 500;
}

.ai-tool-status--ok {
  color: var(--success);
}

.ai-tool-status--err {
  color: var(--danger);
}

.ai-tool-section {
  margin-bottom: 0.5rem;
}

.ai-tool-section:last-child {
  margin-bottom: 0;
}

.ai-tool-label {
  display: block;
  font-size: 0.68rem;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 0.3rem;
  font-family: 'DM Sans', sans-serif;
}

.ai-tool-pre {
  margin: 0;
  padding: 0.5rem;
  border-radius: 6px;
  background: var(--bg-code);
  border: 1px solid var(--border);
  font-size: 0.72rem;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 300px;
  overflow-y: auto;
  color: var(--text-secondary);
}

.ai-tool-pre--err {
  border-color: var(--danger-border);
  color: var(--danger-light);
}

.ai-tool-expand {
  display: inline-block;
  margin-top: 0.3rem;
  padding: 0.2rem 0.5rem;
  border: none;
  border-radius: 4px;
  background: var(--bg-surface);
  color: var(--primary-text);
  font-size: 0.7rem;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.15s;
}

.ai-tool-expand:hover {
  background: var(--primary-bg);
}

/* ---- AskUserQuestion ---- */
.ai-question-block {
  border-radius: 10px;
  border: 1px solid var(--primary-border);
  background: var(--primary-bg);
  padding: 0.85rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.ai-question-block--answered {
  opacity: 0.55;
  pointer-events: none;
}

.ai-question__header {
  display: inline-block;
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  font-size: 0.68rem;
  font-weight: 600;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-right: 0.35rem;
  vertical-align: middle;
}

.ai-question__text {
  margin: 0;
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--text-heading);
  line-height: 1.45;
}

.ai-question__options {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.ai-question__opt {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.5rem 0.7rem;
  border-radius: 8px;
  border: 1px solid var(--border-secondary);
  background: var(--bg-surface);
  text-align: left;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
}

.ai-question__opt:hover:not(:disabled) {
  border-color: var(--primary);
  background: var(--bg-surface-hover);
}

.ai-question__opt--selected {
  border-color: var(--primary);
  background: var(--primary-bg);
  box-shadow: 0 0 0 1px var(--primary-border);
}

.ai-question__opt--selected:hover:not(:disabled) {
  background: var(--primary-bg-hover, var(--primary-bg));
}

.ai-question__opt--disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.ai-question__opt-check {
  width: 18px;
  height: 18px;
  min-width: 18px;
  border-radius: 5px;
  border: 2px solid var(--border-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-top: 1px;
  transition: all 0.15s;
}

.ai-question__opt--selected .ai-question__opt-check {
  border-color: var(--primary);
  background: var(--primary);
  color: #fff;
}

.ai-question__opt-body {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

.ai-question__opt-label {
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--text-primary);
}

.ai-question__opt-desc {
  font-size: 0.72rem;
  color: var(--text-tertiary);
  line-height: 1.35;
}

.ai-question__submit {
  align-self: flex-end;
  padding: 0.5rem 1.2rem;
  border-radius: 8px;
  border: none;
  background: var(--primary);
  color: var(--primary-text-on);
  font-size: 0.8rem;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.15s;
  margin-top: 0.2rem;
}

.ai-question__submit:hover:not(:disabled) {
  background: var(--primary-light);
  box-shadow: var(--shadow-button-hover);
}

.ai-question__submit:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

/* ---- Spinner ---- */
.ai-spinner-sm {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid var(--spinner-track);
  border-top-color: var(--primary);
  animation: aispin 0.6s linear infinite;
}

@keyframes aispin {
  to { transform: rotate(360deg); }
}

/* ---- Processing dots ---- */
.ai-dots {
  display: flex;
  gap: 4px;
  padding: 0.5rem 0;
}

.ai-dots span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--primary);
  opacity: 0.4;
  animation: aidot 1.2s ease-in-out infinite;
}

.ai-dots span:nth-child(2) { animation-delay: 0.15s; }
.ai-dots span:nth-child(3) { animation-delay: 0.3s; }

@keyframes aidot {
  0%, 80%, 100% { opacity: 0.4; transform: scale(1); }
  40% { opacity: 1; transform: scale(1.3); }
}

/* ---- Code (markdown) ---- */
.ai-msg__text :deep(.ai-pre) {
  margin: 0.5rem 0;
  padding: 0.7rem 0.85rem;
  border-radius: 8px;
  background: var(--bg-code);
  border: 1px solid var(--border);
  overflow-x: auto;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--text-secondary);
}

.ai-msg__text :deep(.ai-pre code) {
  font-family: inherit;
  background: none;
  padding: 0;
}

.ai-msg__text :deep(.ai-icode) {
  padding: 0.1rem 0.35rem;
  border-radius: 4px;
  background: var(--bg-code);
  border: 1px solid var(--border);
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.8em;
  color: var(--primary-text);
}

/* ---- Tables ---- */
.ai-msg__text :deep(.ai-table) {
  width: 100%;
  border-collapse: collapse;
  margin: 0.5rem 0;
  font-size: 0.8rem;
}

.ai-msg__text :deep(.ai-table th),
.ai-msg__text :deep(.ai-table td) {
  padding: 0.4rem 0.7rem;
  border: 1px solid var(--border-secondary);
  text-align: left;
}

.ai-msg__text :deep(.ai-table th) {
  background: var(--bg-surface);
  color: var(--text-heading);
  font-weight: 600;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.ai-msg__text :deep(.ai-table td) {
  color: var(--text-secondary);
}

.ai-msg__text :deep(.ai-table tbody tr:hover) {
  background: var(--bg-surface-hover);
}

.ai-msg__text :deep(li) {
  margin-left: 1.2rem;
  list-style: disc;
  color: var(--text-secondary);
}

/* ---- Input bar ---- */
.ai-input {
  display: flex;
  align-items: flex-end;
  gap: 0.5rem;
  padding: 0.75rem 2rem 1rem;
  border-top: 1px solid var(--border);
  background: var(--bg-elevated);
}

.ai-input__field {
  flex: 1;
  padding: 0.6rem 0.85rem;
  border-radius: 12px;
  border: 1px solid var(--border-secondary);
  background: var(--bg-input);
  color: var(--text-primary);
  font-size: 0.85rem;
  font-family: inherit;
  line-height: 1.5;
  resize: none;
  outline: none;
  transition: border-color 0.15s;
  max-height: 200px;
}

.ai-input__field::placeholder {
  color: var(--text-placeholder);
}

.ai-input__field:focus {
  border-color: var(--primary-border);
  box-shadow: var(--focus-ring);
}

.ai-input__btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: 10px;
  border: none;
  cursor: pointer;
  transition: all 0.15s;
  flex-shrink: 0;
}

.ai-input__btn--send {
  background: var(--primary);
  color: var(--primary-text-on);
  box-shadow: var(--shadow-button);
}

.ai-input__btn--send:hover:not(:disabled) {
  background: var(--primary-light);
  box-shadow: var(--shadow-button-hover);
}

.ai-input__btn--send:disabled {
  opacity: 0.3;
  cursor: not-allowed;
  box-shadow: none;
}

.ai-input__btn--stop {
  background: var(--danger-bg);
  color: var(--danger);
  border: 1px solid var(--danger-border);
}

.ai-input__btn--stop:hover {
  background: var(--danger);
  color: #fff;
}

/* ---- Overlay (mobile) ---- */
.ai-overlay {
  display: none;
  position: fixed;
  inset: 0;
  background: var(--bg-overlay);
  z-index: 20;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* ---- Mobile ---- */
@media (max-width: 768px) {
  .ai-page {
    margin: -1rem -0.85rem;
    height: calc(100vh - 52px);
  }

  .ai-sidebar {
    position: fixed;
    left: 0;
    top: 52px;
    bottom: 0;
    z-index: 25;
    transform: translateX(-100%);
    transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    width: 280px;
  }

  .ai-sidebar--open {
    transform: translateX(0);
  }

  .ai-chat__toggle {
    display: flex;
  }

  .ai-overlay {
    display: block;
  }

  .ai-messages {
    padding: 1rem;
    padding-top: 3rem;
  }

  .ai-input {
    padding: 0.6rem 1rem 0.75rem;
  }

  .ai-msg__bubble {
    max-width: 85%;
  }

  .ai-msg--assistant {
    max-width: 95%;
  }
}
</style>
