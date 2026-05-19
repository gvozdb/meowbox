<template>
  <section class="quick-access">
    <div class="quick-access__header">
      <h3 class="quick-access__title">
        <svg
          class="quick-access__title-icon" width="16" height="16" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" stroke-width="2"
        >
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </svg>
        Быстрый доступ
      </h3>
      <button class="qa-icon-btn" title="Настроить команды" @click="openConfig">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        Настроить
      </button>
    </div>

    <div v-if="loading" class="quick-access__loading">
      <div class="qa-spinner" /> Загрузка команд…
    </div>

    <div v-else-if="!commands.length" class="quick-access__empty">
      <span>Быстрые команды не настроены.</span>
      <span class="quick-access__empty-hint">
        Нажмите «Настроить», чтобы выбрать команды из Makefile или package.json.
      </span>
    </div>

    <div v-else class="quick-access__grid">
      <button
        v-for="cmd in commands"
        :key="cmd.id"
        class="qa-cmd"
        :disabled="!!runningId"
        @click="runCommand(cmd)"
      >
        <span class="qa-cmd__icon" :class="`qa-cmd__icon--${cmd.source}`">
          <span v-if="runningId === cmd.id" class="qa-spinner qa-spinner--sm" />
          <svg
            v-else width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2"
          >
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
        </span>
        <span class="qa-cmd__text">
          <span class="qa-cmd__label">{{ cmd.label }}</span>
          <span class="qa-cmd__sub">{{ cmd.source }}: {{ cmd.target }}</span>
        </span>
      </button>
    </div>

    <!-- Run result modal -->
    <Teleport to="body">
      <div v-if="resultModal.open" class="qa-modal" @mousedown.self="closeResult">
        <div class="qa-modal__panel" @mousedown.stop>
          <div class="qa-modal__head">
            <strong>{{ resultModal.title }}</strong>
            <div class="qa-modal__head-meta">
              <span
                v-if="resultModal.done"
                class="qa-exit"
                :class="resultModal.exitCode === 0 ? 'qa-exit--ok' : 'qa-exit--err'"
              >
                exit {{ resultModal.exitCode }}
              </span>
              <span v-if="resultModal.done" class="qa-modal__duration">
                {{ formatDuration(resultModal.durationMs) }}
              </span>
              <button class="btn btn--ghost btn--sm" :disabled="!resultModal.done" @click="closeResult">
                Закрыть
              </button>
            </div>
          </div>
          <div v-if="!resultModal.done" class="qa-modal__running">
            <div class="qa-spinner" />
            <span>Команда выполняется… это может занять несколько минут.</span>
          </div>
          <pre v-else class="qa-modal__body mono">{{ resultModal.output || '(нет вывода)' }}</pre>
        </div>
      </div>
    </Teleport>

    <!-- Configure modal -->
    <Teleport to="body">
      <div v-if="configModal.open" class="qa-modal" @mousedown.self="closeConfig">
        <div class="qa-modal__panel qa-modal__panel--config" @mousedown.stop>
          <div class="qa-modal__head">
            <strong>Настройка быстрых команд</strong>
            <button class="btn btn--ghost btn--sm" @click="closeConfig">Закрыть</button>
          </div>

          <div class="qa-config">
            <div v-if="configModal.loading" class="quick-access__loading">
              <div class="qa-spinner" /> Поиск команд в репозитории…
            </div>

            <div v-else-if="!configModal.groups.length" class="quick-access__empty">
              <span>В репозитории сайта не найдено Makefile или package.json со скриптами.</span>
            </div>

            <template v-else>
              <p class="qa-config__hint">
                Отметьте команды, которые хотите вынести в блок «Быстрый доступ».
              </p>
              <div
                v-for="(group, gi) in configModal.groups"
                :key="`${group.file}-${gi}`"
                class="qa-group"
              >
                <div class="qa-group__head">
                  <span class="qa-cmd__icon qa-cmd__icon--sm" :class="`qa-cmd__icon--${group.source}`">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                  </span>
                  <code class="qa-group__file">{{ group.file }}</code>
                </div>
                <div class="qa-group__cmds">
                  <label
                    v-for="cmd in group.commands"
                    :key="`${group.source}-${cmd.target}`"
                    class="qa-check"
                    :class="{ 'qa-check--active': isSelected(group, cmd) }"
                  >
                    <input
                      type="checkbox"
                      class="qa-check__input"
                      :checked="isSelected(group, cmd)"
                      @change="toggleSelect(group, cmd, ($event.target as HTMLInputElement).checked)"
                    />
                    <span class="qa-check__body">
                      <span class="qa-check__target">{{ cmd.target }}</span>
                      <span v-if="cmd.preview" class="qa-check__preview">{{ cmd.preview }}</span>
                    </span>
                  </label>
                </div>
              </div>
            </template>
          </div>

          <div class="qa-modal__footer">
            <button class="btn btn--ghost btn--sm" @click="closeConfig">Отмена</button>
            <button
              class="btn btn--primary btn--sm"
              :disabled="configModal.loading || configModal.saving"
              @click="saveConfig"
            >
              {{ configModal.saving ? 'Сохраняю…' : 'Сохранить' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </section>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue';
import type {
  QuickCommand,
  QuickCommandRunResult,
  DiscoveredCommandGroup,
  DiscoveredCommand,
  NodeCommandSource,
} from '@meowbox/shared';

const props = defineProps<{ siteId: string }>();

const api = useApi();
const toast = useMbToast();

const commands = ref<QuickCommand[]>([]);
const loading = ref(true);
const runningId = ref<string | null>(null);

/** Ключ выбранной команды: source|target|cwd (cwd = директория файла группы). */
const selected = reactive<Set<string>>(new Set());

const resultModal = reactive({
  open: false,
  done: false,
  title: '',
  output: '',
  exitCode: 0,
  durationMs: 0,
});

const configModal = reactive({
  open: false,
  loading: false,
  saving: false,
  groups: [] as DiscoveredCommandGroup[],
});

onMounted(loadCommands);

async function loadCommands() {
  loading.value = true;
  try {
    commands.value = await api.get<QuickCommand[]>(`/sites/${props.siteId}/node/quick-commands`);
  } catch (e: unknown) {
    toast.error((e as Error).message || 'Не удалось загрузить быстрые команды');
    commands.value = [];
  } finally {
    loading.value = false;
  }
}

/** Директория файла-источника группы. */
function groupDir(group: DiscoveredCommandGroup): string {
  const idx = group.file.lastIndexOf('/');
  return idx > 0 ? group.file.slice(0, idx) : group.file;
}

function selKey(source: NodeCommandSource, target: string, cwd: string): string {
  return `${source}|${target}|${cwd}`;
}

function isSelected(group: DiscoveredCommandGroup, cmd: DiscoveredCommand): boolean {
  return selected.has(selKey(cmd.source, cmd.target, groupDir(group)));
}

function toggleSelect(group: DiscoveredCommandGroup, cmd: DiscoveredCommand, checked: boolean) {
  const key = selKey(cmd.source, cmd.target, groupDir(group));
  if (checked) selected.add(key);
  else selected.delete(key);
}

async function runCommand(cmd: QuickCommand) {
  if (runningId.value) return;
  runningId.value = cmd.id;
  resultModal.open = true;
  resultModal.done = false;
  resultModal.title = `Запуск · ${cmd.label}`;
  resultModal.output = '';
  resultModal.exitCode = 0;
  resultModal.durationMs = 0;
  try {
    const res = await api.post<QuickCommandRunResult>(
      `/sites/${props.siteId}/node/quick-commands/${cmd.id}/run`,
    );
    resultModal.output = res.output;
    resultModal.exitCode = res.exitCode;
    resultModal.durationMs = res.durationMs;
    resultModal.done = true;
    if (res.exitCode === 0) toast.success(`«${cmd.label}» выполнена`);
    else toast.error(`«${cmd.label}» завершилась с кодом ${res.exitCode}`);
  } catch (e: unknown) {
    resultModal.output = `Ошибка: ${(e as Error).message}`;
    resultModal.exitCode = -1;
    resultModal.done = true;
    toast.error((e as Error).message || 'Не удалось выполнить команду');
  } finally {
    runningId.value = null;
  }
}

function closeResult() {
  if (!resultModal.done) return;
  resultModal.open = false;
  resultModal.output = '';
}

async function openConfig() {
  configModal.open = true;
  configModal.loading = true;
  configModal.groups = [];
  selected.clear();
  try {
    const groups = await api.get<DiscoveredCommandGroup[]>(
      `/sites/${props.siteId}/node/commands/discover`,
    );
    configModal.groups = groups;
    // Предотмечаем уже сохранённые команды (матч по source+target+cwd).
    for (const cmd of commands.value) {
      selected.add(selKey(cmd.source, cmd.target, cmd.cwd));
    }
  } catch (e: unknown) {
    toast.error((e as Error).message || 'Не удалось найти команды');
    configModal.groups = [];
  } finally {
    configModal.loading = false;
  }
}

function closeConfig() {
  if (configModal.saving) return;
  configModal.open = false;
  configModal.groups = [];
  selected.clear();
}

async function saveConfig() {
  const payload: Array<{
    label: string;
    source: NodeCommandSource;
    target: string;
    cwd: string;
    sortOrder: number;
  }> = [];
  let order = 0;
  for (const group of configModal.groups) {
    const dir = groupDir(group);
    for (const cmd of group.commands) {
      if (!selected.has(selKey(cmd.source, cmd.target, dir))) continue;
      payload.push({
        label: cmd.target,
        source: cmd.source,
        target: cmd.target,
        cwd: dir,
        sortOrder: order++,
      });
    }
  }
  configModal.saving = true;
  try {
    commands.value = await api.put<QuickCommand[]>(
      `/sites/${props.siteId}/node/quick-commands`,
      { commands: payload },
    );
    toast.success('Быстрые команды сохранены');
    configModal.open = false;
    configModal.groups = [];
    selected.clear();
  } catch (e: unknown) {
    toast.error((e as Error).message || 'Не удалось сохранить команды');
  } finally {
    configModal.saving = false;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} мс`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)} с`;
  const min = Math.floor(sec / 60);
  return `${min} мин ${Math.round(sec % 60)} с`;
}
</script>

<style scoped>
.quick-access {
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  border-radius: 14px;
  padding: 1.15rem 1.25rem;
  margin-top: 1rem;
}

.quick-access__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  margin-bottom: 0.9rem;
}
.quick-access__title {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--text-tertiary);
  margin: 0;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.quick-access__title-icon { color: var(--primary-text, var(--primary-light)); }

.qa-icon-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  background: var(--bg-input);
  border: 1px solid var(--border-strong);
  color: var(--text-tertiary);
  font-size: 0.74rem;
  font-weight: 600;
  font-family: inherit;
  padding: 0.4rem 0.7rem;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s;
}
.qa-icon-btn:hover { color: var(--text-secondary); border-color: var(--border-strong); }

.quick-access__loading,
.quick-access__empty {
  padding: 1.25rem;
  text-align: center;
  color: var(--text-tertiary);
  font-size: 0.82rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
}
.quick-access__loading { flex-direction: row; }
.quick-access__empty-hint { font-size: 0.74rem; color: var(--text-muted, var(--text-tertiary)); }

.quick-access__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 0.6rem;
}

.qa-cmd {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  text-align: left;
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  padding: 0.65rem 0.8rem;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.18s;
}
.qa-cmd:hover:not(:disabled) {
  border-color: rgba(var(--primary-rgb), 0.45);
  transform: translateY(-1px);
}
.qa-cmd:disabled { opacity: 0.5; cursor: not-allowed; }

.qa-cmd__icon {
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.qa-cmd__icon--sm { width: 22px; height: 22px; border-radius: 6px; }
.qa-cmd__icon--npm { background: rgba(203, 56, 55, 0.14); color: rgb(229, 115, 115); }
.qa-cmd__icon--make { background: rgba(var(--primary-rgb), 0.13); color: var(--primary-light); }

.qa-cmd__text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.qa-cmd__label {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.qa-cmd__sub {
  font-size: 0.7rem;
  color: var(--text-tertiary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ─── Модалки ─── */
.qa-modal {
  position: fixed;
  inset: 0;
  background: var(--bg-overlay);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
  padding: 1rem;
  animation: qaFade 0.18s ease;
}
.qa-modal__panel {
  background: var(--bg-modal-gradient, var(--bg-modal));
  border: 1px solid var(--border-secondary, var(--border-subtle));
  border-radius: 14px;
  width: min(820px, 100%);
  height: min(78vh, 660px);
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow-modal, 0 20px 50px rgba(0, 0, 0, 0.35));
  color: var(--text-primary);
  animation: qaIn 0.22s ease;
}
.qa-modal__panel--config { width: min(640px, 100%); }
.qa-modal__head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  padding: 0.95rem 1.1rem;
  border-bottom: 1px solid var(--border-subtle);
}
.qa-modal__head-meta { display: flex; align-items: center; gap: 0.6rem; }
.qa-modal__duration { font-size: 0.74rem; color: var(--text-tertiary); }
.qa-modal__body {
  flex: 1;
  overflow: auto;
  padding: 1rem 1.1rem;
  margin: 0;
  font-size: 0.78rem;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-secondary);
  background: var(--bg-code);
}
.qa-modal__running {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  color: var(--text-tertiary);
  font-size: 0.82rem;
}
.qa-modal__footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  padding: 0.8rem 1.1rem;
  border-top: 1px solid var(--border-subtle);
}

.qa-exit {
  font-size: 0.72rem;
  font-weight: 700;
  padding: 0.2rem 0.5rem;
  border-radius: 6px;
}
.qa-exit--ok { background: rgba(16, 185, 129, 0.14); color: rgb(52, 211, 153); }
.qa-exit--err { background: rgba(239, 68, 68, 0.14); color: rgb(248, 113, 113); }

/* ─── Конфиг-модалка ─── */
.qa-config {
  flex: 1;
  overflow: auto;
  padding: 1rem 1.1rem;
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}
.qa-config__hint { font-size: 0.78rem; color: var(--text-tertiary); margin: 0; }

.qa-group {
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  overflow: hidden;
}
.qa-group__head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.6rem 0.8rem;
  background: var(--bg-elevated);
  border-bottom: 1px solid var(--border-subtle);
}
.qa-group__file {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.74rem;
  color: var(--text-secondary);
  word-break: break-all;
}
.qa-group__cmds { display: flex; flex-direction: column; }

.qa-check {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  padding: 0.55rem 0.8rem;
  cursor: pointer;
  transition: background 0.15s;
}
.qa-check + .qa-check { border-top: 1px solid var(--border-subtle); }
.qa-check:hover { background: var(--bg-elevated); }
.qa-check--active { background: rgba(var(--primary-rgb), 0.06); }
.qa-check__input { margin-top: 2px; accent-color: var(--primary, var(--primary-light)); }
.qa-check__body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.qa-check__target {
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--text-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.qa-check__preview {
  font-size: 0.72rem;
  color: var(--text-tertiary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  word-break: break-all;
}

.qa-spinner {
  width: 22px; height: 22px;
  border: 2px solid var(--spinner-track, var(--border-subtle));
  border-top-color: var(--primary, var(--primary-light));
  border-radius: 50%;
  animation: qaSpin 0.8s linear infinite;
}
.qa-spinner--sm { width: 14px; height: 14px; border-width: 2px; }
@keyframes qaSpin { to { transform: rotate(360deg); } }
@keyframes qaFade { from { opacity: 0; } to { opacity: 1; } }
@keyframes qaIn {
  from { opacity: 0; transform: scale(0.97) translateY(8px); }
  to { opacity: 1; transform: scale(1) translateY(0); }
}

.mono {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.78rem;
}

/* ─── Кнопки ─── */
.btn {
  display: inline-flex; align-items: center; justify-content: center;
  gap: 0.4rem; padding: 0.55rem 1rem;
  border-radius: 10px; border: none; font-size: 0.82rem; font-weight: 600;
  font-family: inherit; cursor: pointer; transition: all 0.2s; white-space: nowrap;
}
.btn--sm { padding: 0.4rem 0.8rem; font-size: 0.74rem; border-radius: 8px; }
.btn--primary { background: linear-gradient(135deg, var(--primary-light), var(--primary-dark)); color: var(--primary-text-on); }
.btn--primary:not(:disabled):hover { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(var(--primary-rgb), 0.2); }
.btn--primary:disabled { opacity: 0.4; cursor: not-allowed; }
.btn--ghost { background: var(--bg-input); border: 1px solid var(--border-strong); color: var(--text-tertiary); }
.btn--ghost:hover:not(:disabled) { color: var(--text-secondary); border-color: var(--border-strong); }
.btn--ghost:disabled { opacity: 0.4; cursor: not-allowed; }

code {
  background: var(--bg-code);
  border-radius: 4px;
  padding: 0.05rem 0.3rem;
}
</style>
