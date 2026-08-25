<template>
  <section class="problems ops-panel" :class="{ 'problems--compact': problems.total === 0 }" aria-labelledby="problems-title">
    <div class="ops-section-head problems-head">
      <div>
        <span class="ops-section-kicker">Требует реакции</span>
        <h2 id="problems-title">Problems Inbox</h2>
      </div>
      <div class="problem-counters" aria-label="Сводка проблем">
        <span class="counter counter--critical">{{ problems.critical }} крит.</span>
        <span class="counter counter--warning">{{ problems.warning }} вним.</span>
        <span v-if="problems.info" class="counter">{{ problems.info }} инфо</span>
      </div>
    </div>

    <div v-if="problems.total === 0" class="problems-clear" :class="{ 'problems-clear--unknown': overall.state !== 'HEALTHY' }">
      <span class="clear-mark" aria-hidden="true">{{ overall.state === 'HEALTHY' ? '✓' : '?' }}</span>
      <div>
        <strong>{{ overall.state === 'HEALTHY' ? 'Подтверждённых проблем нет' : 'Подтверждённых проблем нет, покрытие неполное' }}</strong>
        <p v-if="overall.state !== 'HEALTHY'">{{ overall.degradedSourceCount }} источн. недоступно, устарело или не поддерживается.</p>
        <p v-else>Все обязательные источники отвечают.</p>
      </div>
    </div>

    <div v-else>
      <ol class="problem-list">
        <li v-for="problem in visibleProblems" :key="problem.id"><DashboardProblemRow :problem="problem" /></li>
      </ol>
      <div v-if="remainingProblems.length || problems.truncated" class="problems-more">
        <button v-if="remainingProblems.length" ref="openButton" class="ops-button" type="button" @click="openDialog">
          Показать ещё {{ remainingProblems.length }}
        </button>
        <span v-if="problems.truncated">Ответ ограничен сервером</span>
      </div>
    </div>

    <dialog
      ref="dialog"
      class="problems-dialog"
      aria-labelledby="all-problems-title"
      @close="restoreFocus"
      @click="closeFromBackdrop"
      @keydown="trapDialogFocus"
    >
      <div class="dialog-shell">
        <header>
          <div>
            <span class="ops-section-kicker">Оставшиеся события</span>
            <h2 id="all-problems-title">Все проблемы</h2>
          </div>
          <button class="ops-button" type="button" autofocus @click="closeDialog">Закрыть</button>
        </header>
        <ol class="problem-list dialog-list">
          <li v-for="problem in remainingProblems" :key="problem.id"><DashboardProblemRow :problem="problem" /></li>
        </ol>
      </div>
    </dialog>
  </section>
</template>

<script setup lang="ts">
import type { DashboardOverallState, DashboardProblemCollection } from '@meowbox/shared';

const props = defineProps<{
  problems: DashboardProblemCollection;
  overall: DashboardOverallState;
}>();
const dialog = ref<HTMLDialogElement | null>(null);
const openButton = ref<HTMLButtonElement | null>(null);
const visibleProblems = computed(() => props.problems.items.slice(0, 6));
const remainingProblems = computed(() => props.problems.items.slice(6));

function openDialog() { dialog.value?.showModal(); }
function closeDialog() { dialog.value?.close(); }
function restoreFocus() { openButton.value?.focus(); }
function closeFromBackdrop(event: MouseEvent) {
  if (event.target === dialog.value) closeDialog();
}

function trapDialogFocus(event: KeyboardEvent) {
  if (event.key !== 'Tab' || !dialog.value) return;
  const focusable = Array.from(
    dialog.value.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => element.getClientRects().length > 0);
  if (focusable.length === 0) {
    event.preventDefault();
    dialog.value.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!first || !last) return;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !dialog.value.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}
</script>

<style scoped>
.problems { overflow: hidden; border-color: var(--border-strong); }
.problems-head { border-bottom-color: var(--border-secondary); }
.problem-counters { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 0.35rem; }
.counter { padding: 0.25rem 0.45rem; border: 1px solid var(--border-secondary); border-radius: 5px; color: var(--text-tertiary); font: 650 0.61rem 'JetBrains Mono', monospace; }
.counter--critical { border-color: var(--danger-border); background: var(--danger-bg); color: var(--dashboard-status-danger); }
.counter--warning { border-color: var(--primary-border); background: var(--primary-bg); color: var(--dashboard-status-warning); }
.problem-list { margin: 0; padding: 0; list-style: none; }
.problems-more { display: flex; align-items: center; gap: 0.8rem; padding: 0.75rem 1rem; border-top: 1px solid var(--border); }
.problems-more span { color: var(--text-muted); font-size: 0.65rem; }
.problems-clear { display: flex; align-items: center; gap: 0.8rem; padding: 0.8rem 1.1rem; color: var(--dashboard-status-success); }
.problems-clear--unknown { color: var(--dashboard-status-warning); }
.clear-mark { display: grid; width: 28px; height: 28px; place-items: center; border: 1px solid currentColor; border-radius: 50%; font: 700 0.8rem 'JetBrains Mono', monospace; }
.problems-clear strong { color: var(--text-secondary); font-size: 0.78rem; }
.problems-clear p { margin: 0.12rem 0 0; color: var(--text-muted); font-size: 0.68rem; }

.problems-dialog { width: min(900px, calc(100vw - 2rem)); max-height: min(760px, calc(100vh - 2rem)); padding: 0; overflow: hidden; border: 1px solid var(--border-strong); border-radius: 12px; background: var(--bg-modal); color: var(--text-primary); box-shadow: var(--shadow-modal); }
.problems-dialog::backdrop { background: var(--bg-overlay); backdrop-filter: blur(4px); }
.dialog-shell { max-height: inherit; overflow: auto; }
.dialog-shell > header { position: sticky; z-index: 2; top: 0; display: flex; align-items: center; justify-content: space-between; padding: 1rem; border-bottom: 1px solid var(--border-secondary); background: var(--bg-modal); }
.dialog-shell h2 { margin: 0; font-size: 1rem; }

@media (max-width: 620px) {
  .ops-section-head { align-items: center; }
  .problem-counters .counter:not(.counter--critical):not(.counter--warning) { display: none; }
  .problems-dialog { width: calc(100vw - 1rem); max-height: calc(100vh - 1rem); }
}
</style>
