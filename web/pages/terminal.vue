<template>
  <div class="term-page" :class="{ 'term-page--active': state === 'connected' }">
    <!-- Header bar -->
    <div class="term-bar">
      <div class="term-bar__left">
        <div class="term-bar__dots">
          <span class="term-dot term-dot--red" />
          <span class="term-dot term-dot--yellow" />
          <span class="term-dot term-dot--green" :class="{ 'term-dot--pulse': state === 'connected' }" />
        </div>
        <div class="term-bar__title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="4,17 10,11 4,5" /><line x1="12" y1="19" x2="20" y2="19" /></svg>
          <span>Terminal</span>
          <span v-if="state === 'connected'" class="term-bar__session">{{ sessionId?.slice(0, 8) }}</span>
        </div>
      </div>

      <div class="term-bar__right">
        <span class="term-bar__status" :class="`term-bar__status--${state}`">
          <span class="term-bar__status-dot" />
          {{ statusLabel }}
        </span>

        <button
          v-if="state === 'connected'"
          class="term-bar__btn term-bar__btn--disconnect"
          title="Disconnect"
          @click="closeTerminal"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
        </button>

        <button
          v-if="state === 'disconnected' || state === 'error'"
          class="term-bar__btn term-bar__btn--connect"
          @click="openTerminal"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="4,17 10,11 4,5" /><line x1="12" y1="19" x2="20" y2="19" /></svg>
          Connect
        </button>
      </div>
    </div>

    <!-- Terminal container -->
    <div class="term-viewport">
      <!-- xterm mounts here -->
      <div ref="terminalRef" class="term-canvas" />

      <!-- Overlay states -->
      <Transition name="term-overlay">
        <div v-if="state === 'connecting'" class="term-overlay">
          <div class="term-overlay__spinner" />
          <span class="term-overlay__text">Opening session...</span>
        </div>
      </Transition>

      <Transition name="term-overlay">
        <div v-if="state === 'disconnected'" class="term-overlay term-overlay--idle">
          <div class="term-overlay__icon">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="4,17 10,11 4,5" /><line x1="12" y1="19" x2="20" y2="19" /></svg>
          </div>
          <span class="term-overlay__heading">Web Terminal</span>
          <span class="term-overlay__sub">Secure shell access to your server</span>
          <button class="term-overlay__connect" @click="openTerminal">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polygon points="5,3 19,12 5,21" /></svg>
            Start Session
          </button>
        </div>
      </Transition>

      <Transition name="term-overlay">
        <div v-if="state === 'error'" class="term-overlay term-overlay--error">
          <div class="term-overlay__icon term-overlay__icon--error">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></svg>
          </div>
          <span class="term-overlay__heading">Connection Failed</span>
          <span class="term-overlay__sub">{{ errorMsg }}</span>
          <button class="term-overlay__connect" @click="openTerminal">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="23,4 23,10 17,10" /><path d="M20.49,15a9,9,0,1,1-2.12-9.36L23,10" /></svg>
            Retry
          </button>
        </div>
      </Transition>
    </div>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ middleware: 'auth' });

type TermState = 'disconnected' | 'connecting' | 'connected' | 'error';

const terminalRef = ref<HTMLElement | null>(null);
const state = ref<TermState>('disconnected');
const sessionId = ref<string | null>(null);
const errorMsg = ref('');

const { connected, terminalOpen, terminalInput, terminalResize, terminalClose, onTerminalData } = useSocket();

let term: any = null;
let fitAddon: any = null;
let dataUnsub: (() => void) | null = null;
let resizeObserver: ResizeObserver | null = null;

const statusLabel = computed(() => {
  switch (state.value) {
    case 'connected': return 'Connected';
    case 'connecting': return 'Connecting...';
    case 'error': return 'Error';
    default: return 'Disconnected';
  }
});

async function openTerminal() {
  if (state.value === 'connecting') return;
  state.value = 'connecting';
  errorMsg.value = '';

  try {
    // Dynamically import xterm (client-side only)
    const [{ Terminal }, { FitAddon }] = await Promise.all([
      import('xterm'),
      import('xterm-addon-fit'),
    ]);

    // Dispose previous instance if any
    disposeTerm();

    // Detect theme
    const isLight = document.documentElement.classList.contains('theme-light');

    fitAddon = new FitAddon();
    term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', monospace",
      fontSize: 14,
      lineHeight: 1.35,
      letterSpacing: 0,
      scrollback: 5000,
      allowProposedApi: true,
      theme: isLight ? {
        background: '#f0f1f4',
        foreground: '#1a1a2e',
        cursor: 'var(--primary-text)',
        cursorAccent: '#f0f1f4',
        selectionBackground: 'rgba(var(--primary-rgb), 0.18)',
        selectionForeground: '#1a1a2e',
        black: '#3c3c54',
        red: '#dc2626',
        green: '#16a34a',
        yellow: 'var(--primary-text)',
        blue: '#2563eb',
        magenta: '#9333ea',
        cyan: '#0891b2',
        white: '#64748b',
        brightBlack: '#94a3b8',
        brightRed: '#ef4444',
        brightGreen: '#22c55e',
        brightYellow: 'var(--primary)',
        brightBlue: '#3b82f6',
        brightMagenta: '#a855f7',
        brightCyan: '#06b6d4',
        brightWhite: '#1e293b',
      } : {
        background: '#08080d',
        foreground: '#d4d4e0',
        cursor: 'var(--primary)',
        cursorAccent: '#08080d',
        selectionBackground: 'rgba(var(--primary-rgb), 0.2)',
        selectionForeground: '#ffffff',
        black: '#1a1a2e',
        red: '#f87171',
        green: '#4ade80',
        yellow: 'var(--primary-light)',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#22d3ee',
        white: '#a1a1b5',
        brightBlack: '#5a5a72',
        brightRed: '#fca5a5',
        brightGreen: '#86efac',
        brightYellow: '#fde68a',
        brightBlue: '#93c5fd',
        brightMagenta: '#d8b4fe',
        brightCyan: '#67e8f9',
        brightWhite: '#ededf5',
      },
    });

    term.loadAddon(fitAddon);

    if (terminalRef.value) {
      term.open(terminalRef.value);

      // Small delay to ensure DOM is ready, then fit
      await nextTick();
      setTimeout(() => fitAddon?.fit(), 50);
    }

    // Open PTY session via WebSocket
    if (!connected.value) {
      throw new Error('WebSocket not connected. Check your connection.');
    }

    const result = await terminalOpen();
    sessionId.value = result.sessionId;
    state.value = 'connected';

    // Send initial size
    if (term && fitAddon) {
      terminalResize(result.sessionId, term.cols, term.rows);
    }

    // Pipe user input to server
    term.onData((data: string) => {
      if (sessionId.value) {
        terminalInput(sessionId.value, data);
      }
    });

    // Receive PTY output from server
    dataUnsub = onTerminalData((payload) => {
      if (payload.sessionId === sessionId.value && term) {
        term.write(payload.data);
      }
    });

    // Handle resize
    resizeObserver = new ResizeObserver(() => {
      if (fitAddon && term && state.value === 'connected') {
        fitAddon.fit();
        if (sessionId.value) {
          terminalResize(sessionId.value, term.cols, term.rows);
        }
      }
    });
    if (terminalRef.value) {
      resizeObserver.observe(terminalRef.value);
    }

    // Focus the terminal
    term.focus();
  } catch (err: any) {
    state.value = 'error';
    errorMsg.value = err.message || 'Failed to open terminal session';
  }
}

function closeTerminal() {
  if (sessionId.value) {
    terminalClose(sessionId.value);
  }
  disposeTerm();
  state.value = 'disconnected';
  sessionId.value = null;
}

function disposeTerm() {
  if (dataUnsub) {
    dataUnsub();
    dataUnsub = null;
  }
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
  if (term) {
    term.dispose();
    term = null;
  }
  fitAddon = null;
}

onUnmounted(() => {
  if (sessionId.value) {
    terminalClose(sessionId.value);
  }
  disposeTerm();
});
</script>

<style>
/* xterm.js base CSS - must be unscoped to affect the library DOM */
@import 'xterm/css/xterm.css';

.term-canvas .xterm {
  padding: 0.75rem;
  height: 100%;
}

.term-canvas .xterm-viewport {
  border-radius: 0;
}

.term-canvas .xterm-screen {
  height: 100% !important;
}
</style>

<style scoped>
.term-page {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 4rem);
  min-height: 300px;
  margin: -2rem -2.5rem;
  padding: 1.5rem 2rem;
}

/* ---- Top bar ---- */
.term-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 0.25rem 0.75rem;
  flex-shrink: 0;
}

.term-bar__left {
  display: flex;
  align-items: center;
  gap: 0.85rem;
}

.term-bar__dots {
  display: flex;
  gap: 0.35rem;
}

.term-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  opacity: 0.7;
}
.term-dot--red { background: #f87171; }
.term-dot--yellow { background: var(--primary-light); }
.term-dot--green { background: #4ade80; }
.term-dot--pulse {
  opacity: 1;
  animation: dot-pulse 2s ease-in-out infinite;
}

.term-bar__title {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--text-secondary);
}

.term-bar__session {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.65rem;
  font-weight: 400;
  color: var(--text-faint);
  padding: 0.1rem 0.4rem;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 4px;
}

.term-bar__right {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.term-bar__status {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.7rem;
  font-weight: 500;
  color: var(--text-muted);
}

.term-bar__status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-faint);
}

.term-bar__status--connected .term-bar__status-dot { background: var(--success); }
.term-bar__status--connected { color: var(--success); }
.term-bar__status--connecting .term-bar__status-dot { background: var(--primary); animation: dot-pulse 1s ease-in-out infinite; }
.term-bar__status--connecting { color: var(--primary-text); }
.term-bar__status--error .term-bar__status-dot { background: var(--danger); }
.term-bar__status--error { color: var(--danger); }

.term-bar__btn {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.3rem 0.6rem;
  border-radius: 6px;
  font-size: 0.72rem;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.15s;
  border: 1px solid var(--border-strong);
  background: var(--bg-surface);
  color: var(--text-secondary);
}
.term-bar__btn:hover {
  border-color: var(--border-secondary);
  background: var(--bg-surface-hover);
}

.term-bar__btn--connect {
  background: var(--primary-bg);
  border-color: var(--primary-border);
  color: var(--primary-text);
}
.term-bar__btn--connect:hover {
  background: var(--primary-bg-hover);
}

.term-bar__btn--disconnect {
  padding: 0.3rem;
}
.term-bar__btn--disconnect:hover {
  border-color: var(--danger-border);
  color: var(--danger);
  background: var(--danger-bg);
}

/* ---- Terminal viewport ---- */
.term-viewport {
  flex: 1;
  position: relative;
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid var(--border-secondary);
  background: #08080d;
  min-height: 0;
}

:root.theme-light .term-viewport {
  background: #f0f1f4;
}

.term-canvas {
  width: 100%;
  height: 100%;
  position: absolute;
  inset: 0;
}

/* ---- Overlays ---- */
.term-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  background: rgba(8, 8, 13, 0.95);
  z-index: 10;
}

:root.theme-light .term-overlay {
  background: rgba(240, 241, 244, 0.95);
}

.term-overlay__spinner {
  width: 28px;
  height: 28px;
  border: 2px solid var(--spinner-track);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.term-overlay__text {
  font-size: 0.78rem;
  color: var(--text-muted);
  font-weight: 500;
}

.term-overlay__icon {
  width: 56px;
  height: 56px;
  border-radius: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--primary-bg);
  color: var(--primary-text);
  margin-bottom: 0.25rem;
}

.term-overlay__icon--error {
  background: var(--danger-bg);
  color: var(--danger);
}

.term-overlay__heading {
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-heading);
}

.term-overlay__sub {
  font-size: 0.78rem;
  color: var(--text-muted);
  max-width: 320px;
  text-align: center;
  line-height: 1.45;
}

.term-overlay__connect {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.5rem;
  padding: 0.55rem 1.25rem;
  border-radius: 8px;
  border: none;
  background: var(--primary);
  color: var(--primary-text-on);
  font-size: 0.8rem;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.15s;
  box-shadow: var(--shadow-button);
}

.term-overlay__connect:hover {
  box-shadow: var(--shadow-button-hover);
  transform: translateY(-1px);
}

/* ---- Transitions ---- */
.term-overlay-enter-active,
.term-overlay-leave-active {
  transition: opacity 0.25s ease;
}
.term-overlay-enter-from,
.term-overlay-leave-to {
  opacity: 0;
}

/* ---- Animations ---- */
@keyframes spin {
  to { transform: rotate(360deg); }
}

@keyframes dot-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

/* ---- Mobile ---- */
@media (max-width: 768px) {
  .term-page {
    height: calc(100vh - 52px);
    margin: -1rem -0.85rem;
    padding: 0.75rem;
  }

  .term-bar {
    padding: 0 0 0.5rem;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .term-bar__dots { display: none; }

  .term-viewport {
    border-radius: 8px;
  }
}
</style>
