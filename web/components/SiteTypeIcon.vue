<template>
  <div class="site-type-icon" :class="`site-type-icon--${typeClass}`" :title="label">
    <span class="site-type-icon__text">{{ short }}</span>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  type: string;
}>();

const typeClass = computed(() => props.type.toLowerCase().replace(/_/g, '-'));

const short = computed(() => {
  const map: Record<string, string> = {
    MODX_REVO: 'MX',
    MODX_3: 'M3',
    CUSTOM: '—',
    // legacy (если в БД ещё есть старые записи):
    NUXT_3: 'Nx', REACT: 'Re', NESTJS: 'Ns', STATIC_HTML: 'St',
  };
  return map[props.type] || '??';
});

const label = computed(() => {
  const map: Record<string, string> = {
    MODX_REVO: 'MODX Revolution',
    MODX_3: 'MODX 3',
    CUSTOM: 'Пустой',
    // legacy:
    NUXT_3: 'Nuxt 3', REACT: 'React', NESTJS: 'NestJS', STATIC_HTML: 'Статика',
  };
  return map[props.type] || props.type;
});
</script>

<style scoped>
.site-type-icon {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  flex-shrink: 0;
}

.site-type-icon--modx-revo,
.site-type-icon--modx-3 { background: rgba(34, 197, 94, 0.1); color: #4ade80; }
.site-type-icon--nuxt-3 { background: rgba(0, 220, 130, 0.1); color: #00dc82; }
.site-type-icon--react { background: rgba(97, 218, 251, 0.1); color: #61dafb; }
.site-type-icon--nestjs { background: rgba(234, 44, 78, 0.1); color: #ea2c4e; }
.site-type-icon--static-html { background: rgba(245, 158, 11, 0.1); color: #fbbf24; }
.site-type-icon--custom { background: rgba(148, 163, 184, 0.1); color: #94a3b8; }
</style>
