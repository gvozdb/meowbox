<template>
  <section class="ops-panel security-panel" aria-labelledby="security-title">
    <div class="ops-section-head">
      <div><span class="ops-section-kicker">Admin scope</span><h2 id="security-title">Безопасность</h2></div>
      <DashboardSectionState :source="security.source" />
    </div>
    <div v-if="security.source.availability === 'UNAVAILABLE'" class="ops-empty">{{ security.source.message || 'Данные безопасности недоступны' }}</div>
    <dl v-else class="security-list">
      <div><dt>Неудачные входы · 24 ч</dt><dd :class="{ danger: security.failedLoginsLast24Hours }">{{ security.failedLoginsLast24Hours }}</dd></div>
      <div><dt>Активные сессии</dt><dd>{{ security.activeSessionCount }}</dd></div>
      <div><dt>Последний успешный вход</dt><dd>{{ formatDashboardAge(security.lastSuccessfulLoginAt) }}</dd></div>
      <div v-if="security.lastSuccessfulLoginActor"><dt>Оператор</dt><dd>{{ security.lastSuccessfulLoginActor }}</dd></div>
      <div v-if="security.firewallSummary"><dt>Firewall</dt><dd>{{ security.firewallSummary }}</dd></div>
    </dl>
    <div class="security-footer"><NuxtLink to="/settings">Сессии</NuxtLink><NuxtLink to="/firewall">Firewall</NuxtLink></div>
  </section>
</template>

<script setup lang="ts">
import type { DashboardSecuritySection } from '@meowbox/shared';
import { formatDashboardAge } from '~/utils/dashboard-format';
defineProps<{ security: DashboardSecuritySection }>();
</script>

<style scoped>
.security-list { display: grid; gap: 0; margin: 0; }
.security-list div { display: flex; justify-content: space-between; gap: 0.8rem; padding: 0.7rem 1rem; border-bottom: 1px solid var(--border); }
.security-list dt { color: var(--text-muted); font-size: 0.67rem; }
.security-list dd { margin: 0; color: var(--text-secondary); font: 650 0.67rem 'JetBrains Mono', monospace; text-align: right; }
.security-list .danger { color: var(--dashboard-status-danger); }
.security-footer { display: flex; gap: 0.8rem; padding: 0.75rem 1rem; }
.security-footer a { color: var(--primary-text); font-size: 0.67rem; }
</style>
