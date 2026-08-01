<template>
  <fieldset class="domain-app-form" :disabled="disabled">
    <div class="domain-app-form__fields">
      <div class="domain-app-form__row">
        <div class="domain-app-form__group">
          <label class="domain-app-form__label">Домен <span>*</span></label>
          <input
            v-model="application.domain"
            type="text"
            class="domain-app-form__input"
            :class="{ 'domain-app-form__input--error': application.domain && !isDomainValid(application.domain) }"
            placeholder="example.com"
            maxlength="253"
            required
            autocomplete="off"
            spellcheck="false"
          />
          <small>Hostname без схемы и слеша.</small>
        </div>

        <div class="domain-app-form__group">
          <label class="domain-app-form__label">Preset <span>*</span></label>
          <select
            v-model="application.preset"
            class="domain-app-form__select"
            @change="onPresetChange"
          >
            <option
              v-for="option in SITE_TYPE_OPTIONS"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
          </select>
        </div>
      </div>

      <div class="domain-app-form__group">
        <label class="domain-app-form__label">Папка с веб-файлами <span>*</span></label>
        <input
          v-model="application.filesRelPath"
          type="text"
          class="domain-app-form__input domain-app-form__mono"
          :class="{ 'domain-app-form__input--error': application.filesRelPath && !isFilesRelPathValid(application.filesRelPath) }"
          :placeholder="defaultFilesRelPath || 'www'"
          maxlength="128"
          required
          autocomplete="off"
          spellcheck="false"
        />
        <small>Явный путь внутри homedir: <code>www</code>, <code>www/public</code>, <code>site/front</code>.</small>
      </div>

      <div v-if="showAliases" class="domain-app-form__group">
        <label class="domain-app-form__label">Алиасы</label>
        <div class="domain-app-form__list">
          <div
            v-for="(_alias, aliasIndex) in application.aliases"
            :key="aliasIndex"
            class="domain-app-form__list-row"
          >
            <input
              v-model="application.aliases[aliasIndex]"
              type="text"
              class="domain-app-form__input"
              :class="{ 'domain-app-form__input--error': _alias && !isDomainValid(_alias) }"
              :placeholder="`www.${application.domain || 'example.com'}`"
              autocomplete="off"
              spellcheck="false"
            />
            <button
              type="button"
              class="domain-app-form__remove"
              aria-label="Удалить алиас"
              @click="application.aliases.splice(aliasIndex, 1)"
            >
              ×
            </button>
          </div>
          <button type="button" class="domain-app-form__add" @click="application.aliases.push('')">
            + Добавить алиас
          </button>
        </div>
      </div>
    </div>

    <div class="domain-app-form__modules">
      <section class="domain-app-form__module" :class="{ 'domain-app-form__module--locked': isModx }">
        <label class="domain-app-form__module-head">
          <input
            v-model="application.phpEnabled"
            type="checkbox"
            :disabled="disabled || isModx"
          />
          <span>
            <b>PHP</b>
            <small>Отдельный PHP-FPM pool приложения</small>
          </span>
          <em v-if="isModx">Всегда</em>
        </label>
        <div v-if="application.phpEnabled" class="domain-app-form__module-body">
          <label class="domain-app-form__label">Версия PHP</label>
          <select v-model="application.phpVersion" class="domain-app-form__select">
            <option v-for="version in phpVersions" :key="version.value" :value="version.value">
              {{ version.label }}
            </option>
          </select>
        </div>
      </section>

      <section class="domain-app-form__module" :class="{ 'domain-app-form__module--locked': isModx }">
        <label class="domain-app-form__module-head">
          <input
            v-model="application.dbEnabled"
            type="checkbox"
            :disabled="disabled || isModx"
          />
          <span>
            <b>База данных</b>
            <small>Основная БД принадлежит этому домену</small>
          </span>
          <em v-if="isModx">Всегда</em>
        </label>
        <div v-if="application.dbEnabled" class="domain-app-form__module-body">
          <div class="domain-app-form__group">
            <label class="domain-app-form__label">Тип БД</label>
            <select
              v-model="application.dbType"
              class="domain-app-form__select"
              :disabled="disabled || dbOptions.length === 0 || isModx"
            >
              <option v-if="!isModx" value="">Авто</option>
              <option v-for="option in dbOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
            <small v-if="dbOptions.length === 0" class="domain-app-form__warning">
              Совместимый движок БД не установлен.
            </small>
          </div>

          <div class="domain-app-form__row">
            <div class="domain-app-form__group">
              <label class="domain-app-form__label">Имя БД</label>
              <input
                v-model="application.dbName"
                type="text"
                class="domain-app-form__input domain-app-form__mono"
                :placeholder="defaultDbName"
                maxlength="64"
                pattern="^[a-zA-Z0-9_]+$"
              />
            </div>
            <div class="domain-app-form__group">
              <label class="domain-app-form__label">Пользователь БД</label>
              <input
                v-model="application.dbUser"
                type="text"
                class="domain-app-form__input domain-app-form__mono"
                :placeholder="defaultDbUser"
                maxlength="32"
                pattern="^[a-zA-Z0-9_]+$"
              />
            </div>
          </div>

          <div class="domain-app-form__group">
            <label class="domain-app-form__label">Пароль БД</label>
            <div class="domain-app-form__input-action">
              <input
                v-model="application.dbPassword"
                :type="application.showDbPassword ? 'text' : 'password'"
                class="domain-app-form__input domain-app-form__mono"
                placeholder="Сгенерируется автоматически"
                maxlength="128"
                autocomplete="new-password"
              />
              <button
                type="button"
                @click="application.showDbPassword = !application.showDbPassword"
              >
                {{ application.showDbPassword ? 'Скрыть' : 'Показать' }}
              </button>
            </div>
          </div>
        </div>
      </section>

      <section class="domain-app-form__module">
        <label class="domain-app-form__module-head">
          <input v-model="application.sslEnabled" type="checkbox" />
          <span>
            <b>SSL (Let's Encrypt)</b>
            <small>Выпустить сертификат после создания приложения</small>
          </span>
        </label>
        <div v-if="application.sslEnabled" class="domain-app-form__module-body">
          <label class="domain-app-form__check">
            <input v-model="application.httpsRedirect" type="checkbox" />
            <span>Редирект HTTP → HTTPS</span>
          </label>
        </div>
      </section>
    </div>

    <section v-if="showGitDeploy && !isModx" class="domain-app-form__section">
      <h4>Git-деплой</h4>
      <p>Опциональная первичная загрузка кода.</p>
      <div class="domain-app-form__group">
        <label class="domain-app-form__label">Репозиторий</label>
        <input
          v-model="application.gitRepository"
          type="text"
          class="domain-app-form__input domain-app-form__mono"
          placeholder="git@github.com:user/repo.git"
          maxlength="512"
        />
      </div>
      <div v-if="application.gitRepository" class="domain-app-form__group">
        <label class="domain-app-form__label">Ветка</label>
        <input
          v-model="application.deployBranch"
          type="text"
          class="domain-app-form__input domain-app-form__mono"
          placeholder="main"
          maxlength="128"
        />
      </div>
    </section>

    <section v-if="showEnvironment" class="domain-app-form__section">
      <h4>Переменные окружения</h4>
      <div class="domain-app-form__list">
        <div
          v-for="(_pair, pairIndex) in application.envVars"
          :key="pairIndex"
          class="domain-app-form__list-row"
        >
          <input
            v-model="application.envVars[pairIndex]!.key"
            type="text"
            class="domain-app-form__input domain-app-form__mono"
            placeholder="KEY"
            maxlength="128"
          />
          <input
            v-model="application.envVars[pairIndex]!.value"
            type="text"
            class="domain-app-form__input domain-app-form__mono"
            placeholder="VALUE"
            maxlength="512"
          />
          <button
            type="button"
            class="domain-app-form__remove"
            aria-label="Удалить переменную"
            @click="application.envVars.splice(pairIndex, 1)"
          >
            ×
          </button>
        </div>
        <button
          type="button"
          class="domain-app-form__add"
          @click="application.envVars.push({ key: '', value: '' })"
        >
          + Добавить переменную
        </button>
      </div>
    </section>

    <section v-if="isModx" class="domain-app-form__section">
      <h4>MODX</h4>
      <div class="domain-app-form__group">
        <label class="domain-app-form__label">Версия MODX</label>
        <select v-model="application.modxVersion" class="domain-app-form__select">
          <option v-for="version in activeModxVersions" :key="version.value" :value="version.value">
            {{ version.label }}
          </option>
        </select>
      </div>

      <div class="domain-app-form__row">
        <div class="domain-app-form__group">
          <label class="domain-app-form__label">Admin логин</label>
          <input
            v-model="application.cmsAdminUser"
            type="text"
            class="domain-app-form__input domain-app-form__mono"
            :placeholder="defaultDbUser || 'admin'"
            maxlength="64"
            autocomplete="username"
          />
        </div>
        <div class="domain-app-form__group">
          <label class="domain-app-form__label">Admin пароль</label>
          <div class="domain-app-form__input-action">
            <input
              v-model="application.cmsAdminPassword"
              :type="application.showCmsPassword ? 'text' : 'password'"
              class="domain-app-form__input domain-app-form__mono"
              placeholder="Сгенерируется автоматически"
              maxlength="128"
              autocomplete="new-password"
            />
            <button
              type="button"
              @click="application.showCmsPassword = !application.showCmsPassword"
            >
              {{ application.showCmsPassword ? 'Скрыть' : 'Показать' }}
            </button>
          </div>
        </div>
      </div>

      <div class="domain-app-form__row">
        <div class="domain-app-form__group">
          <label class="domain-app-form__label">Префикс таблиц</label>
          <div class="domain-app-form__input-action">
            <input
              v-model="application.cmsTablePrefix"
              type="text"
              class="domain-app-form__input domain-app-form__mono"
              placeholder="modx_"
              maxlength="32"
              pattern="^[a-z][a-z0-9_]*_$"
            />
            <button type="button" @click="application.cmsTablePrefix = generateTablePrefix()">
              Сгенерировать
            </button>
          </div>
        </div>
        <div class="domain-app-form__group">
          <label class="domain-app-form__label">Путь к manager</label>
          <input
            v-model="application.managerPath"
            type="text"
            class="domain-app-form__input domain-app-form__mono"
            placeholder="manager"
            maxlength="64"
            pattern="^[a-zA-Z0-9_-]+$"
          />
        </div>
      </div>

      <div class="domain-app-form__group">
        <label class="domain-app-form__label">Путь к connectors</label>
        <input
          v-model="application.connectorsPath"
          type="text"
          class="domain-app-form__input domain-app-form__mono"
          placeholder="connectors"
          maxlength="64"
          pattern="^[a-zA-Z0-9_-]+$"
        />
      </div>
    </section>
  </fieldset>
</template>

<script setup lang="ts">
import {
  SITE_TYPE_OPTIONS,
  applyDomainPreset,
  dbEngineOptionsForApplication,
  generateTablePrefix,
  isDomainValid,
  isFilesRelPathValid,
  isModxApplication,
  type DomainApplicationDraft,
  type SelectOption,
} from '~/utils/domain-application';

const application = defineModel<DomainApplicationDraft>({ required: true });

const props = withDefaults(
  defineProps<{
    phpVersions: SelectOption[];
    modxRevoVersions: SelectOption[];
    modx3Versions: SelectOption[];
    installedDbEngines: string[];
    defaultDbName?: string;
    defaultDbUser?: string;
    defaultFilesRelPath?: string;
    showAliases?: boolean;
    showGitDeploy?: boolean;
    showEnvironment?: boolean;
    disabled?: boolean;
  }>(),
  {
    defaultDbName: 'site',
    defaultDbUser: 'site',
    defaultFilesRelPath: 'www',
    showAliases: true,
    showGitDeploy: true,
    showEnvironment: true,
    disabled: false,
  },
);

const installedEngineSet = computed(() => new Set(props.installedDbEngines));
const isModx = computed(() => isModxApplication(application.value));
const activeModxVersions = computed(() =>
  application.value.preset === 'MODX_3' ? props.modx3Versions : props.modxRevoVersions,
);
const dbOptions = computed(() =>
  dbEngineOptionsForApplication(application.value, installedEngineSet.value),
);

function onPresetChange(): void {
  const versions = activeModxVersions.value;
  applyDomainPreset(application.value, {
    modxRevoVersion: props.modxRevoVersions[0]?.value,
    modx3Version: props.modx3Versions[0]?.value,
  });
  if (isModx.value && !versions.some((version) => version.value === application.value.modxVersion)) {
    application.value.modxVersion = versions[0]?.value || '';
  }
}
</script>

<style scoped>
.domain-app-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}

.domain-app-form:disabled { opacity: 0.75; }
.domain-app-form__fields,
.domain-app-form__group,
.domain-app-form__list {
  display: flex;
  flex-direction: column;
}
.domain-app-form__fields { gap: 1rem; }
.domain-app-form__group { gap: 0.35rem; min-width: 0; }
.domain-app-form__list { gap: 0.5rem; }
.domain-app-form__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 0.85rem;
}
.domain-app-form__label {
  font-size: 0.78rem;
  font-weight: 500;
  color: var(--text-tertiary);
}
.domain-app-form__label span { color: var(--primary); }
.domain-app-form__input,
.domain-app-form__select {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  border: 1px solid var(--border-secondary);
  border-radius: 10px;
  background: var(--bg-input);
  color: var(--text-primary);
  padding: 0.6rem 0.85rem;
  font: inherit;
  font-size: 0.85rem;
  outline: none;
}
.domain-app-form__input:focus,
.domain-app-form__select:focus {
  border-color: var(--primary-border);
  box-shadow: var(--focus-ring);
}
.domain-app-form__input--error { border-color: var(--danger-border); }
.domain-app-form__mono { font-family: 'JetBrains Mono', monospace; font-size: 0.8rem; }
.domain-app-form small {
  color: var(--text-faint);
  font-size: 0.68rem;
  line-height: 1.45;
}
.domain-app-form__warning { color: var(--danger-light) !important; }
.domain-app-form__list-row {
  display: flex;
  align-items: center;
  gap: 0.45rem;
}
.domain-app-form__list-row .domain-app-form__input { flex: 1; }
.domain-app-form__remove,
.domain-app-form__add,
.domain-app-form__input-action button {
  border: 1px solid var(--border-secondary);
  background: var(--bg-surface);
  color: var(--text-muted);
  border-radius: 9px;
  cursor: pointer;
}
.domain-app-form__remove {
  width: 36px;
  height: 36px;
  flex: 0 0 36px;
  font-size: 1.15rem;
}
.domain-app-form__remove:hover { color: var(--danger-light); border-color: var(--danger-border); }
.domain-app-form__add {
  align-self: flex-start;
  border-style: dashed;
  padding: 0.45rem 0.75rem;
  font-size: 0.75rem;
}
.domain-app-form__modules { display: flex; flex-direction: column; gap: 0.75rem; }
.domain-app-form__module {
  overflow: hidden;
  border: 1px solid var(--border-secondary);
  border-radius: 12px;
  background: var(--bg-surface);
}
.domain-app-form__module-head {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.8rem 0.9rem;
  cursor: pointer;
}
.domain-app-form__module--locked .domain-app-form__module-head { cursor: default; }
.domain-app-form__module-head > input { width: 18px; height: 18px; accent-color: var(--primary); }
.domain-app-form__module-head > span {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
}
.domain-app-form__module-head b { color: var(--text-primary); font-size: 0.88rem; }
.domain-app-form__module-head em {
  padding: 0.15rem 0.45rem;
  border-radius: 5px;
  background: var(--primary-bg);
  color: var(--primary-text);
  font-size: 0.62rem;
  font-style: normal;
  text-transform: uppercase;
}
.domain-app-form__module-body {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  padding: 0.85rem 0.9rem;
  border-top: 1px solid var(--bar-bg);
}
.domain-app-form__check {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--text-secondary);
  font-size: 0.8rem;
}
.domain-app-form__section {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  padding-top: 1rem;
  border-top: 1px solid var(--bar-bg);
}
.domain-app-form__section h4 {
  margin: 0;
  color: var(--text-tertiary);
  font-size: 0.78rem;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.domain-app-form__section p {
  margin: -0.55rem 0 0;
  color: var(--text-muted);
  font-size: 0.75rem;
}
.domain-app-form__input-action { display: flex; min-width: 0; }
.domain-app-form__input-action .domain-app-form__input {
  flex: 1;
  border-radius: 10px 0 0 10px;
}
.domain-app-form__input-action button {
  flex: 0 0 auto;
  padding: 0.5rem 0.7rem;
  border-left: 0;
  border-radius: 0 10px 10px 0;
  font-size: 0.7rem;
}

@media (max-width: 700px) {
  .domain-app-form__row { grid-template-columns: 1fr; }
  .domain-app-form__list-row { align-items: stretch; flex-wrap: wrap; }
}
</style>
