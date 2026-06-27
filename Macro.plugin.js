/**
 * @name Macro
 * @author Shawny
 * @description Schedule chat messages or slash commands to specific guild/channel at set times (24h).
 * @version 1.0.3
 * @source https://github.com/shawn2dev/betterdiscord-plugins
 * @updateUrl https://raw.githubusercontent.com/shawn2dev/betterdiscord-plugins/main/Macro.plugin.js
 */

'use strict';

const _UPDATE_FILENAME = 'Macro.plugin.js';
const _UPDATE_REPO = 'shawn2dev/betterdiscord-plugins';
const _UPDATE_BRANCH = 'main';
const _UPDATE_COMMITS_URL = `https://api.github.com/repos/${_UPDATE_REPO}/commits/${_UPDATE_BRANCH}`;
const _AUTO_UPDATE_INITIAL_DELAY_MS = 5000;
const _AUTO_UPDATE_INTERVAL_MS = 1000 * 60 * 60;

const DEFAULT_SETTINGS = {
  enabled: true,
  debug: true,
  slashLeadMs: 1250,
  schedulerTickMs: 200,
  macros: [],
};

const REPEAT_MODES = {
  ONCE: 'once',
  DAILY: 'daily',
  INTERVAL: 'interval',
};

module.exports = class Macro {
  constructor() {
    this.enabled = DEFAULT_SETTINGS.enabled;
    this.debug = DEFAULT_SETTINGS.debug;
    this.slashLeadMs = DEFAULT_SETTINGS.slashLeadMs;
    this.schedulerTickMs = DEFAULT_SETTINGS.schedulerTickMs;
    this.macros = [];
    this._schedulerTimer = null;
    this._autoUpdateInterval = null;
    this._moduleCache = {};
    this._interactionPatched = false;
    this._commandCache = {};
    this._lastSessionId = '';
    this._sessionIdSource = '';
  }

  getName() {
    return 'Macro';
  }

  getDescription() {
    return '정해진 시간에 채팅 또는 /명령어를 자동 실행합니다.';
  }

  getVersion() {
    return '1.0.3';
  }

  _debugLog(message, data) {
    if (!this.debug) return;
    try {
      if (data !== undefined) console.log('[Macro]', message, data);
      else console.log('[Macro]', message);
    } catch (_) {}
  }

  getAuthor() {
    return 'Shawny';
  }

  _toast(message, options = {}) {
    try {
      if (BdApi.UI?.showToast) BdApi.UI.showToast(message, options);
      else if (typeof BdApi.showToast === 'function') BdApi.showToast(message, options);
    } catch (_) {}
  }

  _nodeRequire(id) {
    try {
      if (typeof globalThis.__non_webpack_require__ === 'function') {
        return globalThis.__non_webpack_require__(id);
      }
      if (typeof globalThis.non_webpack_require === 'function') {
        return globalThis.non_webpack_require(id);
      }
    } catch (_) {}
    return require(id);
  }

  _unwrapModule(mod) {
    if (!mod) return null;
    if (Array.isArray(mod)) {
      for (const item of mod) {
        const result = this._unwrapModule(item);
        if (result) return result;
      }
      return null;
    }
    if (mod.default && typeof mod.default === 'object') {
      return this._unwrapModule(mod.default);
    }
    return mod;
  }

  _findModuleWithProps(...props) {
    try {
      if (typeof BdApi.findModuleByProps === 'function') {
        const mod = this._unwrapModule(BdApi.findModuleByProps(...props));
        if (mod) return mod;
      }
      return this._unwrapModule(
        BdApi.Webpack.getModule((m) => m && props.every((p) => p in m)),
      );
    } catch (_) {
      return null;
    }
  }

  _findModule(predicate) {
    try {
      if (typeof BdApi.findModule === 'function') {
        const mod = this._unwrapModule(BdApi.findModule(predicate));
        if (mod) return mod;
      }
      return this._unwrapModule(BdApi.Webpack.getModule(predicate));
    } catch (_) {
      return null;
    }
  }

  _getStore(name) {
    try {
      if (BdApi.Webpack.getStore) {
        const store = BdApi.Webpack.getStore(name);
        if (store) return store;
      }
    } catch (_) {}
    return null;
  }

  _configPath() {
    try {
      const path = this._nodeRequire('path');
      return path.join(BdApi.Plugins.folder, 'Macro.config.json');
    } catch (_) {
      return null;
    }
  }

  _save() {
    const data = {
      enabled: this.enabled,
      debug: this.debug,
      slashLeadMs: this.slashLeadMs,
      schedulerTickMs: this.schedulerTickMs,
      macros: this.macros,
    };
    try {
      const filePath = this._configPath();
      if (filePath) {
        this._nodeRequire('fs').writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
        return;
      }
    } catch (err) {
      console.warn('[Macro] config.json 저장 실패:', err);
    }
    try {
      BdApi.saveData('Macro', 'settings', data);
    } catch (_) {}
  }

  _load() {
    try {
      const filePath = this._configPath();
      if (filePath) {
        const fs = this._nodeRequire('fs');
        if (fs.existsSync(filePath)) {
          const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          if (parsed && typeof parsed === 'object') return parsed;
        }
      }
    } catch (err) {
      console.warn('[Macro] config.json 로드 실패:', err);
    }
    try {
      const saved = BdApi.loadData('Macro', 'settings');
      if (saved && typeof saved === 'object') return saved;
    } catch (_) {}
    return null;
  }

  _createMacro(partial = {}) {
    return {
      id: partial.id || `macro-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: partial.name || '새 매크로',
      enabled: partial.enabled ?? true,
      guildId: partial.guildId || '',
      channelId: partial.channelId || '',
      content: partial.content || '',
      hour: this._clamp(partial.hour ?? 0, 0, 23),
      minute: this._clamp(partial.minute ?? 0, 0, 59),
      second: this._clamp(partial.second ?? 0, 0, 59),
      repeatMode: partial.repeatMode || REPEAT_MODES.DAILY,
      intervalMinutes: this._resolveIntervalMinutes(partial),
      applicationId: partial.applicationId || '',
      slashLeadMs: partial.slashLeadMs ?? null,
      lastRunKey: partial.lastRunKey || '',
      completed: partial.completed ?? false,
    };
  }

  _clamp(n, min, max) {
    const v = parseInt(n, 10);
    if (Number.isNaN(v)) return min;
    return Math.min(max, Math.max(min, v));
  }

  _resolveIntervalMinutes(partial) {
    if (partial.intervalMinutes != null && partial.intervalMinutes !== '') {
      return Math.max(1, Number(partial.intervalMinutes) || 120);
    }
    if (partial.intervalHours != null && partial.intervalHours !== '') {
      return Math.max(1, (Number(partial.intervalHours) || 2) * 60);
    }
    return 120;
  }

  _formatIntervalLabel(minutes) {
    if (minutes % 60 === 0 && minutes >= 60) {
      return `${minutes / 60}시간마다`;
    }
    if (minutes >= 60) {
      const h = Math.floor(minutes / 60);
      const m = minutes % 60;
      return m ? `${h}시간 ${m}분마다` : `${h}시간마다`;
    }
    return `${minutes}분마다`;
  }

  _isSlash(content) {
    return String(content || '').trim().startsWith('/');
  }

  _getSlashLeadMs(macro) {
    const v = macro.slashLeadMs ?? this.slashLeadMs;
    return Math.max(0, Number(v) || 1250);
  }

  _dateAt(hour, minute, second, baseDate = new Date()) {
    const d = new Date(baseDate);
    d.setHours(hour, minute, second, 0);
    return d;
  }

  _addDays(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
  }

  _formatTime(date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
  }

  _makeRunKey(macro, slotDate) {
    if (macro.repeatMode === REPEAT_MODES.INTERVAL) {
      return `${macro.id}:${slotDate.getTime()}`;
    }
    const y = slotDate.getFullYear();
    const m = slotDate.getMonth() + 1;
    const d = slotDate.getDate();
    return `${macro.id}:${y}-${m}-${d}-${macro.hour}-${macro.minute}-${macro.second}`;
  }

  _getDailySlot(macro, now) {
    const today = this._dateAt(macro.hour, macro.minute, macro.second, now);
    if (now.getTime() >= today.getTime()) return today;
    return this._dateAt(macro.hour, macro.minute, macro.second, this._addDays(now, -1));
  }

  _getOnceSlot(macro, now) {
    const today = this._dateAt(macro.hour, macro.minute, macro.second, now);
    if (now.getTime() <= today.getTime()) return today;
    return this._dateAt(macro.hour, macro.minute, macro.second, this._addDays(now, 1));
  }

  _getIntervalSlot(macro, now) {
    const intervalMs = Math.max(1, macro.intervalMinutes) * 60000;
    const anchor = this._dateAt(macro.hour, macro.minute, macro.second, now);
    if (now.getTime() < anchor.getTime()) {
      return this._dateAt(
        macro.hour,
        macro.minute,
        macro.second,
        this._addDays(now, -1),
      );
    }

    let slot = anchor;
    while (slot.getTime() + intervalMs <= now.getTime()) {
      slot = new Date(slot.getTime() + intervalMs);
    }
    return slot;
  }

  _getActiveSlot(macro, now) {
    if (!macro.enabled || macro.completed) return null;
    if (macro.repeatMode === REPEAT_MODES.ONCE) return this._getOnceSlot(macro, now);
    if (macro.repeatMode === REPEAT_MODES.INTERVAL) return this._getIntervalSlot(macro, now);
    return this._getDailySlot(macro, now);
  }

  _shouldFireMacro(macro, now) {
    const slot = this._getActiveSlot(macro, now);
    if (!slot) return null;

    const leadMs = this._isSlash(macro.content) ? this._getSlashLeadMs(macro) : 0;
    const fireStart = slot.getTime() - leadMs;
    const fireEnd = slot.getTime() + 800;
    const nowMs = now.getTime();

    if (nowMs < fireStart || nowMs > fireEnd) return null;

    const runKey = this._makeRunKey(macro, slot);
    if (macro.lastRunKey === runKey) return null;

    return { slot, runKey };
  }

  _getCurrentChannelContext() {
    try {
      const parts = window.location.pathname.split('/').filter(Boolean);
      if (parts[0] !== 'channels') return null;
      if (parts[1] === '@me') return { guildId: '', channelId: parts[2] || '' };
      return { guildId: parts[1] || '', channelId: parts[2] || '' };
    } catch (_) {
      return null;
    }
  }

  _getMessageActions() {
    if (this._moduleCache.messageActions) return this._moduleCache.messageActions;
    const mod =
      this._findModuleWithProps('sendMessage', 'receiveMessage') ||
      this._findModuleWithProps('jumpToMessage', '_sendMessage') ||
      this._findModule((m) => m?.sendMessage && m?.receiveMessage);
    this._moduleCache.messageActions = mod;
    return mod;
  }

  _getHttpModule() {
    if (this._moduleCache.http) return this._moduleCache.http;
    let mod =
      this._findModuleWithProps('get', 'post', 'patch', 'put', 'delete') ||
      this._findModuleWithProps('get', 'post', 'patch', 'put', 'del');
    if (!mod) {
      try {
        const F = BdApi.Webpack.Filters;
        if (F?.byStrings) {
          mod = BdApi.Webpack.getModule(F.byStrings('/interactions'), {
            searchExports: true,
          });
        }
      } catch (_) {}
    }
    this._moduleCache.http = mod;
    return mod;
  }

  _getSessionId() {
    if (this._lastSessionId) return this._lastSessionId;

    const fromWebpack = this._findSessionIdFromWebpack();
    if (fromWebpack) {
      this._rememberSessionId(fromWebpack, 'webpack');
      return fromWebpack;
    }

    const fromCache = this._getSessionIdFromInteractionCache();
    if (fromCache) {
      this._rememberSessionId(fromCache, 'interactionCache');
      return fromCache;
    }

    const generated = this._generateSessionId();
    this._rememberSessionId(generated, 'generated');
    this._debugLog('session_id 생성 fallback 사용', `${generated.slice(0, 8)}...`);
    return generated;
  }

  _rememberSessionId(sessionId, source) {
    if (!sessionId) return;
    this._lastSessionId = String(sessionId);
    this._sessionIdSource = source || '';
    try {
      BdApi.saveData('Macro', 'lastSessionId', {
        id: this._lastSessionId,
        source: this._sessionIdSource,
        at: Date.now(),
      });
    } catch (_) {}
  }

  _loadLastSessionId() {
    try {
      const saved = BdApi.loadData('Macro', 'lastSessionId');
      if (saved?.id) {
        this._lastSessionId = String(saved.id);
        this._sessionIdSource = saved.source || 'saved';
      }
    } catch (_) {}
  }

  _getSessionIdFromInteractionCache() {
    let newest = null;
    Object.values(this._commandCache).forEach((entry) => {
      const sid = entry?.interaction?.session_id || entry?.sessionId;
      const at = entry?.cachedAt || 0;
      if (sid && (!newest || at > newest.at)) {
        newest = { id: String(sid), at };
      }
    });
    return newest?.id || null;
  }

  _tryCallSessionId(fn, label) {
    try {
      const id = fn();
      if (typeof id === 'string' && id.length >= 8) {
        this._debugLog(`session_id 획득 (${label})`, `${id.slice(0, 8)}...`);
        return id;
      }
    } catch (err) {
      this._debugLog(`session_id 시도 실패 (${label})`, err?.message || err);
    }
    return null;
  }

  _findSessionIdFromWebpack() {
    const attempts = [];

    try {
      const byKeys = BdApi.Webpack.getByKeys?.('getSessionId');
      if (byKeys) {
        if (typeof byKeys.getSessionId === 'function') {
          attempts.push(() => byKeys.getSessionId());
        }
        if (typeof byKeys === 'function') {
          attempts.push(() => byKeys());
        }
        if (typeof byKeys.default?.getSessionId === 'function') {
          attempts.push(() => byKeys.default.getSessionId());
        }
      }
    } catch (_) {}

    try {
      const mod = this._findModule((m) => typeof m?.getSessionId === 'function');
      if (mod?.getSessionId) attempts.push(() => mod.getSessionId());
    } catch (_) {}

    try {
      const mods =
        BdApi.Webpack.getModules?.(
          (m) => typeof m?.default?.getSessionId === 'function',
          { searchExports: true },
        ) ?? [];
      mods.slice(0, 6).forEach((mod) => {
        attempts.push(() => mod.default.getSessionId());
      });
    } catch (_) {}

    try {
      const F = BdApi.Webpack.Filters;
      if (F?.byStrings) {
        const mods =
          BdApi.Webpack.getModules?.(F.byStrings('getSessionId'), {
            searchExports: true,
          }) ?? [];
        mods.slice(0, 8).forEach((mod) => {
          if (typeof mod?.getSessionId === 'function') {
            attempts.push(() => mod.getSessionId());
          }
          if (typeof mod?.default?.getSessionId === 'function') {
            attempts.push(() => mod.default.getSessionId());
          }
        });
      }
    } catch (_) {}

    try {
      const authStore =
        this._getStore('AuthSessionsStore') ||
        this._findModule((m) => typeof m?.getRemoteSessionId === 'function');
      if (authStore?.getRemoteSessionId) {
        attempts.push(() => authStore.getRemoteSessionId());
      }
    } catch (_) {}

    try {
      const sessionsStore =
        this._getStore('SessionsStore') ||
        this._findModule(
          (m) => typeof m?.getSession === 'function' && typeof m?.getActiveSession === 'function',
        );
      if (sessionsStore?.getActiveSession) {
        attempts.push(() => {
          const active = sessionsStore.getActiveSession();
          return active?.session_id || active?.sessionId || active?.id;
        });
      }
      if (sessionsStore?.getSession) {
        attempts.push(() => {
          const session = sessionsStore.getSession();
          return session?.session_id || session?.sessionId || session?.id;
        });
      }
    } catch (_) {}

    for (let i = 0; i < attempts.length; i += 1) {
      const id = this._tryCallSessionId(attempts[i], `attempt-${i + 1}`);
      if (id) return id;
    }

    return null;
  }

  _generateSessionId() {
    try {
      const cryptoObj = globalThis.crypto || globalThis.msCrypto;
      if (cryptoObj?.randomUUID) {
        return cryptoObj.randomUUID().replace(/-/g, '');
      }
      if (cryptoObj?.getRandomValues) {
        const bytes = new Uint8Array(16);
        cryptoObj.getRandomValues(bytes);
        return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      }
    } catch (_) {}

    return '10000000100040008000100000000000'.replace(/[018]/g, (character) =>
      (
        Number(character) ^
        ((Math.random() * 16) >> (Number(character) / 4))
      ).toString(16),
    );
  }

  _getCachedInteraction(guildId, channelId, applicationId, commandName) {
    const key = this._cacheKey(
      guildId || 'dm',
      channelId,
      applicationId,
      commandName,
    );
    return this._commandCache[key]?.interaction || null;
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  _loadCommandCache() {
    try {
      const saved = BdApi.loadData('Macro', 'commandCache');
      if (saved && typeof saved === 'object') this._commandCache = saved;
    } catch (_) {}
  }

  _saveCommandCache() {
    try {
      BdApi.saveData('Macro', 'commandCache', this._commandCache);
    } catch (_) {}
  }

  _cacheKey(guildId, channelId, applicationId, commandName) {
    return `${guildId || 'dm'}:${channelId}:${applicationId}:${commandName}`;
  }

  _getChannelStore() {
    if (this._moduleCache.channelStore) return this._moduleCache.channelStore;
    const store =
      this._getStore('ChannelStore') ||
      this._findModuleWithProps('getChannel', 'getDMFromUserId');
    this._moduleCache.channelStore = store;
    return store;
  }

  _getChannel(channelId) {
    if (!channelId) return null;
    try {
      return this._getChannelStore()?.getChannel?.(channelId) || null;
    } catch (_) {
      return null;
    }
  }

  _getCommandIndexStore() {
    if (this._moduleCache.commandIndex) return this._moduleCache.commandIndex;
    const store =
      this._getStore('ApplicationCommandIndexStore') ||
      this._findModule(
        (m) =>
          m?.indices != null &&
          typeof m.query === 'function' &&
          typeof m.getGuildState === 'function',
      );
    this._moduleCache.commandIndex = store;
    return store;
  }

  _getCommandAppId(cmd) {
    if (!cmd) return '';
    return String(
      cmd.application_id ??
        cmd.applicationId ??
        cmd.application?.id ??
        cmd.rootCommand?.application_id ??
        '',
    );
  }

  _getCommandNames(cmd) {
    if (!cmd) return [];
    return [
      cmd.name,
      cmd.untranslatedName,
      cmd.displayName,
      cmd.rootCommand?.name,
    ]
      .filter(Boolean)
      .map(String);
  }

  _commandMatchesName(cmd, token) {
    return this._getCommandNames(cmd).includes(String(token));
  }

  _normalizeCommand(cmd) {
    if (!cmd || typeof cmd !== 'object') return null;

    if (cmd.application_id && cmd.name && cmd.id && !cmd.untranslatedName) {
      return {
        ...cmd,
        id: String(cmd.id),
        name: String(cmd.name),
        application_id: String(cmd.application_id),
        version: cmd.version,
        options: cmd.options || [],
        _source: 'raw',
      };
    }

    const root = cmd.rootCommand;
    const names = this._getCommandNames(cmd);
    const name = names[0];
    const id = root?.id || cmd.id;
    if (!id || !name) return null;

    return {
      ...cmd,
      id: String(id),
      name: String(name),
      application_id: this._getCommandAppId(cmd),
      version: cmd.version ?? root?.version,
      options: root?.options || cmd.options || [],
      subCommandPath: cmd.subCommandPath,
      rootCommand: root,
      _source: 'processed',
    };
  }

  _extractCommandsFromIndexState(state) {
    const results = [];
    if (!state?.result?.sections) return results;
    Object.values(state.result.sections).forEach((section) => {
      if (!section?.commands) return;
      Object.values(section.commands).forEach((cmd) => {
        const normalized = this._normalizeCommand(cmd);
        if (normalized) results.push(normalized);
      });
    });
    return results;
  }

  _extractCommandsFromApiBody(body) {
    const results = [];
    if (!body || typeof body !== 'object') return results;

    if (Array.isArray(body.application_commands)) {
      body.application_commands.forEach((cmd) => {
        const normalized = this._normalizeCommand(cmd);
        if (normalized) results.push(normalized);
      });
    }

    if (body.sections && typeof body.sections === 'object') {
      Object.values(body.sections).forEach((section) => {
        if (section?.commands) {
          Object.values(section.commands).forEach((cmd) => {
            const normalized = this._normalizeCommand(cmd);
            if (normalized) results.push(normalized);
          });
        }
      });
    }

    return results;
  }

  _getCachedCommands(guildId, channelId, applicationId) {
    return Object.entries(this._commandCache)
      .filter(([key]) => {
        const parts = key.split(':');
        const keyGuild = parts[0];
        const keyChannel = parts[1];
        const keyApp = parts[2];
        if (channelId && keyChannel !== channelId) return false;
        if (guildId && keyGuild !== guildId && keyGuild !== 'dm') return false;
        if (applicationId && keyApp !== String(applicationId)) return false;
        return true;
      })
      .map(([, entry]) => entry?.command)
      .filter(Boolean)
      .map((cmd) => this._normalizeCommand(cmd))
      .filter(Boolean);
  }

  async _fetchCommandsFromRest(guildId, channelId) {
    const http = this._getHttpModule();
    if (!http?.get) return [];

    const urls = [];
    if (channelId) urls.push(`/channels/${channelId}/application-command-index`);
    if (guildId) urls.push(`/guilds/${guildId}/application-command-index`);

    const results = [];
    for (const url of urls) {
      const getAttempts = [
        () => http.get({ url }),
        () => http.get(url),
      ];
      for (const attempt of getAttempts) {
        try {
          const res = await Promise.resolve(attempt());
          const body = res?.body ?? res?.data ?? res;
          const extracted = this._extractCommandsFromApiBody(body);
          if (extracted.length) {
            this._debugLog('REST 명령어 수집', { url, count: extracted.length });
            results.push(...extracted);
            break;
          }
        } catch (err) {
          this._debugLog('REST 명령어 fetch 실패', { url, error: err?.message || err });
        }
      }
    }
    return results;
  }

  _readBodySync(body) {
    if (body == null) return '';
    if (typeof body === 'string') return body;
    try {
      return JSON.stringify(body);
    } catch (_) {
      return '';
    }
  }

  _extractHttpPostBody(args) {
    const first = args[0];
    if (first && typeof first === 'object' && !(first instanceof URL)) {
      return this._readBodySync(first.body ?? first.data ?? first.json);
    }
    const opt = args[1] || {};
    return this._readBodySync(opt.body ?? opt.data ?? opt.json ?? first);
  }

  _extractHttpPostUrl(args) {
    const first = args[0];
    if (first && typeof first === 'object' && !(first instanceof URL)) {
      return String(first.url || first.route || first.path || first.endpoint || '');
    }
    return String(first ?? args[1]?.url ?? '');
  }

  _maybeCacheInteractionBody(body) {
    if (body?.type !== 2 || !body?.data?.name || !body?.application_id) return;

    const guildId = body.guild_id || 'dm';
    const channelId = body.channel_id;
    if (!channelId) return;

    const command = {
      id: String(body.data.id),
      name: String(body.data.name),
      application_id: String(body.application_id),
      version: String(body.data.version ?? '1'),
      type: body.data.type ?? 1,
      options: body.data.options || [],
    };

    const key = this._cacheKey(guildId, channelId, command.application_id, command.name);
    this._commandCache[key] = {
      command,
      interaction: {
        type: body.type,
        application_id: String(body.application_id),
        guild_id: body.guild_id ?? null,
        channel_id: String(channelId),
        session_id: body.session_id ? String(body.session_id) : undefined,
        data: body.data,
      },
      sessionId: body.session_id ? String(body.session_id) : undefined,
      cachedAt: Date.now(),
      guildId,
      channelId,
    };
    if (body.session_id) {
      this._rememberSessionId(body.session_id, 'capturedInteraction');
    }
    this._saveCommandCache();
    this._debugLog('interaction 캐시 저장', { key, command: this._summarizeCommands([command])[0] });
  }

  _maybeCacheInteraction(args) {
    const url = this._extractHttpPostUrl(args);
    if (!/\/interactions/i.test(url)) return;

    const bodyText = this._extractHttpPostBody(args);
    if (!bodyText) return;

    try {
      this._maybeCacheInteractionBody(JSON.parse(bodyText));
    } catch (_) {}
  }

  _maybeCacheFetchInteraction(input, init = {}) {
    const url =
      typeof Request !== 'undefined' && input instanceof Request
        ? input.url
        : String(input?.url ?? input ?? '');
    if (!/\/interactions/i.test(url)) return;

    let bodyText = '';
    if (typeof Request !== 'undefined' && input instanceof Request) {
      try {
        bodyText = init.body != null ? this._readBodySync(init.body) : '';
        if (!bodyText) {
          input.clone().text().then((text) => {
            try {
              this._maybeCacheInteractionBody(JSON.parse(text));
            } catch (_) {}
          }).catch(() => {});
          return;
        }
      } catch (_) {}
    } else {
      bodyText = this._readBodySync(init.body);
    }

    if (!bodyText) return;
    try {
      this._maybeCacheInteractionBody(JSON.parse(bodyText));
    } catch (_) {}
  }

  _installInteractionCapture() {
    if (this._interactionPatched) return;

    let patched = 0;
    const http = this._getHttpModule();
    if (http?.post) {
      try {
        BdApi.Patcher.after('MacroInteractionCache', http, 'post', (_, args, res) => {
          try {
            this._maybeCacheInteraction(args);
          } catch (err) {
            console.warn('[Macro] interaction cache failed:', err);
          }
          return res;
        });
        patched += 1;
      } catch (err) {
        console.warn('[Macro] http.post capture 패치 실패:', err);
      }
    }

    try {
      if (typeof window !== 'undefined' && window.fetch) {
        BdApi.Patcher.before('MacroInteractionCache', window, 'fetch', (_, args) => {
          try {
            this._maybeCacheFetchInteraction(args[0], args[1] || {});
          } catch (err) {
            console.warn('[Macro] fetch capture failed:', err);
          }
        });
        patched += 1;
      }
    } catch (err) {
      console.warn('[Macro] fetch capture 패치 실패:', err);
    }

    if (patched > 0) {
      this._interactionPatched = true;
      this._debugLog('interaction capture 패치됨', { patched });
    }
  }

  _stopInteractionCapture() {
    if (!this._interactionPatched) return;
    try {
      const http = this._getHttpModule();
      if (http) BdApi.Patcher.unpatch('MacroInteractionCache', http, 'post');
    } catch (_) {}
    try {
      if (typeof window !== 'undefined' && window.fetch) {
        BdApi.Patcher.unpatch('MacroInteractionCache', window, 'fetch');
      }
    } catch (_) {}
    this._interactionPatched = false;
  }

  _dedupeCommands(commands) {
    const seen = new Set();
    return commands.filter((cmd) => {
      const key = `${cmd.application_id}:${cmd.id}:${cmd.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  _summarizeCommands(commands) {
    return commands.map((cmd) => ({
      name: cmd.name,
      id: cmd.id,
      application_id: cmd.application_id,
      type: cmd.type,
      version: cmd.version ?? cmd.version_id ?? null,
      source: cmd._source,
    }));
  }

  _pushCommandList(results, sources, label, list) {
    const normalized = (list || [])
      .map((cmd) => this._normalizeCommand(cmd))
      .filter(Boolean);
    if (!normalized.length) return;
    results.push(...normalized);
    sources.push({ label, count: normalized.length });
  }

  async _collectGuildCommands(guildId, channelId, applicationId = '') {
    const store = this._getCommandIndexStore();
    const channel = this._getChannel(channelId);
    const results = [];
    const sources = [];

    if (!store) {
      console.warn('[Macro] ApplicationCommandIndexStore 를 찾을 수 없음');
    } else {
      if (guildId) {
        try {
          this._pushCommandList(
            results,
            sources,
            'getGuildState',
            this._extractCommandsFromIndexState(store.getGuildState(guildId)),
          );
        } catch (err) {
          this._debugLog('getGuildState 실패', err?.message || err);
        }
      }

      if (channel) {
        try {
          this._pushCommandList(
            results,
            sources,
            'getContextState',
            this._extractCommandsFromIndexState(
              store.getContextState({ type: 'channel', channel }),
            ),
          );
        } catch (err) {
          this._debugLog('getContextState 실패', err?.message || err);
        }
      }

      if (applicationId) {
        try {
          this._pushCommandList(
            results,
            sources,
            'getApplicationState',
            this._extractCommandsFromIndexState(store.getApplicationState(applicationId)),
          );
        } catch (err) {
          this._debugLog('getApplicationState 실패', err?.message || err);
        }

        try {
          if (typeof store.getApplicationStates === 'function') {
            const states = store.getApplicationStates();
            const entries =
              states instanceof Map ? [...states.entries()] : Object.entries(states || {});
            entries.forEach(([appId, state]) => {
              if (String(appId) === String(applicationId)) {
                this._pushCommandList(
                  results,
                  sources,
                  `getApplicationStates[${appId}]`,
                  this._extractCommandsFromIndexState(state),
                );
              }
            });
          }
        } catch (err) {
          this._debugLog('getApplicationStates 실패', err?.message || err);
        }
      }

      if (channel && typeof store.query === 'function') {
        const runQuery = (label) => {
          const queryResult = store.query(
            { type: 'channel', channel },
            { commandTypes: [1], applicationCommands: true },
            {
              allowFetch: true,
              applicationId: applicationId || undefined,
            },
          );
          this._pushCommandList(results, sources, label, queryResult?.commands);
          return queryResult;
        };

        try {
          let queryResult = runQuery('query');
          sources.push({ label: 'query.loading', loading: !!queryResult?.loading });
          if (queryResult?.loading) {
            await this._sleep(1500);
            queryResult = runQuery('query.retry');
            sources.push({ label: 'query.retry.loading', loading: !!queryResult?.loading });
          }
        } catch (err) {
          console.warn('[Macro] store.query 실패', err);
        }
      } else if (!channel) {
        sources.push({ label: 'query.skipped', reason: 'channel not in ChannelStore' });
      }
    }

    this._pushCommandList(
      results,
      sources,
      'interactionCache',
      this._getCachedCommands(guildId, channelId, applicationId),
    );

    const restCommands = await this._fetchCommandsFromRest(guildId, channelId);
    this._pushCommandList(results, sources, 'restApi', restCommands);

    const commands = this._dedupeCommands(results);
    const summary = {
      guildId,
      channelId,
      applicationId: applicationId || null,
      storeFound: !!store,
      channelFound: !!channel,
      total: commands.length,
      sources,
      sample: this._summarizeCommands(commands).slice(0, 30),
    };
    this._debugLog('명령어 수집 완료', summary);
    if (!commands.length) console.warn('[Macro] 명령어 수집 결과 없음', summary);

    return { commands, sources, storeFound: !!store, channelFound: !!channel };
  }

  _parseSlashParts(content) {
    const trimmed = String(content || '').trim();
    if (!trimmed.startsWith('/')) return [];
    return trimmed
      .slice(1)
      .split(/\s+/)
      .filter(Boolean);
  }

  _findSlashCommand(commands, parts, applicationId) {
    if (!parts.length) {
      return { command: null, debug: { reason: 'empty parts' } };
    }

    const rootName = parts[0];
    const nameMatches = commands.filter((cmd) => this._commandMatchesName(cmd, rootName));
    const appIdsInCache = [...new Set(commands.map((c) => c.application_id).filter(Boolean))];

    let candidates = nameMatches;
    if (applicationId) {
      candidates = nameMatches.filter(
        (cmd) => String(cmd.application_id) === String(applicationId),
      );
    }

    const debug = {
      rootName,
      requestedApplicationId: applicationId || null,
      totalCommands: commands.length,
      nameMatches: this._summarizeCommands(nameMatches),
      appFilteredMatches: this._summarizeCommands(candidates),
      applicationIdsInCache: appIdsInCache,
    };

    if (!nameMatches.length) {
      debug.reason = 'no command with matching name';
      return { command: null, debug };
    }

    if (applicationId && !candidates.length) {
      debug.reason = 'name matched but application_id did not';
      debug.closestByApp = this._summarizeCommands(
        commands.filter((cmd) => String(cmd.application_id) === String(applicationId)),
      );
      return { command: null, debug };
    }

    if (!candidates.length) {
      debug.reason = 'no candidates after filtering';
      return { command: null, debug };
    }

    if (candidates.length === 1) {
      return { command: candidates[0], debug };
    }

    const chosen = applicationId
      ? candidates[0]
      : candidates.sort((a, b) => (a.guild_id ? -1 : 1))[0];
    debug.chosenFromDuplicates = this._summarizeCommands(candidates);
    return { command: chosen, debug };
  }

  _buildCommandOptions(command, parts) {
    const options = [];
    let idx = 1;
    let current = { options: command.options || command.rootCommand?.options || [] };

    while (idx < parts.length) {
      const token = parts[idx];
      const subOptions = (current.options || []).filter((o) => o.type === 1 || o.type === 2);
      const match = subOptions.find((o) => o.name === token);
      if (match) {
        const entry = { type: match.type, name: match.name };
        if (match.type === 1) entry.options = [];
        options.push(entry);
        current = match;
        idx += 1;
        continue;
      }

      const valueOption = (current.options || []).find(
        (o) => o.type !== 1 && o.type !== 2,
      );
      if (!valueOption) break;

      options.push({
        type: valueOption.type,
        name: valueOption.name,
        value: token,
      });
      idx += 1;
      if (valueOption.type === 3) break;
    }

    return options;
  }

  _generateNonce() {
    return `${Date.now()}${Math.floor(Math.random() * 100000)}`;
  }

  async _sendChatMessage(channelId, content) {
    const actions = this._getMessageActions();
    if (!actions?.sendMessage) {
      throw new Error('MessageActions.sendMessage 모듈을 찾을 수 없습니다.');
    }
    await Promise.resolve(
      actions.sendMessage(channelId, { content: String(content).trim() }, true),
    );
  }

  async _sendSlashCommand(macro) {
    const parts = this._parseSlashParts(macro.content);
    if (!parts.length) throw new Error('슬래시 명령어 형식이 올바르지 않습니다.');

    this._debugLog('슬래시 실행 시작', {
      macro: macro.name,
      content: macro.content,
      parts,
      guildId: macro.guildId,
      channelId: macro.channelId,
      applicationId: macro.applicationId || null,
    });

    const collected = await this._collectGuildCommands(
      macro.guildId,
      macro.channelId,
      macro.applicationId,
    );
    const { command, debug } = this._findSlashCommand(
      collected.commands,
      parts,
      macro.applicationId,
    );

    if (!command) {
      console.warn('[Macro] 슬래시 명령어를 찾지 못함', {
        macro: macro.name,
        content: macro.content,
        guildId: macro.guildId,
        channelId: macro.channelId,
        applicationId: macro.applicationId || null,
        storeFound: collected.storeFound,
        sources: collected.sources,
        lookup: debug,
      });
      const appHint =
        debug.applicationIdsInCache?.length > 0
          ? ` 캐시된 app ID: ${debug.applicationIdsInCache.join(', ')}`
          : ' 캐시된 명령어가 없습니다 — 해당 채널에서 /명령어를 한 번 수동 실행하세요.';
      throw new Error(
        `명령어 "/${parts[0]}" 를 찾을 수 없습니다.${appHint} (콘솔에서 [Macro] 로그 확인)`,
      );
    }

    this._debugLog('슬래시 명령어 선택됨', {
      name: command.name,
      id: command.id,
      application_id: command.application_id,
      version: command.version ?? command.version_id,
      lookup: debug,
    });

    const sessionId = this._getSessionId();
    this._debugLog('session_id 사용', {
      source: this._sessionIdSource || 'unknown',
      preview: `${sessionId.slice(0, 8)}...`,
    });

    const cachedInteraction = this._getCachedInteraction(
      macro.guildId,
      macro.channelId,
      command.application_id || macro.applicationId,
      command.name,
    );

    let payload;
    if (cachedInteraction) {
      payload = {
        ...cachedInteraction,
        guild_id: macro.guildId || cachedInteraction.guild_id || null,
        channel_id: String(macro.channelId),
        session_id: sessionId,
        nonce: this._generateNonce(),
        data: {
          ...cachedInteraction.data,
          options: this._buildCommandOptions(command, parts),
        },
      };
      this._debugLog('캐시된 interaction 템플릿 사용', payload);
    } else {
      const options = this._buildCommandOptions(command, parts);
      const root = command.rootCommand || command;
      payload = {
        type: 2,
        application_id: String(command.application_id || macro.applicationId),
        guild_id: macro.guildId || null,
        channel_id: String(macro.channelId),
        session_id: sessionId,
        data: {
          version: String(command.version ?? root.version ?? '1'),
          id: String(root.id || command.id),
          name: String(root.name || command.name),
          type: root.type ?? command.type ?? 1,
          options,
        },
        nonce: this._generateNonce(),
      };
    }

    this._debugLog('interaction payload', payload);

    const http = this._getHttpModule();
    if (!http?.post) {
      console.warn('[Macro] HTTP post 모듈 없음', { http: !!http });
      throw new Error('HTTP post 모듈을 찾을 수 없습니다.');
    }

    const attempts = [
      () => http.post({ url: '/interactions', body: payload }),
      () => http.post('/interactions', payload),
      () => http.post('/interactions', { body: payload }),
    ];

    let lastErr = null;
    for (let i = 0; i < attempts.length; i += 1) {
      try {
        await Promise.resolve(attempts[i]());
        this._debugLog(`슬래시 전송 성공 (attempt ${i + 1})`);
        return;
      } catch (err) {
        lastErr = err;
        console.warn(`[Macro] 슬래시 전송 attempt ${i + 1} 실패`, err);
      }
    }
    throw lastErr || new Error('슬래시 명령어 전송 실패');
  }

  async _executeMacro(macro) {
    if (!macro.channelId) throw new Error('channelId 가 비어 있습니다.');
    if (!macro.content?.trim()) throw new Error('내용이 비어 있습니다.');

    if (this._isSlash(macro.content)) {
      await this._sendSlashCommand(macro);
    } else {
      await this._sendChatMessage(macro.channelId, macro.content);
    }
  }

  _tickScheduler() {
    if (!this.enabled) return;
    const now = new Date();
    let changed = false;

    for (const macro of this.macros) {
      const fire = this._shouldFireMacro(macro, now);
      if (!fire) continue;

      this._executeMacro(macro)
        .then(() => {
          console.info(
            `[Macro] 실행됨: ${macro.name} @ ${this._formatTime(fire.slot)}`,
          );
        })
        .catch((err) => {
          console.warn(`[Macro] 실행 실패 (${macro.name}):`, err);
          this._toast(`매크로 "${macro.name}" 실행 실패: ${err?.message || err}`, {
            type: 'error',
          });
        });

      macro.lastRunKey = fire.runKey;
      if (macro.repeatMode === REPEAT_MODES.ONCE) {
        macro.completed = true;
        macro.enabled = false;
      }
      changed = true;
    }

    if (changed) this._save();
  }

  _startScheduler() {
    this._stopScheduler();
    this._schedulerTimer = setInterval(
      () => this._tickScheduler(),
      Math.max(100, this.schedulerTickMs),
    );
  }

  _stopScheduler() {
    if (this._schedulerTimer) {
      clearInterval(this._schedulerTimer);
      this._schedulerTimer = null;
    }
  }

  _parseVersion(version) {
    return String(version)
      .split('.')
      .map((part) => parseInt(part, 10) || 0);
  }

  _isRemoteVersionNewer(remoteVersion, currentVersion) {
    try {
      if (BdApi.Utils?.semverCompare) {
        return BdApi.Utils.semverCompare(currentVersion, remoteVersion) === 1;
      }
    } catch (_) {}

    const remote = this._parseVersion(remoteVersion);
    const current = this._parseVersion(currentVersion);
    const length = Math.max(remote.length, current.length);
    for (let i = 0; i < length; i += 1) {
      const next = remote[i] || 0;
      const now = current[i] || 0;
      if (next > now) return true;
      if (next < now) return false;
    }
    return false;
  }

  _extractRemoteVersion(content) {
    const headerMatch = content.match(/@version\s+([0-9]+(?:\.[0-9]+)*)/);
    if (headerMatch) return headerMatch[1];
    const methodMatch = content.match(
      /getVersion\(\)\s*\{\s*return\s+['"]([0-9]+(?:\.[0-9]+)*)['"]/,
    );
    if (methodMatch) return methodMatch[1];
    const looseMatch = content.match(/['"]([0-9]+\.[0-9]+\.[0-9]+)['"]/);
    return looseMatch ? looseMatch[1] : null;
  }

  _getPluginFilePath() {
    const pathMod = this._nodeRequire('path');
    const addon =
      BdApi.Plugins.get(this.getName()) || BdApi.Plugins.get(_UPDATE_FILENAME);
    if (addon?.filename && BdApi.Plugins?.folder) {
      return pathMod.join(BdApi.Plugins.folder, addon.filename);
    }
    if (typeof __filename !== 'undefined' && typeof __dirname !== 'undefined') {
      return pathMod.join(__dirname, pathMod.basename(__filename));
    }
    return pathMod.join(BdApi.Plugins.folder, _UPDATE_FILENAME);
  }

  async _readUpdateResponse(res) {
    const status = res.status ?? res.statusCode ?? 0;
    const ok = typeof res.ok === 'boolean' ? res.ok : status >= 200 && status < 300;
    if (!ok && status !== 0) throw new Error(`HTTP ${status}`);

    if (typeof res.text === 'function') {
      const text = await res.text();
      if (text) return text;
    }
    if (res.content != null) {
      const content = res.content;
      if (typeof Buffer !== 'undefined' && Buffer.isBuffer(content)) {
        return content.toString('utf8');
      }
      if (content instanceof Uint8Array) {
        return new TextDecoder().decode(content);
      }
      return String(content);
    }
    if (typeof res.body === 'string' && res.body) return res.body;
    throw new Error('Empty or unsupported fetch response');
  }

  _applyPluginUpdate(content, version) {
    const fs = this._nodeRequire('fs');
    fs.writeFileSync(this._getPluginFilePath(), content, 'utf8');
    this._toast(`Macro ${version} 설치됨.`, { type: 'success' });
    try {
      BdApi.Plugins.reload(this.getName());
    } catch (err) {
      console.warn('[Macro] reload after update failed:', err);
      this._toast('업데이트 후 수동으로 플러그인을 다시 켜 주세요.', {
        type: 'warning',
      });
    }
  }

  _updateFetchHeaders(extra = {}) {
    return {
      origin: 'discord.com',
      Accept: 'application/vnd.github.raw+json, text/plain, */*',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
      ...extra,
    };
  }

  _fetchUpdateSource(url, extraHeaders = {}) {
    const opts = { headers: this._updateFetchHeaders(extraHeaders) };
    if (BdApi.Net?.fetch) return BdApi.Net.fetch(url, opts);
    return fetch(url, { ...opts, cache: 'no-store' });
  }

  _fetchUpdateViaXHR(url) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.setRequestHeader('Cache-Control', 'no-cache, no-store');
      xhr.setRequestHeader('Pragma', 'no-cache');
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300 && xhr.responseText) {
          resolve(xhr.responseText);
          return;
        }
        reject(new Error(`XHR HTTP ${xhr.status || 'error'}`));
      };
      xhr.onerror = () => reject(new Error('XHR network error'));
      xhr.send();
    });
  }

  _buildUpdateRawUrl(bust, commitSha) {
    if (commitSha) {
      return `https://raw.githubusercontent.com/${_UPDATE_REPO}/${commitSha}/${_UPDATE_FILENAME}`;
    }
    return `https://raw.githubusercontent.com/${_UPDATE_REPO}/refs/heads/${_UPDATE_BRANCH}/${_UPDATE_FILENAME}?bust=${bust}`;
  }

  async _fetchLatestCommitSha() {
    const res = await this._fetchUpdateSource(_UPDATE_COMMITS_URL, {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Macro-Updater',
    });
    const text = await this._readUpdateResponse(res);
    const commit = JSON.parse(text);
    if (!commit?.sha) throw new Error('Could not resolve latest commit SHA');
    return commit.sha;
  }

  async _downloadRemotePlugin(retryCount = 0) {
    const bust = Date.now();
    let url = this._buildUpdateRawUrl(`${bust}&r=${retryCount}`);
    if (retryCount >= 1) {
      try {
        const sha = await this._fetchLatestCommitSha();
        url = this._buildUpdateRawUrl(bust, sha);
      } catch (err) {
        console.warn('[Macro] commit SHA lookup failed:', err);
      }
    }
    try {
      const res = await this._fetchUpdateSource(url);
      return this._readUpdateResponse(res);
    } catch (netErr) {
      console.warn('[Macro] Net.fetch update failed, trying XHR:', netErr);
      return this._fetchUpdateViaXHR(url);
    }
  }

  _automaticallyUpdate(retryCount = 0, notify = false) {
    this._downloadRemotePlugin(retryCount)
      .then((data) => {
        const remoteVersion = this._extractRemoteVersion(data);
        if (!remoteVersion) throw new Error('Could not extract version from remote');

        const localVersion = this.getVersion();
        if (!this._isRemoteVersionNewer(remoteVersion, localVersion)) {
          if (notify) this._toast(`최신 버전입니다 (v${localVersion})`, { type: 'info' });
          return;
        }
        this._applyPluginUpdate(data, remoteVersion);
      })
      .catch((err) => {
        console.warn('[Macro] update check failed:', err);
        if (retryCount < 2) return this._automaticallyUpdate(retryCount + 1, notify);
        if (notify) {
          this._toast(`업데이트 확인 실패: ${err?.message || err}`, { type: 'error' });
        }
      });
  }

  _checkForUpdatesNow() {
    this._toast('업데이트 확인 중…', { type: 'info' });
    this._automaticallyUpdate(0, true);
  }

  _startAutoUpdateChecks() {
    if (this._autoUpdateInterval) clearInterval(this._autoUpdateInterval);
    this._autoUpdateInterval = setInterval(
      () => this._automaticallyUpdate(),
      _AUTO_UPDATE_INTERVAL_MS,
    );
    setTimeout(() => this._automaticallyUpdate(), _AUTO_UPDATE_INITIAL_DELAY_MS);
  }

  _stopAutoUpdateChecks() {
    if (!this._autoUpdateInterval) return;
    clearInterval(this._autoUpdateInterval);
    this._autoUpdateInterval = null;
  }

  _buildToggle(initialValue, onChange) {
    const label = Object.assign(document.createElement('label'), {
      style:
        'position:relative;display:inline-block;width:44px;height:24px;cursor:pointer;flex-shrink:0;',
    });
    const input = Object.assign(document.createElement('input'), {
      type: 'checkbox',
      checked: initialValue,
      style: 'opacity:0;width:0;height:0;',
    });
    const track = Object.assign(document.createElement('span'), {
      style: `position:absolute;inset:0;border-radius:24px;transition:background .2s;background:${initialValue ? '#5865F2' : 'var(--background-modifier-accent)'};`,
    });
    const knob = Object.assign(document.createElement('span'), {
      style: `position:absolute;top:2px;left:${initialValue ? '22px' : '2px'};width:20px;height:20px;border-radius:50%;background:#fff;transition:left .2s;box-shadow:0 1px 3px rgba(0,0,0,.35);`,
    });
    input.addEventListener('change', () => {
      const v = input.checked;
      track.style.background = v ? '#5865F2' : 'var(--background-modifier-accent)';
      knob.style.left = v ? '22px' : '2px';
      onChange(v);
    });
    label.append(input, track, knob);
    return label;
  }

  _input(value, placeholder = '') {
    return Object.assign(document.createElement('input'), {
      type: 'text',
      value: value ?? '',
      placeholder,
      style:
        'width:100%;padding:8px;border-radius:6px;border:1px solid var(--background-modifier-accent);background:var(--background-primary);color:var(--text-normal);font-size:13px;box-sizing:border-box;',
    });
  }

  _numberInput(value, min, max) {
    return Object.assign(document.createElement('input'), {
      type: 'number',
      min: String(min),
      max: String(max),
      value: String(value ?? min),
      style:
        'width:100%;padding:8px;border-radius:6px;border:1px solid var(--background-modifier-accent);background:var(--background-primary);color:var(--text-normal);font-size:13px;box-sizing:border-box;',
    });
  }

  _btn(text, primary = false) {
    return Object.assign(document.createElement('button'), {
      textContent: text,
      style: `padding:6px 12px;border:none;border-radius:4px;cursor:pointer;font-size:12px;font-weight:600;background:${primary ? '#5865F2' : 'var(--background-secondary)'};color:${primary ? '#fff' : 'var(--text-normal)'};`,
    });
  }

  _renderMacroEditor(container, macro, onDone) {
    container.innerHTML = '';
    const wrap = Object.assign(document.createElement('div'), {
      style:
        'display:flex;flex-direction:column;gap:10px;padding:12px;border-radius:8px;background:var(--background-secondary);',
    });

    const title = Object.assign(document.createElement('div'), {
      style: 'font-size:14px;font-weight:600;color:var(--header-primary);',
      textContent: macro.id ? '매크로 편집' : '새 매크로',
    });

    const nameInput = this._input(macro.name, '매크로 이름');
    const guildInput = this._input(macro.guildId, '길드 ID (DM은 비워두기)');
    const channelInput = this._input(macro.channelId, '채널 ID');
    const contentInput = this._input(macro.content, '메시지 또는 /명령어');
    const appIdInput = this._input(macro.applicationId, 'Application ID (선택, 동명 명령어 구분)');

    const timeRow = Object.assign(document.createElement('div'), {
      style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:8px;',
    });
    const hourInput = this._numberInput(macro.hour, 0, 23);
    const minuteInput = this._numberInput(macro.minute, 0, 59);
    const secondInput = this._numberInput(macro.second, 0, 59);
    hourInput.title = '시 (0-23)';
    minuteInput.title = '분 (0-59)';
    secondInput.title = '초 (0-59)';
    timeRow.append(
      Object.assign(document.createElement('div'), { innerHTML: '<div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">시</div>' }),
      Object.assign(document.createElement('div'), { innerHTML: '<div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">분</div>' }),
      Object.assign(document.createElement('div'), { innerHTML: '<div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">초</div>' }),
    );
    timeRow.children[0].append(hourInput);
    timeRow.children[1].append(minuteInput);
    timeRow.children[2].append(secondInput);

    const repeatSelect = Object.assign(document.createElement('select'), {
      style:
        'width:100%;padding:8px;border-radius:6px;border:1px solid var(--background-modifier-accent);background:var(--background-primary);color:var(--text-normal);font-size:13px;',
    });
    [
      ['daily', '매일 (같은 시각)'],
      ['interval', '간격 반복 (N분마다)'],
      ['once', '한 번만'],
    ].forEach(([value, label]) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      repeatSelect.append(opt);
    });
    repeatSelect.value = macro.repeatMode;

    const intervalInput = this._numberInput(macro.intervalMinutes, 1, 10080);
    const intervalWrap = Object.assign(document.createElement('div'), {
      style: 'display:flex;flex-direction:column;gap:4px;',
    });
    const intervalLabel = Object.assign(document.createElement('div'), {
      style: 'font-size:11px;color:var(--text-muted);',
      textContent: '반복 간격 (분)',
    });
    intervalWrap.append(intervalLabel, intervalInput);

    const updateIntervalVisibility = () => {
      intervalWrap.style.display =
        repeatSelect.value === REPEAT_MODES.INTERVAL ? 'flex' : 'none';
    };
    repeatSelect.addEventListener('change', updateIntervalVisibility);
    updateIntervalVisibility();

    const useCurrentBtn = this._btn('현재 채널 ID 사용');
    useCurrentBtn.addEventListener('click', () => {
      const ctx = this._getCurrentChannelContext();
      if (!ctx?.channelId) {
        this._toast('현재 채널을 찾을 수 없습니다.', { type: 'warning' });
        return;
      }
      guildInput.value = ctx.guildId || '';
      channelInput.value = ctx.channelId;
    });

    const testBtn = this._btn('지금 테스트');
    testBtn.addEventListener('click', async () => {
      const draft = this._createMacro({
        ...macro,
        name: nameInput.value.trim() || macro.name,
        guildId: guildInput.value.trim(),
        channelId: channelInput.value.trim(),
        content: contentInput.value,
        hour: hourInput.value,
        minute: minuteInput.value,
        second: secondInput.value,
        repeatMode: repeatSelect.value,
        intervalMinutes: intervalInput.value,
        applicationId: appIdInput.value.trim(),
      });
      try {
        await this._executeMacro(draft);
        this._toast(`테스트 성공: ${draft.name}`, { type: 'success' });
      } catch (err) {
        console.warn('[Macro] 테스트 실패', err);
        this._toast(`테스트 실패: ${err?.message || err}`, { type: 'error' });
      }
    });

    const debugBtn = this._btn('명령어 캐시 확인');
    debugBtn.addEventListener('click', async () => {
      const draft = this._createMacro({
        ...macro,
        guildId: guildInput.value.trim(),
        channelId: channelInput.value.trim(),
        content: contentInput.value,
        applicationId: appIdInput.value.trim(),
      });
      const parts = this._parseSlashParts(draft.content);
      const collected = await this._collectGuildCommands(
        draft.guildId,
        draft.channelId,
        draft.applicationId,
      );
      const { command, debug } = this._findSlashCommand(
        collected.commands,
        parts,
        draft.applicationId,
      );
      console.group('[Macro] 명령어 캐시 확인');
      console.log('macro', draft.name);
      console.log('guildId', draft.guildId, 'channelId', draft.channelId);
      console.log('channelInStore', !!this._getChannel(draft.channelId));
      console.log('applicationId', draft.applicationId || '(미지정)');
      console.log('content', draft.content, 'parts', parts);
      console.log('storeFound', collected.storeFound, 'channelFound', collected.channelFound);
      console.log('sources', collected.sources);
      console.log('totalCommands', collected.commands.length);
      console.log('allCommands', this._summarizeCommands(collected.commands));
      console.log('interactionCacheKeys', Object.keys(this._commandCache));
      console.log('sessionId', this._getSessionId(), 'source', this._sessionIdSource);
      console.log('lookup', debug);
      console.log('resolved', command ? this._summarizeCommands([command])[0] : null);
      console.groupEnd();
      this._toast(
        command
          ? `명령어 찾음: /${command.name} (${command.application_id})`
          : `명령어 없음 — 콘솔 확인 (${collected.commands.length}개 캐시됨)`,
        { type: command ? 'success' : 'warning' },
      );
    });

    const actionRow = Object.assign(document.createElement('div'), {
      style: 'display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;',
    });
    const cancelBtn = this._btn('취소');
    const saveBtn = this._btn('저장', true);
    cancelBtn.addEventListener('click', () => onDone(null));
    saveBtn.addEventListener('click', () => {
      onDone(
        this._createMacro({
          ...macro,
          name: nameInput.value.trim() || '매크로',
          guildId: guildInput.value.trim(),
          channelId: channelInput.value.trim(),
          content: contentInput.value,
          hour: hourInput.value,
          minute: minuteInput.value,
          second: secondInput.value,
          repeatMode: repeatSelect.value,
          intervalMinutes: intervalInput.value,
          applicationId: appIdInput.value.trim(),
          lastRunKey: macro.lastRunKey,
          completed: macro.completed,
        }),
      );
    });
    actionRow.append(testBtn, debugBtn, useCurrentBtn, cancelBtn, saveBtn);

    wrap.append(
      title,
      Object.assign(document.createElement('div'), {
        innerHTML: '<div style="font-size:11px;color:var(--text-muted);">이름</div>',
      }),
      nameInput,
      Object.assign(document.createElement('div'), {
        innerHTML: '<div style="font-size:11px;color:var(--text-muted);">길드 ID</div>',
      }),
      guildInput,
      Object.assign(document.createElement('div'), {
        innerHTML: '<div style="font-size:11px;color:var(--text-muted);">채널 ID</div>',
      }),
      channelInput,
      Object.assign(document.createElement('div'), {
        innerHTML:
          '<div style="font-size:11px;color:var(--text-muted);">내용 (/ 로 시작하면 슬래시 명령어 — ping 보정 적용)</div>',
      }),
      contentInput,
      Object.assign(document.createElement('div'), {
        innerHTML:
          '<div style="font-size:11px;color:var(--text-muted);">Application ID (선택)</div>',
      }),
      appIdInput,
      Object.assign(document.createElement('div'), {
        innerHTML: '<div style="font-size:11px;color:var(--text-muted);">실행 시각 (24시간)</div>',
      }),
      timeRow,
      Object.assign(document.createElement('div'), {
        innerHTML: '<div style="font-size:11px;color:var(--text-muted);">반복</div>',
      }),
      repeatSelect,
      intervalWrap,
      actionRow,
    );

    container.append(wrap);
  }

  _renderMacroList(listEl, editorEl, refreshPanel) {
    listEl.innerHTML = '';
    if (!this.macros.length) {
      listEl.append(
        Object.assign(document.createElement('div'), {
          style: 'font-size:12px;color:var(--text-muted);padding:8px 0;',
          textContent: '등록된 매크로가 없습니다.',
        }),
      );
      return;
    }

    this.macros.forEach((macro) => {
      const row = Object.assign(document.createElement('div'), {
        style:
          'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px;border-radius:8px;background:var(--background-secondary);',
      });

      const info = Object.assign(document.createElement('div'), {
        style: 'flex:1;min-width:0;',
      });
      const repeatLabel =
        macro.repeatMode === REPEAT_MODES.ONCE
          ? '1회'
          : macro.repeatMode === REPEAT_MODES.INTERVAL
            ? this._formatIntervalLabel(macro.intervalMinutes)
            : '매일';
      info.innerHTML = `
        <div style="font-size:13px;font-weight:600;color:var(--header-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${macro.name}${macro.completed ? ' (완료)' : ''}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${String(macro.hour).padStart(2, '0')}:${String(macro.minute).padStart(2, '0')}:${String(macro.second).padStart(2, '0')} · ${repeatLabel} · ${this._isSlash(macro.content) ? '슬래시' : '채팅'}</div>
        <div style="font-size:11px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${macro.content}</div>
      `;

      const actions = Object.assign(document.createElement('div'), {
        style: 'display:flex;gap:6px;align-items:center;flex-shrink:0;',
      });

      const toggle = this._buildToggle(macro.enabled && !macro.completed, (v) => {
        macro.enabled = v;
        if (v) macro.completed = false;
        this._save();
        refreshPanel();
      });

      const editBtn = this._btn('편집');
      editBtn.addEventListener('click', () => {
        this._renderMacroEditor(editorEl, { ...macro }, (updated) => {
          editorEl.innerHTML = '';
          if (updated) {
            const idx = this.macros.findIndex((m) => m.id === macro.id);
            if (idx >= 0) this.macros[idx] = updated;
            this._save();
          }
          refreshPanel();
        });
      });

      const delBtn = this._btn('삭제');
      delBtn.style.color = 'var(--text-danger, #ed4245)';
      delBtn.addEventListener('click', () => {
        this.macros = this.macros.filter((m) => m.id !== macro.id);
        this._save();
        refreshPanel();
      });

      actions.append(toggle, editBtn, delBtn);
      row.append(info, actions);
      listEl.append(row);
    });
  }

  getSettingsPanel() {
    const root = Object.assign(document.createElement('div'), {
      style: 'padding:16px;display:flex;flex-direction:column;gap:16px;max-height:70vh;overflow:auto;',
    });

    const render = () => {
      root.innerHTML = '';

      const headerRow = Object.assign(document.createElement('div'), {
        style: 'display:flex;align-items:center;justify-content:space-between;',
      });
      const headerText = Object.assign(document.createElement('div'), {
        innerHTML: `
          <div style="font-size:14px;font-weight:600;color:var(--header-primary);">Macro 활성화</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">v${this.getVersion()} · 스케줄 실행 ${this.enabled ? '켜짐' : '꺼짐'}</div>
        `,
      });
      const masterToggle = this._buildToggle(this.enabled, (v) => {
        this.enabled = v;
        this._save();
        if (v) this._startScheduler();
        else this._stopScheduler();
        render();
      });
      headerRow.append(headerText, masterToggle);

      const debugRow = Object.assign(document.createElement('div'), {
        style: 'display:flex;align-items:center;justify-content:space-between;',
      });
      const debugLabel = Object.assign(document.createElement('div'), {
        innerHTML: `
          <div style="font-size:14px;font-weight:600;color:var(--header-primary);">디버그 로그</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">콘솔(F12)에 [Macro] 로그 출력</div>
        `,
      });
      const debugToggle = this._buildToggle(this.debug, (v) => {
        this.debug = v;
        this._save();
        this._toast(v ? '디버그 로그 켜짐' : '디버그 로그 꺼짐', { type: 'info' });
      });
      debugRow.append(debugLabel, debugToggle);

      const leadWrap = Object.assign(document.createElement('div'), {
        style: 'display:flex;flex-direction:column;gap:6px;',
      });
      const leadTitle = Object.assign(document.createElement('div'), {
        style: 'font-size:13px;font-weight:600;color:var(--header-primary);',
        textContent: `슬래시 ping 보정: ${this.slashLeadMs}ms`,
      });
      const leadSlider = Object.assign(document.createElement('input'), {
        type: 'range',
        min: '800',
        max: '2000',
        step: '50',
        value: String(this.slashLeadMs),
        style: 'width:100%;accent-color:#5865F2;',
      });
      leadSlider.addEventListener('input', () => {
        this.slashLeadMs = parseInt(leadSlider.value, 10);
        leadTitle.textContent = `슬래시 ping 보정: ${this.slashLeadMs}ms`;
      });
      leadSlider.addEventListener('change', () => this._save());
      const leadDesc = Object.assign(document.createElement('div'), {
        style: 'font-size:11px;color:var(--text-muted);line-height:1.4;',
        textContent:
          '/명령어는 예정 시각보다 약 1~1.5초 빠르게 전송됩니다. 봇 타이밍에 맞게 조절하세요.',
      });
      leadWrap.append(leadTitle, leadSlider, leadDesc);

      const listTitle = Object.assign(document.createElement('div'), {
        style: 'font-size:14px;font-weight:600;color:var(--header-primary);',
        textContent: '매크로 목록',
      });
      const listEl = Object.assign(document.createElement('div'), {
        style: 'display:flex;flex-direction:column;gap:8px;',
      });
      const editorEl = Object.assign(document.createElement('div'), {});

      const addBtn = this._btn('+ 새 매크로', true);
      addBtn.style.alignSelf = 'flex-start';
      addBtn.addEventListener('click', () => {
        this._renderMacroEditor(editorEl, this._createMacro(), (created) => {
          editorEl.innerHTML = '';
          if (created) {
            this.macros.push(created);
            this._save();
          }
          render();
        });
      });

      const updateRow = Object.assign(document.createElement('div'), {
        style: 'display:flex;align-items:center;justify-content:space-between;gap:12px;',
      });
      updateRow.innerHTML = `
        <div>
          <div style="font-size:14px;font-weight:600;color:var(--header-primary);">업데이트 확인</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">GitHub에서 자동 확인</div>
        </div>
      `;
      const updateBtn = this._btn('지금 확인', true);
      updateBtn.addEventListener('click', () => this._checkForUpdatesNow());
      updateRow.append(updateBtn);

      const note = Object.assign(document.createElement('div'), {
        style:
          'padding:8px 12px;border-radius:8px;background:var(--background-secondary);font-size:11px;color:var(--text-muted);line-height:1.45;',
        textContent:
          '슬래시 명령어는 해당 채널에서 한 번 수동 실행하면 interaction 캐시에 저장됩니다. "명령어 캐시 확인" 시 sources에 어디서 수집됐는지 표시됩니다. channelInStore가 false면 Discord에서 해당 채널을 한번 열어주세요.',
      });

      this._renderMacroList(listEl, editorEl, render);
      root.append(headerRow, debugRow, leadWrap, listTitle, listEl, editorEl, addBtn, note, updateRow);
    };

    render();
    return root;
  }

  start() {
    this._loadCommandCache();
    this._loadLastSessionId();
    const saved = this._load();
    if (saved) {
      this.enabled = saved.enabled ?? DEFAULT_SETTINGS.enabled;
      this.debug = saved.debug ?? DEFAULT_SETTINGS.debug;
      this.slashLeadMs = saved.slashLeadMs ?? DEFAULT_SETTINGS.slashLeadMs;
      this.schedulerTickMs = saved.schedulerTickMs ?? DEFAULT_SETTINGS.schedulerTickMs;
      this.macros = Array.isArray(saved.macros)
        ? saved.macros.map((m) => this._createMacro(m))
        : [];
    }

    if (this.enabled) this._startScheduler();
    this._installInteractionCapture();
    this._startAutoUpdateChecks();

    this._toast(
      this.enabled
        ? `Macro 시작됨 (v${this.getVersion()})`
        : 'Macro 로드됨 (설정에서 켜세요)',
      { type: this.enabled ? 'success' : 'info' },
    );
  }

  stop() {
    this._stopScheduler();
    this._stopInteractionCapture();
    this._stopAutoUpdateChecks();
    this._moduleCache = {};
    this._toast('Macro 중지됨', { type: 'info' });
  }
};
