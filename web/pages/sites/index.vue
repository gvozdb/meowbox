<template>
  <div class="sites-page">
    <!-- Header -->
    <div class="sites-page__header">
      <div>
        <h1 class="sites-page__title">Сайты</h1>
        <p class="sites-page__subtitle">{{ sites.length }} {{ sites.length === 1 ? 'сайт' : (sites.length >= 2 && sites.length <= 4 ? 'сайта' : 'сайтов') }}</p>
      </div>
      <NuxtLink to="/sites/create" class="sites-page__add-btn">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        <span>Создать сайт</span>
      </NuxtLink>
    </div>

    <!-- Filters -->
    <div class="sites-page__filters">
      <div class="sites-page__search">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          v-model="search"
          type="text"
          placeholder="Поиск сайтов..."
          class="sites-page__search-input"
        />
      </div>

      <div class="sites-page__filter-chips">
        <button
          v-for="f in statusFilters"
          :key="f.value"
          class="sites-page__chip"
          :class="{ 'sites-page__chip--active': statusFilter === f.value }"
          @click="statusFilter = statusFilter === f.value ? '' : f.value"
        >
          {{ f.label }}
        </button>
      </div>
    </div>

    <!-- Sites grid -->
    <div v-if="filteredSites.length" class="sites-page__grid">
      <NuxtLink
        v-for="site in filteredSites"
        :key="site.id"
        :to="`/sites/${site.id}`"
        class="site-card"
      >
        <div class="site-card__header">
          <SiteTypeIcon :type="site.type" />
          <SiteStatusBadge :status="site.status" />
        </div>
        <div class="site-card__body">
          <h3 class="site-card__name">{{ site.displayName || site.name }}</h3>
          <p class="site-card__domain">{{ site.domain }}</p>
        </div>
        <div class="site-card__footer">
          <span v-if="site.phpVersion" class="site-card__tag">PHP {{ site.phpVersion }}</span>
          <span v-if="site.appPort" class="site-card__tag">:{{ site.appPort }}</span>
          <span v-if="site._count?.databases" class="site-card__tag">{{ site._count.databases }} DB</span>
        </div>
      </NuxtLink>
    </div>

    <!-- Empty state -->
    <div v-else class="sites-page__empty">
      <CatMascot :size="80" mood="sleepy" />
      <p class="sites-page__empty-text">
        {{ search || statusFilter ? 'Нет сайтов по фильтру' : 'Сайтов пока нет. Котику скучно!' }}
      </p>
      <NuxtLink v-if="!search && !statusFilter" to="/sites/create" class="sites-page__add-btn sites-page__add-btn--small">
        Создать первый сайт
      </NuxtLink>
    </div>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ middleware: 'auth' });

interface SiteItem {
  id: string;
  name: string;
  domain: string;
  type: string;
  status: string;
  phpVersion: string | null;
  appPort: number | null;
  _count?: { databases: number; backups: number };
}

const api = useApi();
const sites = ref<SiteItem[]>([]);
const search = ref('');
const statusFilter = ref('');

const statusFilters = [
  { label: 'Работает', value: 'RUNNING' },
  { label: 'Остановлен', value: 'STOPPED' },
  { label: 'Ошибка', value: 'ERROR' },
  { label: 'Деплой', value: 'DEPLOYING' },
];

const filteredSites = computed(() => {
  let result = sites.value;
  if (search.value) {
    const q = search.value.toLowerCase();
    result = result.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.domain.toLowerCase().includes(q),
    );
  }
  if (statusFilter.value) {
    result = result.filter((s) => s.status === statusFilter.value);
  }
  return result;
});

onMounted(async () => {
  try {
    sites.value = await api.get<SiteItem[]>('/sites');
  } catch {
    // Will show empty state
  }
});
</script>

<style scoped>
.sites-page__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1.5rem;
}

.sites-page__title {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--text-heading);
  margin: 0;
}

.sites-page__subtitle {
  font-size: 0.8rem;
  color: var(--bg-elevated);
  margin-top: 0.15rem;
}

.sites-page__add-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.6rem 1.2rem;
  border-radius: 12px;
  font-size: 0.85rem;
  font-weight: 600;
  text-decoration: none;
  color: var(--primary-text-on);
  background: linear-gradient(135deg, #fbbf24, #d97706);
  box-shadow: 0 2px 8px rgba(245, 158, 11, 0.2);
  transition: all 0.2s;
}

.sites-page__add-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 16px rgba(245, 158, 11, 0.3);
}

.sites-page__add-btn--small {
  font-size: 0.82rem;
  padding: 0.5rem 1rem;
  margin-top: 1rem;
}

/* Filters */
.sites-page__filters {
  display: flex;
  align-items: center;
  gap: 1rem;
  margin-bottom: 1.5rem;
}

.sites-page__search {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  background: var(--bg-elevated);
  border: 1px solid var(--border-secondary);
  border-radius: 10px;
  padding: 0 0.75rem;
  color: var(--text-muted);
  flex: 1;
  max-width: 300px;
}

.sites-page__search-input {
  background: none;
  border: none;
  outline: none;
  color: var(--text-primary);
  font-size: 0.85rem;
  padding: 0.55rem 0;
  width: 100%;
  font-family: inherit;
}

.sites-page__search-input::placeholder {
  color: var(--text-placeholder);
}

.sites-page__filter-chips {
  display: flex;
  gap: 0.4rem;
}

.sites-page__chip {
  padding: 0.35rem 0.75rem;
  border-radius: 20px;
  font-size: 0.72rem;
  font-weight: 500;
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  color: var(--text-tertiary);
  cursor: pointer;
  transition: all 0.2s;
}

.sites-page__chip:hover {
  background: var(--border-secondary);
  color: var(--text-secondary);
}

.sites-page__chip--active {
  background: var(--primary-bg);
  border-color: var(--primary-border);
  color: var(--primary-text);
}

/* Grid */
.sites-page__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 1rem;
}

/* Site card */
.site-card {
  display: flex;
  flex-direction: column;
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  border-radius: 16px;
  padding: 1.25rem;
  text-decoration: none;
  color: inherit;
  transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
}

.site-card:hover {
  background: var(--bg-elevated);
  border-color: var(--primary-bg-hover);
  transform: translateY(-2px);
  box-shadow: var(--shadow-card);
}

.site-card__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.85rem;
}

.site-card__name {
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.site-card__domain {
  font-size: 0.8rem;
  color: var(--text-muted);
  margin-top: 0.2rem;
  font-family: 'JetBrains Mono', monospace;
}

.site-card__footer {
  display: flex;
  gap: 0.4rem;
  margin-top: 0.85rem;
  flex-wrap: wrap;
}

.site-card__tag {
  padding: 0.15rem 0.5rem;
  border-radius: 6px;
  font-size: 0.65rem;
  font-weight: 500;
  font-family: 'JetBrains Mono', monospace;
  background: var(--bg-surface);
  color: var(--text-muted);
}

/* Empty */
.sites-page__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 4rem 2rem;
  text-align: center;
}

.sites-page__empty-text {
  /* Раньше тут стоял --bg-elevated — это переменная фона, а не текста.
     На светлой теме фон белый → текст белый на белом, на тёмной фон тёмный →
     текст тёмный на тёмном. Используем --text-muted, она инвертируется правильно. */
  color: var(--text-muted);
  font-size: 0.9rem;
  margin-top: 1rem;
}

@media (max-width: 768px) {
  .sites-page__header {
    flex-direction: column;
    align-items: stretch;
    gap: 0.75rem;
  }

  .sites-page__add-btn {
    align-self: flex-start;
  }

  .sites-page__filters {
    flex-direction: column;
    align-items: stretch;
  }

  .sites-page__search {
    max-width: none;
  }

  .sites-page__filter-chips {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }

  .sites-page__grid {
    grid-template-columns: 1fr;
  }

  .sites-page__title {
    font-size: 1.25rem;
  }
}
</style>
