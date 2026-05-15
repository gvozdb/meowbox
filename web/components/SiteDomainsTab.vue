<template>
  <div class="domains-section">
    <!-- Алерт: у сайта есть сертификат(ы), но часть доменов им не покрыта -->
    <div v-if="anyCoverageProblem" class="domains-cert-alert">
      <div class="domains-cert-alert__icon">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      </div>
      <div class="domains-cert-alert__body">
        <strong>Часть доменов не покрыта SSL-сертификатом</strong>
        <span>
          Открой вкладку «SSL» соответствующего домена и перевыпусти сертификат —
          в SAN должны быть и сам домен, и все его алиасы (в т. ч. redirect).
        </span>
      </div>
    </div>

    <div class="info-card">
      <div class="domains-header">
        <h3 class="info-card__title">Домены</h3>
        <span class="domains-hint">У каждого основного домена свои алиасы, SSL и nginx-конфиг. Корона — главный домен.</span>
      </div>

      <div v-if="domains.length" class="domains-list">
        <div
          v-for="d in domains"
          :key="d.id"
          class="domain-row"
          :class="{ 'domain-row--primary': d.isPrimary }"
        >
          <!-- Корона: главный домен (read-only иконка) / тогл для остальных -->
          <button
            class="domain-row__crown"
            :class="{ 'domain-row__crown--active': d.isPrimary }"
            :disabled="busy || d.isPrimary"
            :title="d.isPrimary ? 'Главный домен сайта' : 'Сделать главным доменом'"
            @click="onMakePrimary(d)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" :fill="d.isPrimary ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M2 7l5 5 5-8 5 8 5-5v11a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
            </svg>
          </button>

          <!-- SSL-coverage индикатор -->
          <span
            v-if="coverageState(d) !== 'no-cert'"
            class="cert-badge"
            :class="`cert-badge--${coverageState(d)}`"
            :title="coverageTitle(d)"
          >
            <svg v-if="coverageState(d) === 'covered'" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><polyline points="20 6 9 17 4 12" /></svg>
            <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </span>

          <!-- Домен (ссылка) + кнопка редактирования -->
          <a :href="domainUrl(d)" target="_blank" rel="noopener noreferrer" class="domain-row__name domain-link">{{ d.domain }}</a>
          <button class="domain-row__edit" :disabled="busy" title="Изменить домен" @click="openEditDomain(d)">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
          </button>

          <!-- Алиасы (comma-separated) -->
          <span class="domain-row__aliases">
            <template v-if="d.aliases?.length">
              <template v-for="(a, i) in d.aliases" :key="a.domain + i">
                <span class="domain-row__alias">{{ a.domain }}<span v-if="a.redirect" class="domain-row__alias-arrow"> →</span></span><span v-if="i < d.aliases.length - 1">, </span>
              </template>
            </template>
            <span v-else class="domain-row__aliases-empty">без алиасов</span>
          </span>

          <!-- Действия -->
          <div class="domain-row__actions">
            <button class="btn btn--ghost btn--xs" :disabled="busy" @click="openAliasesModal(d)">
              Алиасы
              <span v-if="d.aliases?.length" class="domain-row__count">{{ d.aliases.length }}</span>
            </button>
            <button class="btn btn--ghost btn--xs" :disabled="busy" @click="emit('navigate-ssl', d.id)">SSL</button>
            <button class="btn btn--ghost btn--xs" :disabled="busy" @click="emit('navigate-nginx', d.id)">Nginx</button>
            <button
              class="domain-row__remove"
              :disabled="busy || d.isPrimary || domains.length <= 1"
              :title="d.isPrimary ? 'Сначала назначь главным другой домен' : 'Удалить домен'"
              @click="onRemoveDomain(d)"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
          </div>
        </div>
      </div>
      <div v-else class="domains-empty">Основные домены не настроены</div>

      <div class="domains-add">
        <input
          v-model="newDomain"
          type="text"
          class="domains-add__input"
          placeholder="new.example.com"
          spellcheck="false"
          autocomplete="off"
          :disabled="busy"
          @keyup.enter="onAddDomain"
        />
        <button class="btn btn--primary domains-add__btn" :disabled="!newDomain.trim() || busy" @click="onAddDomain">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
          Добавить домен
        </button>
      </div>
      <span v-if="addError" class="domains-add__error">{{ addError }}</span>
    </div>

    <!-- Modal: edit a domain (тот же предупреждающий формат, что и старая смена главного домена) -->
    <Teleport to="body">
      <div v-if="editTarget" class="modal-overlay" @mousedown.self="closeEditDomain">
        <div class="domain-modal">
          <div class="domain-modal__header">
            <div class="domain-modal__title-group">
              <div class="domain-modal__icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                  <circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                </svg>
              </div>
              <div>
                <h3 class="domain-modal__title">Смена домена</h3>
                <p class="domain-modal__subtitle">Изменит <code>server_name</code> в nginx и сбросит SSL домена</p>
              </div>
            </div>
            <button class="domain-modal__close" :disabled="busy" @click="closeEditDomain">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
          </div>

          <div class="domain-modal__body">
            <div class="domain-modal__swap">
              <div class="domain-modal__swap-col">
                <label class="domain-modal__label">Сейчас</label>
                <div class="domain-modal__chip domain-modal__chip--current">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10" /></svg>
                  <code>{{ editTarget.domain }}</code>
                </div>
              </div>
              <div class="domain-modal__arrow">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></svg>
              </div>
              <div class="domain-modal__swap-col">
                <label class="domain-modal__label">Новый домен</label>
                <div class="domain-modal__input-wrap" :class="{ 'domain-modal__input-wrap--error': !!editDomainError }">
                  <svg class="domain-modal__input-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
                  <input
                    v-model="editDomainValue"
                    type="text"
                    class="domain-modal__input"
                    placeholder="new.example.com"
                    :disabled="busy"
                    autocomplete="off"
                    spellcheck="false"
                    @keyup.enter="saveEditDomain"
                  />
                </div>
                <span v-if="editDomainError" class="domain-modal__error">{{ editDomainError }}</span>
              </div>
            </div>

            <div class="domain-modal__impact">
              <div class="domain-modal__impact-title">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
                Что произойдёт
              </div>
              <ul class="domain-modal__impact-list">
                <li>
                  В nginx-конфиге обновится <code>server_name</code> на <code>{{ editDomainValue.trim() || 'new.example.com' }}</code>.
                  Конфиг будет проверен <code>nginx -t</code> и перезагружен.
                </li>
                <li v-if="editTarget.sslCertificate && editTarget.sslCertificate.status !== 'NONE'" class="domain-modal__impact-danger">
                  <b>SSL домена сбросится в статус «Нет»</b> — старый серт выпущен на <code>{{ editTarget.domain }}</code>,
                  для нового домена невалиден. После смены — выпусти новый серт на вкладке «SSL».
                </li>
                <li>
                  <b>DNS</b> нового домена должен уже указывать на этот сервер, иначе сайт станет недоступен
                  (и выпуск SSL потом обломается).
                </li>
                <li>
                  Ссылки в админке/БД сайта (<code>site_url</code>, MODX <code>system_settings</code>, хардкод в контенте)
                  панель <b>не трогает</b> — правь руками.
                </li>
              </ul>
            </div>
          </div>

          <div class="domain-modal__footer">
            <button class="btn btn--ghost" :disabled="busy" @click="closeEditDomain">Отмена</button>
            <button
              class="btn btn--danger"
              :disabled="busy || !editDomainValue.trim() || editDomainValue.trim().toLowerCase() === editTarget.domain"
              @click="saveEditDomain"
            >
              <svg v-if="!busy" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12" /></svg>
              {{ busy ? 'Применяю...' : 'Сменить домен' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Modal: per-domain aliases -->
    <Teleport to="body">
      <div v-if="aliasTarget" class="modal-overlay" @mousedown.self="closeAliasesModal">
        <div class="domain-modal">
          <div class="domain-modal__header">
            <div class="domain-modal__title-group">
              <div class="domain-modal__icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
              </div>
              <div>
                <h3 class="domain-modal__title">Алиасы домена</h3>
                <p class="domain-modal__subtitle">Дополнительные домены для <code>{{ aliasTarget.domain }}</code></p>
              </div>
            </div>
            <button class="domain-modal__close" :disabled="aliasSaving" @click="closeAliasesModal">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
          </div>

          <div class="domain-modal__body">
            <!-- SSL-not-covered предупреждение -->
            <div v-if="aliasModalMissing.length" class="domains-cert-alert ssl-le__mismatch">
              <div class="domains-cert-alert__icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              </div>
              <div class="domains-cert-alert__body">
                <strong>Не покрыто SSL-сертификатом</strong>
                <span>
                  <template v-for="(d, i) in aliasModalMissing" :key="d"><code>{{ d }}</code><span v-if="i < aliasModalMissing.length - 1">, </span></template>
                  — перевыпусти SSL домена, чтобы добавить в SAN (redirect-алиасы тоже должны быть в SAN).
                </span>
              </div>
            </div>

            <div v-if="aliasDraft.length" class="domains-list">
              <div v-for="(alias, idx) in aliasDraft" :key="alias.domain + idx" class="domain-item">
                <span
                  v-if="aliasCoverage(alias.domain) !== 'no-cert'"
                  class="cert-badge"
                  :class="`cert-badge--${aliasCoverage(alias.domain)}`"
                  :title="aliasCoverage(alias.domain) === 'covered' ? 'Алиас покрыт SSL-сертификатом' : 'Алиас не в сертификате — перевыпусти SSL'"
                >
                  <svg v-if="aliasCoverage(alias.domain) === 'covered'" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><polyline points="20 6 9 17 4 12" /></svg>
                  <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                </span>
                <a :href="aliasUrl(alias.domain)" target="_blank" rel="noopener noreferrer" class="domain-item__name domain-item__name--inline domain-link">{{ alias.domain }}</a>
                <div class="domain-item__redirect">
                  <label class="domain-item__toggle" :title="alias.redirect ? 'Редирект 301 на основной домен' : 'Алиас отдаёт сайт (200)'">
                    <input
                      type="checkbox"
                      :checked="alias.redirect"
                      :disabled="aliasSaving"
                      @change="toggleRedirect(idx)"
                    />
                    <span class="domain-item__toggle-slider" />
                    <span class="domain-item__toggle-label">{{ alias.redirect ? '301' : '200' }}</span>
                  </label>
                </div>
                <button class="domain-item__remove" title="Удалить алиас" :disabled="aliasSaving" @click="removeAliasDraft(idx)">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                </button>
              </div>
            </div>
            <div v-else class="domains-empty">Алиасы не настроены</div>

            <div class="domains-add">
              <input
                v-model="newAlias"
                type="text"
                class="domains-add__input"
                placeholder="alias.example.com"
                spellcheck="false"
                autocomplete="off"
                :disabled="aliasSaving"
                @keyup.enter="addAliasDraft"
              />
              <button class="btn btn--ghost domains-add__btn" :disabled="!newAlias.trim() || aliasSaving" @click="addAliasDraft">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                Добавить алиас
              </button>
            </div>
            <span v-if="aliasError" class="domains-add__error">{{ aliasError }}</span>
          </div>

          <div class="domain-modal__footer">
            <button class="btn btn--ghost" :disabled="aliasSaving" @click="closeAliasesModal">Отмена</button>
            <button class="btn btn--primary" :disabled="aliasSaving || !aliasesDirty" @click="saveAliases">
              <svg v-if="!aliasSaving" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12" /></svg>
              {{ aliasSaving ? 'Сохранение...' : 'Сохранить алиасы' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

interface SiteAlias {
  domain: string;
  redirect: boolean;
}

interface SslCert {
  status: string;
  domains?: string[];
  expiresAt?: string | null;
}

interface SiteDomain {
  id: string;
  siteId: string;
  domain: string;
  isPrimary: boolean;
  position: number;
  aliases: SiteAlias[];
  filesRelPath: string | null;
  appPort: number | null;
  httpsRedirect: boolean;
  sslCertificate: SslCert | null;
  createdAt: string;
  updatedAt: string;
}

const props = defineProps<{
  siteId: string;
  domains: SiteDomain[];
}>();

const emit = defineEmits<{
  (e: 'changed'): void;
  (e: 'navigate-ssl', domainId: string): void;
  (e: 'navigate-nginx', domainId: string): void;
}>();

const api = useApi();
const toast = useMbToast();
const confirm = useMbConfirm();

const busy = ref(false);
const newDomain = ref('');
const addError = ref('');

// --- coverage helpers ---
type Coverage = 'covered' | 'missing' | 'no-cert';
function hasActiveCert(d: SiteDomain): boolean {
  const s = d.sslCertificate?.status;
  return s === 'ACTIVE' || s === 'EXPIRING_SOON' || s === 'EXPIRED';
}
function certSet(d: SiteDomain): Set<string> {
  return new Set((d.sslCertificate?.domains || []).map((x) => x.toLowerCase()));
}
/** Покрытие домена + всех его алиасов одним взглядом — для индикатора в строке. */
function coverageState(d: SiteDomain): Coverage {
  if (!hasActiveCert(d)) return 'no-cert';
  const set = certSet(d);
  const all = [d.domain, ...d.aliases.map((a) => a.domain)];
  return all.every((x) => set.has(x.toLowerCase())) ? 'covered' : 'missing';
}
function coverageTitle(d: SiteDomain): string {
  return coverageState(d) === 'covered'
    ? 'Домен и все его алиасы покрыты SSL-сертификатом'
    : 'Домен или часть алиасов не в SAN сертификата — перевыпусти SSL';
}
function domainUrl(d: SiteDomain): string {
  const s = d.sslCertificate?.status;
  const valid = s === 'ACTIVE' || s === 'EXPIRING_SOON';
  const covered = certSet(d).has(d.domain.toLowerCase());
  return `${valid && covered ? 'https' : 'http'}://${d.domain}`;
}
const anyCoverageProblem = computed(() => props.domains.some((d) => coverageState(d) === 'missing'));

// --- domain CRUD ---
async function onAddDomain() {
  const domain = newDomain.value.trim().toLowerCase();
  addError.value = '';
  if (!domain) return;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    addError.value = 'Невалидный домен';
    return;
  }
  busy.value = true;
  try {
    await api.post(`/sites/${props.siteId}/domains`, { domain });
    newDomain.value = '';
    toast.success(`Домен ${domain} добавлен`);
    emit('changed');
  } catch (e) {
    addError.value = (e as Error).message || 'Не удалось добавить домен';
    toast.error(addError.value);
  } finally {
    busy.value = false;
  }
}

async function onRemoveDomain(d: SiteDomain) {
  if (d.isPrimary) return;
  const ok = await confirm.ask({
    title: 'Удаление домена',
    message: `Удалить домен ${d.domain}? Его nginx-конфиг, SSL-сертификат и алиасы будут удалены.`,
    confirmText: 'Удалить',
    danger: true,
  });
  if (!ok) return;
  busy.value = true;
  try {
    await api.delete(`/sites/${props.siteId}/domains/${d.id}`);
    toast.success(`Домен ${d.domain} удалён`);
    emit('changed');
  } catch (e) {
    toast.error((e as Error).message || 'Не удалось удалить домен');
  } finally {
    busy.value = false;
  }
}

async function onMakePrimary(d: SiteDomain) {
  if (d.isPrimary) return;
  const ok = await confirm.ask({
    title: 'Смена главного домена',
    message: `Сделать ${d.domain} главным доменом сайта? Главный домен используется в шапке, ссылках и как зеркало legacy-полей.`,
    confirmText: 'Сделать главным',
  });
  if (!ok) return;
  busy.value = true;
  try {
    await api.post(`/sites/${props.siteId}/domains/${d.id}/make-primary`, {});
    toast.success(`${d.domain} — теперь главный домен`);
    emit('changed');
  } catch (e) {
    toast.error((e as Error).message || 'Не удалось сменить главный домен');
  } finally {
    busy.value = false;
  }
}

// --- edit domain modal ---
const editTarget = ref<SiteDomain | null>(null);
const editDomainValue = ref('');
const editDomainError = ref('');

function openEditDomain(d: SiteDomain) {
  editTarget.value = d;
  editDomainValue.value = d.domain;
  editDomainError.value = '';
}
function closeEditDomain() {
  if (busy.value) return;
  editTarget.value = null;
}
async function saveEditDomain() {
  if (!editTarget.value) return;
  const next = editDomainValue.value.trim().toLowerCase();
  editDomainError.value = '';
  if (!next || next === editTarget.value.domain) return;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(next)) {
    editDomainError.value = 'Невалидный домен';
    return;
  }
  busy.value = true;
  try {
    await api.put(`/sites/${props.siteId}/domains/${editTarget.value.id}`, { domain: next });
    toast.success(`Домен изменён на ${next}`);
    editTarget.value = null;
    emit('changed');
  } catch (e) {
    editDomainError.value = (e as Error).message || 'Не удалось сменить домен';
  } finally {
    busy.value = false;
  }
}

// --- aliases modal ---
const aliasTarget = ref<SiteDomain | null>(null);
const aliasDraft = ref<SiteAlias[]>([]);
const newAlias = ref('');
const aliasError = ref('');
const aliasSaving = ref(false);

function openAliasesModal(d: SiteDomain) {
  aliasTarget.value = d;
  aliasDraft.value = d.aliases.map((a) => ({ domain: a.domain, redirect: a.redirect }));
  newAlias.value = '';
  aliasError.value = '';
}
function closeAliasesModal() {
  if (aliasSaving.value) return;
  aliasTarget.value = null;
}

const aliasesDirty = computed(() => {
  if (!aliasTarget.value) return false;
  return JSON.stringify(aliasDraft.value) !== JSON.stringify(aliasTarget.value.aliases);
});

function aliasCoverage(aliasDomain: string): Coverage {
  const d = aliasTarget.value;
  if (!d || !hasActiveCert(d)) return 'no-cert';
  return certSet(d).has(aliasDomain.toLowerCase()) ? 'covered' : 'missing';
}
function aliasUrl(aliasDomain: string): string {
  const d = aliasTarget.value;
  const s = d?.sslCertificate?.status;
  const valid = s === 'ACTIVE' || s === 'EXPIRING_SOON';
  const covered = d ? certSet(d).has(aliasDomain.toLowerCase()) : false;
  return `${valid && covered ? 'https' : 'http'}://${aliasDomain}`;
}
const aliasModalMissing = computed(() => {
  const d = aliasTarget.value;
  if (!d || !hasActiveCert(d)) return [] as string[];
  const set = certSet(d);
  return aliasDraft.value.filter((a) => !set.has(a.domain.toLowerCase())).map((a) => a.domain);
});

function addAliasDraft() {
  const alias = newAlias.value.trim().toLowerCase();
  aliasError.value = '';
  if (!alias) return;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(alias)) {
    aliasError.value = 'Невалидный домен';
    return;
  }
  if (aliasDraft.value.some((a) => a.domain === alias)) {
    aliasError.value = 'Такой алиас уже есть';
    return;
  }
  aliasDraft.value.push({ domain: alias, redirect: false });
  newAlias.value = '';
}
function removeAliasDraft(idx: number) {
  aliasDraft.value.splice(idx, 1);
}
/** Тогл редиректа алиаса: 200 (отдаёт сайт) ↔ 301 (редирект на основной домен). */
function toggleRedirect(idx: number) {
  const a = aliasDraft.value[idx];
  if (a) aliasDraft.value[idx] = { ...a, redirect: !a.redirect };
}

async function saveAliases() {
  if (!aliasTarget.value || !aliasesDirty.value) return;
  aliasSaving.value = true;
  aliasError.value = '';
  try {
    await api.put(`/sites/${props.siteId}/domains/${aliasTarget.value.id}/aliases`, {
      aliases: aliasDraft.value,
    });
    toast.success('Алиасы сохранены');
    aliasTarget.value = null;
    emit('changed');
  } catch (e) {
    aliasError.value = (e as Error).message || 'Не удалось сохранить алиасы';
    toast.error(aliasError.value);
  } finally {
    aliasSaving.value = false;
  }
}
</script>

<style scoped>
.domains-section { display: flex; flex-direction: column; gap: 1rem; }

.info-card {
  background: var(--bg-surface);
  border: 1px solid var(--border-secondary);
  border-radius: 14px;
  padding: 1.15rem;
}
.info-card__title {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--text-tertiary);
  margin: 0;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.domains-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
  margin-bottom: 0.85rem;
}
.domains-hint { font-size: 0.7rem; color: var(--text-muted); }

.domains-list { display: flex; flex-direction: column; gap: 0.4rem; }
.domains-empty { font-size: 0.82rem; color: var(--text-muted); padding: 0.75rem 0; }

/* Domain row */
.domain-row {
  display: grid;
  grid-template-columns: auto auto auto auto 1fr auto;
  align-items: center;
  gap: 0.55rem;
  padding: 0.6rem 0.8rem;
  background: var(--bg-elevated);
  border: 1px solid var(--border-secondary);
  border-radius: 9px;
}
.domain-row--primary {
  border-color: var(--primary-border, var(--border));
}

.domain-row__crown {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  border: 1px solid var(--border-secondary);
  background: transparent;
  color: var(--text-faint);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.15s;
  flex-shrink: 0;
}
.domain-row__crown:hover:not(:disabled) { color: var(--primary-text); border-color: var(--primary-text); }
.domain-row__crown--active {
  color: #fbbf24;
  border-color: rgba(251, 191, 36, 0.35);
  background: rgba(251, 191, 36, 0.1);
  cursor: default;
}
.domain-row__crown:disabled:not(.domain-row__crown--active) { opacity: 0.5; cursor: not-allowed; }

.domain-row__name {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.82rem;
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

.domain-row__edit {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  border: 1px solid var(--border-secondary);
  background: transparent;
  color: #a78bfa;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.15s;
  flex-shrink: 0;
}
.domain-row__edit:hover:not(:disabled) { background: var(--bg-surface-hover); border-color: #a78bfa; }
.domain-row__edit:disabled { opacity: 0.5; cursor: not-allowed; }

.domain-row__aliases {
  font-size: 0.74rem;
  color: var(--text-muted);
  font-family: 'JetBrains Mono', monospace;
  overflow-wrap: anywhere;
  min-width: 0;
}
.domain-row__alias-arrow { color: var(--text-faint); }
.domain-row__aliases-empty { font-style: italic; opacity: 0.7; font-family: inherit; }

.domain-row__actions {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  flex-shrink: 0;
}
.domain-row__count {
  font-size: 0.62rem;
  font-weight: 700;
  padding: 0.05rem 0.3rem;
  border-radius: 5px;
  background: var(--border);
  color: var(--text-muted);
}
.domain-row__remove {
  width: 26px; height: 26px; border-radius: 6px; border: none; background: transparent;
  color: var(--text-faint); display: flex; align-items: center; justify-content: center;
  cursor: pointer; transition: all 0.15s; flex-shrink: 0;
}
.domain-row__remove:hover:not(:disabled) { background: rgba(239, 68, 68, 0.1); color: #f87171; }
.domain-row__remove:disabled { opacity: 0.35; cursor: not-allowed; }

@media (max-width: 720px) {
  .domain-row {
    grid-template-columns: auto auto 1fr;
    grid-template-areas:
      'crown badge name'
      'aliases aliases aliases'
      'actions actions actions';
  }
  .domain-row__crown { grid-area: crown; }
  .domain-row__name { grid-area: name; }
  .domain-row__aliases { grid-area: aliases; }
  .domain-row__actions { grid-area: actions; justify-content: flex-start; }
}

/* add */
.domains-add {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.85rem;
  align-items: stretch;
}
.domains-add__input {
  flex: 1;
  min-width: 0;
  padding: 0.55rem 0.85rem;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.82rem;
  background: var(--bg-input, var(--bg-elevated));
  border: 1px solid var(--border-secondary);
  border-radius: 9px;
  color: var(--text-primary);
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
}
.domains-add__input::placeholder { color: var(--text-faint); }
.domains-add__input:hover { border-color: var(--border); }
.domains-add__input:focus {
  border-color: var(--primary-text);
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
  background: var(--bg-surface);
}
.domains-add__btn {
  flex-shrink: 0;
  padding: 0 1rem;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  white-space: nowrap;
}
.domains-add__error {
  display: block;
  font-size: 0.74rem;
  color: #f87171;
  margin-top: 0.4rem;
}

/* cert badge */
.cert-badge {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: help;
  transition: transform 0.15s;
}
.cert-badge:hover { transform: scale(1.15); }
.cert-badge--covered { background: rgba(34, 197, 94, 0.15); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.3); }
.cert-badge--missing { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); }
html.theme-light .cert-badge--covered { background: rgba(34, 197, 94, 0.15); color: #15803d; border-color: rgba(34, 197, 94, 0.35); }
html.theme-light .cert-badge--missing { background: rgba(239, 68, 68, 0.15); color: #b91c1c; border-color: rgba(239, 68, 68, 0.35); }

/* domain → SAN mismatch alert */
.domains-cert-alert {
  display: flex;
  gap: 0.75rem;
  padding: 0.8rem 1rem;
  background: linear-gradient(135deg, rgba(239, 68, 68, 0.08), rgba(251, 146, 60, 0.08));
  border: 1px solid rgba(239, 68, 68, 0.25);
  border-radius: 12px;
  align-items: flex-start;
}
.domains-cert-alert__icon {
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: rgba(239, 68, 68, 0.15);
  color: #f87171;
  display: flex;
  align-items: center;
  justify-content: center;
}
.domains-cert-alert__body {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.78rem;
  color: var(--text-secondary);
  line-height: 1.5;
}
.domains-cert-alert__body strong { color: #fca5a5; font-size: 0.82rem; font-weight: 600; }
.domains-cert-alert__body code {
  background: rgba(239, 68, 68, 0.12);
  color: #fca5a5;
  padding: 0.05em 0.35em;
  border-radius: 4px;
  font-size: 0.9em;
}
html.theme-light .domains-cert-alert {
  background: linear-gradient(135deg, rgba(239, 68, 68, 0.07), rgba(251, 146, 60, 0.07));
  border-color: rgba(239, 68, 68, 0.25);
}
html.theme-light .domains-cert-alert__icon { background: rgba(239, 68, 68, 0.12); color: #dc2626; }
html.theme-light .domains-cert-alert__body strong { color: #b91c1c; }
html.theme-light .domains-cert-alert__body code { background: rgba(239, 68, 68, 0.1); color: #b91c1c; }
.ssl-le__mismatch {
  margin: 0;
  padding: 0.7rem 0.85rem;
  gap: 0.6rem;
  font-size: 0.77rem;
}
.ssl-le__mismatch .domains-cert-alert__body { gap: 0.3rem; }

/* aliases modal items */
.domain-item {
  display: flex; align-items: center; gap: 0.6rem;
  padding: 0.5rem 0.75rem; background: var(--bg-elevated); border-radius: 8px;
}
.domain-item__name {
  font-family: 'JetBrains Mono', monospace; font-size: 0.82rem;
  color: var(--text-secondary); overflow-wrap: anywhere;
}
/* BUG FIX: ссылка не должна растягиваться на всю ширину колонки */
.domain-item__name--inline {
  flex: 1;
  min-width: 0;
  align-self: center;
}
.domain-item__name--inline.domain-link {
  width: max-content;
  max-width: 100%;
  display: inline-block;
}
.domain-item__redirect { display: flex; align-items: center; }
.domain-item__toggle {
  display: inline-flex; align-items: center; gap: 0.4rem; cursor: pointer;
  font-size: 0.72rem; color: var(--text-muted); user-select: none;
}
.domain-item__toggle input { position: absolute; opacity: 0; pointer-events: none; }
.domain-item__toggle-slider {
  position: relative; width: 30px; height: 16px; background: var(--bg-input);
  border: 1px solid var(--border-secondary); border-radius: 16px; transition: all 0.15s;
  flex-shrink: 0;
}
.domain-item__toggle-slider::before {
  content: ''; position: absolute; left: 2px; top: 50%; transform: translateY(-50%);
  width: 10px; height: 10px; border-radius: 50%; background: var(--text-muted); transition: all 0.15s;
}
.domain-item__toggle input:checked + .domain-item__toggle-slider {
  background: rgba(99, 102, 241, 0.25); border-color: var(--primary-text);
}
.domain-item__toggle input:checked + .domain-item__toggle-slider::before {
  left: 16px; background: var(--primary-text);
}
.domain-item__toggle input:disabled ~ * { opacity: 0.6; cursor: not-allowed; }
.domain-item__toggle-label { font-family: 'JetBrains Mono', monospace; font-size: 0.7rem; min-width: 28px; }
.domain-item__remove {
  width: 26px; height: 26px; border-radius: 6px; border: none; background: transparent;
  color: var(--text-faint); display: flex; align-items: center; justify-content: center;
  cursor: pointer; transition: all 0.15s; flex-shrink: 0;
}
.domain-item__remove:hover:not(:disabled) { background: rgba(239, 68, 68, 0.1); color: #f87171; }
.domain-item__remove:disabled { opacity: 0.5; cursor: not-allowed; }

.domain-link {
  color: inherit;
  text-decoration: none;
  border-bottom: 1px dashed var(--border-secondary);
  transition: color 0.15s, border-color 0.15s;
}
.domain-link:hover,
.domain-link:focus-visible {
  color: var(--primary-text);
  border-bottom-color: currentColor;
  outline: none;
}

/* Modal — копирует .domain-modal из [id].vue (scoped CSS изолирован) */
.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  background: var(--bg-overlay);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
}
.domain-modal {
  width: min(560px, calc(100vw - 2rem));
  max-height: calc(100vh - 2rem);
  display: flex;
  flex-direction: column;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 16px;
  overflow: hidden;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
}
.domain-modal__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  padding: 1.1rem 1.25rem 0.9rem;
  border-bottom: 1px solid var(--border);
}
.domain-modal__title-group { display: flex; align-items: center; gap: 0.75rem; min-width: 0; }
.domain-modal__icon {
  flex-shrink: 0;
  width: 38px;
  height: 38px;
  border-radius: 11px;
  background: linear-gradient(135deg, rgba(var(--primary-rgb), 0.18), rgba(239, 68, 68, 0.15));
  color: var(--primary-light);
  display: flex;
  align-items: center;
  justify-content: center;
}
.domain-modal__title {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 700;
  color: var(--text-heading);
  line-height: 1.2;
}
.domain-modal__subtitle { margin: 0.15rem 0 0; font-size: 0.72rem; color: var(--text-muted); }
.domain-modal__subtitle code {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.9em;
  background: var(--bg-elevated);
  padding: 0.05em 0.3em;
  border-radius: 4px;
}
.domain-modal__close {
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  border: 1px solid var(--border-secondary);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}
.domain-modal__close:hover:not(:disabled) { background: var(--bg-elevated); color: var(--text-primary); border-color: var(--border); }
.domain-modal__close:disabled { opacity: 0.4; cursor: not-allowed; }
.domain-modal__body {
  padding: 1.1rem 1.25rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1.1rem;
}
.domain-modal__swap {
  display: grid;
  grid-template-columns: 1fr auto 1.3fr;
  align-items: end;
  gap: 0.75rem;
}
.domain-modal__swap-col { display: flex; flex-direction: column; gap: 0.4rem; min-width: 0; }
.domain-modal__label {
  font-size: 0.68rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-faint);
}
.domain-modal__chip {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.55rem 0.75rem;
  border-radius: 9px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-secondary);
  color: var(--text-muted);
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.8rem;
  min-height: 38px;
  overflow-wrap: anywhere;
}
.domain-modal__chip code { background: none; color: inherit; font-size: 1em; }
.domain-modal__chip--current { color: var(--text-secondary); }
.domain-modal__arrow {
  display: flex;
  align-items: center;
  justify-content: center;
  padding-bottom: 0.55rem;
  color: var(--text-faint);
}
.domain-modal__input-wrap {
  position: relative;
  display: flex;
  align-items: center;
  background: var(--bg-input, var(--bg-elevated));
  border: 1px solid var(--border-secondary);
  border-radius: 9px;
  transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
  min-height: 38px;
}
.domain-modal__input-wrap:hover { border-color: var(--border); }
.domain-modal__input-wrap:focus-within {
  border-color: var(--primary-text);
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
  background: var(--bg-surface);
}
.domain-modal__input-wrap--error {
  border-color: #f87171;
  box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.15);
}
.domain-modal__input-icon { flex-shrink: 0; margin-left: 0.7rem; color: var(--text-faint); }
.domain-modal__input {
  flex: 1;
  min-width: 0;
  padding: 0.55rem 0.75rem 0.55rem 0.5rem;
  background: none;
  border: none;
  outline: none;
  color: var(--text-primary);
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.82rem;
}
.domain-modal__input::placeholder { color: var(--text-faint); }
.domain-modal__input:disabled { opacity: 0.6; cursor: not-allowed; }
.domain-modal__error { font-size: 0.72rem; color: #f87171; margin-top: 0.15rem; }
.domain-modal__impact {
  padding: 0.85rem 1rem;
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle, var(--border-secondary));
  border-radius: 11px;
}
.domain-modal__impact-title {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  margin-bottom: 0.55rem;
}
.domain-modal__impact-list {
  margin: 0;
  padding-left: 1.1rem;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  font-size: 0.78rem;
  color: var(--text-secondary);
  line-height: 1.5;
}
.domain-modal__impact-list code {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.9em;
  background: rgba(99, 102, 241, 0.1);
  color: #a78bfa;
  padding: 0.05em 0.35em;
  border-radius: 4px;
}
.domain-modal__impact-danger { color: #fca5a5; }
.domain-modal__impact-danger code { background: rgba(239, 68, 68, 0.12); color: #fca5a5; }
html.theme-light .domain-modal__impact-danger { color: #b91c1c; }
html.theme-light .domain-modal__impact-danger code { background: rgba(239, 68, 68, 0.08); color: #b91c1c; }
.domain-modal__footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.55rem;
  padding: 0.9rem 1.25rem;
  border-top: 1px solid var(--border);
  background: var(--bg-secondary, var(--bg-surface));
}
@media (max-width: 560px) {
  .domain-modal__swap { grid-template-columns: 1fr; gap: 0.5rem; }
  .domain-modal__arrow { transform: rotate(90deg); padding: 0; justify-self: start; }
}

/* buttons */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.55rem 1.1rem;
  border-radius: 10px;
  border: none;
  font-size: 0.82rem;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
}
.btn--xs { padding: 0.28rem 0.6rem; font-size: 0.72rem; border-radius: 7px; }
.btn--primary {
  background: linear-gradient(135deg, var(--primary-light), var(--primary-dark));
  color: var(--primary-text-on);
}
.btn--primary:not(:disabled):hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 16px rgba(var(--primary-rgb), 0.2);
}
.btn--primary:disabled { opacity: 0.4; cursor: not-allowed; }
.btn--ghost { background: var(--bg-input); border: 1px solid var(--border-strong); color: var(--text-tertiary); }
.btn--ghost:not(:disabled):hover { color: var(--text-secondary); border-color: var(--border-strong); }
.btn--ghost:disabled { opacity: 0.45; cursor: not-allowed; }
.btn--danger { background: rgba(239, 68, 68, 0.12); border: 1px solid rgba(239, 68, 68, 0.2); color: #f87171; }
.btn--danger:not(:disabled):hover { background: rgba(239, 68, 68, 0.18); }
.btn--danger:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
