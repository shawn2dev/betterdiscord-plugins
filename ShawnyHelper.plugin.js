/**
 * @name ShawnyHelper
 * @author Shawny
 * @description Prevent AFK voice channel moves caused by Discord idle/AFK handling and helpers for shawnybot.
 * @version 1.8.0
 * @source https://github.com/shawn2dev/betterdiscord-plugins
 * @updateUrl https://raw.githubusercontent.com/shawn2dev/betterdiscord-plugins/main/ShawnyHelper.plugin.js
 */

'use strict';

const _UPDATE_FILENAME = 'ShawnyHelper.plugin.js';
const _UPDATE_REPO = 'shawn2dev/betterdiscord-plugins';
const _UPDATE_BRANCH = 'main';
const _UPDATE_RAW_PATH = `${_UPDATE_REPO}/${_UPDATE_BRANCH}/${_UPDATE_FILENAME}`;
const _UPDATE_COMMITS_URL = `https://api.github.com/repos/${_UPDATE_REPO}/commits/${_UPDATE_BRANCH}`;
const _AUTO_UPDATE_INITIAL_DELAY_MS = 5000;
const _AUTO_UPDATE_INTERVAL_MS = 1000 * 60 * 60;

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
    // AFK toggle state + settings
    this.afkActive = false;
    this.afkSettings = {
      prefix: '[자리비움] ',
      status: 'idle', // 'online'|'idle'|'dnd'|'invisible'
      muteOnAfk: true,
    };
    this._afkObserver = null;
    this._afkButton = null;
  }

  getName() {
    return 'ShawnyHelper';
  }
  getDescription() {
    return 'AFK 방지 및 shawnybot helper 기능.';
  }
  getVersion() {
    return '1.7.11';
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

  // ---------------- AFK 버튼 및 동작 ----------------
  _ensureAfkButtonObserver() {
    if (this._afkObserver) return;
    const attach = () => {
      try {
        const container = this._findSettingsButtonContainer();
        if (container && !this._afkButton) {
          this._afkButton = this._createAfkButtonElement();
          container.insertBefore(this._afkButton, container.querySelector('[aria-label*="사용자 설정"],[aria-label*="User Settings"]'));
        }
      } catch (e) {
        // ignore
      }
    };

    attach();
    this._afkObserver = new MutationObserver(() => attach());
    this._afkObserver.observe(document.body, { childList: true, subtree: true });
  }

  _findSettingsButtonContainer() {
    // try find the toolbar that contains the gear (user settings) button
    const gear = document.querySelector('[aria-label*="사용자 설정"],[aria-label*="User Settings"]');
    if (gear && gear.parentElement) return gear.parentElement;
    // fallback: look for known buttons container class
    const byClass = document.querySelector('div[class*="buttons_"]');
    if (byClass) return byClass;
    return null;
  }

  _createAfkButtonElement() {
    const btn = document.createElement('button');
    btn.className = 'shawnyhelper-afk-button';
    btn.type = 'button';
    btn.style.cssText = 'background:transparent;border:none;padding:6px;border-radius:6px;cursor:pointer;display:flex;align-items:center;justify-content:center;';
    btn.title = '자리비움 토글';
    btn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 64 64" width="20" height="20" style="display:block;">
        <path d="M0 0 C3.5 0.125 3.5 0.125 4.5 1.125 C4.54092937 3.45797433 4.54241723 5.79205225 4.5 8.125 C2.85 8.785 1.2 9.445 -0.5 10.125 C4.2918964 14.54593655 4.2918964 14.54593655 10.5 16.125 C10.5 18.105 10.5 20.085 10.5 22.125 C8.87509046 22.15198189 7.25005367 22.17138757 5.625 22.1875 C4.26761719 22.20490234 4.26761719 22.20490234 2.8828125 22.22265625 C0.5 22.125 0.5 22.125 -1.5 21.125 C-2.28783103 22.87523563 -2.28783103 22.87523563 -2.5 25.125 C-1.30679615 27.61210722 -1.30679615 27.61210722 0.4375 30.0625 C2.87107669 33.6491153 3.88271329 35.75894426 3.5 40.125 C1.23828125 40.40625 1.23828125 40.40625 -1.5 40.125 C-3.51953125 38.15625 -3.51953125 38.15625 -5.3125 35.625 C-5.91707031 34.7896875 -6.52164062 33.954375 -7.14453125 33.09375 C-7.59183594 32.4440625 -8.03914063 31.794375 -8.5 31.125 C-9.16 31.785 -9.82 32.445 -10.5 33.125 C-13.3203125 33.3203125 -13.3203125 33.3203125 -16.625 33.25 C-17.72070312 33.23195312 -18.81640625 33.21390625 -19.9453125 33.1953125 C-20.78835937 33.17210937 -21.63140625 33.14890625 -22.5 33.125 C-22.5 31.145 -22.5 29.165 -22.5 27.125 C-20.19 27.125 -17.88 27.125 -15.5 27.125 C-14.84 25.145 -14.18 23.165 -13.5 21.125 C-15.15 20.795 -16.8 20.465 -18.5 20.125 C-18.7225617 16.93494902 -18.57725042 14.3924053 -17.6875 11.3125 C-14.07618738 7.70118738 -9.41505482 8.2167922 -4.5 8.125 C-4.5309375 6.4234375 -4.5309375 6.4234375 -4.5625 4.6875 C-4.4830721 0.16010972 -4.4830721 0.16010972 0 0 Z M-1.5 3.125 C-1.5 4.115 -1.5 5.105 -1.5 6.125 C-0.51 6.125 0.48 6.125 1.5 6.125 C1.5 5.135 1.5 4.145 1.5 3.125 C0.51 3.125 -0.48 3.125 -1.5 3.125 Z M-12.5 11.125 C-12.5 12.115 -12.5 13.105 -12.5 14.125 C-10.52 13.795 -8.54 13.465 -6.5 13.125 C-6.995 14.176875 -7.49 15.22875 -8 16.3125 C-9.29865345 19.38825818 -10.15517742 21.75551612 -9.5 25.125 C-7.5995533 26.96815671 -7.5995533 26.96815671 -5.5 28.125 C-5.5928125 26.825625 -5.5928125 26.825625 -5.6875 25.5 C-5.42459342 20.76768147 -3.84530013 17.47030013 -0.5 14.125 C-4.72949995 11.70814288 -7.62335991 10.77666856 -12.5 11.125 Z M-15.5 15.125 C-14.5 17.125 -14.5 17.125 -14.5 17.125 Z M2.5 18.125 C2.83 18.785 3.16 19.445 3.5 20.125 C4.82 20.125 6.14 20.125 7.5 20.125 C7.5 19.465 7.5 18.805 7.5 18.125 C5.85 18.125 4.2 18.125 2.5 18.125 Z M-12.5 27.125 C-11.5 29.125 -11.5 29.125 -11.5 29.125 Z M-5.5 28.125 C-4.5 30.125 -4.5 30.125 -4.5 30.125 Z M-19.5 29.125 C-19.5 29.785 -19.5 30.445 -19.5 31.125 C-17.52 31.125 -15.54 31.125 -13.5 31.125 C-13.17 30.465 -12.84 29.805 -12.5 29.125 C-14.81 29.125 -17.12 29.125 -19.5 29.125 Z " fill="currentColor" transform="translate(25.5,6.875)"/>
        <path d="M0 0 C8.58 0 17.16 0 26 0 C26 14.52 26 29.04 26 44 C20.72 44 15.44 44 10 44 C10 43.34 10 42.68 10 42 C14.62 42 19.24 42 24 42 C24 28.8 24 15.6 24 2 C16.08 2 8.16 2 0 2 C0 1.34 0 0.68 0 0 Z " fill="currentColor" transform="translate(21,3)"/>
        <path d="M0 0 C2.86724686 0.57344937 3.8614515 0.8614515 6 3 C5.67028521 6.29714793 5.3773161 7.6226839 3 10 C2.01 10 1.02 10 0 10 C0 9.01 0 8.02 0 7 C-1.65 6.67 -3.3 6.34 -5 6 C-5 5.34 -5 4.68 -5 4 C-3.35 3.67 -1.7 3.34 0 3 C0 2.01 0 1.02 0 0 Z " fill="currentColor" transform="translate(37,11)"/>
      </svg>
    `;

    const setActiveStyle = (active) => {
      if (active) {
        btn.style.color = 'var(--interactive-danger, #ED4245)';
        btn.setAttribute('aria-pressed', 'true');
      } else {
        btn.style.color = 'var(--text-normal)';
        btn.removeAttribute('aria-pressed');
      }
    };

    setActiveStyle(this.afkActive);

    btn.addEventListener('click', async () => {
      await this._toggleAfk();
      setActiveStyle(this.afkActive);
    });

    return btn;
  }

  async _toggleAfk() {
    this.afkActive = !this.afkActive;
    this._save();
    if (this.afkActive) {
      await this._applyAfkOn();
      this._toast('자리비움 모드 시작됨', { type: 'info' });
    } else {
      await this._applyAfkOff();
      this._toast('자리비움 모드 종료됨', { type: 'info' });
    }
  }

  async _applyAfkOn() {
    try {
      // set presence/status
      await this._setPresence(this.afkSettings.status || 'idle');
      // mute if configured
      if (this.afkSettings.muteOnAfk) await this._setLocalMute(true);
      // prefix nickname in current guild if possible
      try {
        const guildEl = document.querySelector('[data-list-item-id^="guildsnav__"]');
        const guildId = (guildEl && guildEl.getAttribute && guildEl.getAttribute('data-list-item-id')) || null;
        // best-effort: try to detect current guild from DOM
        // guildId format may vary; skip if not found
        if (guildId && typeof guildId === 'string') {
          // extract numeric/ID part
          const id = guildId.split(':').pop();
          await this._setNicknamePrefix(id, this.afkSettings.prefix || '[자리비움] ');
        }
      } catch (_) {}
    } catch (e) {
      console.warn('[ShawnyHelper] _applyAfkOn 실패:', e);
    }
  }

  async _applyAfkOff() {
    try {
      await this._setPresence('online');
      if (this.afkSettings.muteOnAfk) await this._setLocalMute(false);
      // try restoring nickname for current guild similar to _applyAfkOn
      try {
        const guildEl = document.querySelector('[data-list-item-id^="guildsnav__"]');
        const guildId = (guildEl && guildEl.getAttribute && guildEl.getAttribute('data-list-item-id')) || null;
        if (guildId && typeof guildId === 'string') {
          const id = guildId.split(':').pop();
          await this._restoreNickname(id);
        }
      } catch (_) {}
    } catch (e) {
      console.warn('[ShawnyHelper] _applyAfkOff 실패:', e);
    }
  }

  async _setPresence(status) {
    try {
      // try multiple candidate modules
      const candidates = [
        BdApi.Webpack.getModule(m => m && typeof m.setStatus === 'function'),
        BdApi.Webpack.getModule(m => m && typeof m.updateStatus === 'function'),
      ];
      for (const mod of candidates) {
        if (!mod) continue;
        if (typeof mod.setStatus === 'function') {
          mod.setStatus(status);
          return true;
        }
        if (typeof mod.updateStatus === 'function') {
          mod.updateStatus(status);
          return true;
        }
      }
    } catch (e) {
      console.warn('[ShawnyHelper] setPresence 오류:', e);
    }
    return false;
  }

  async _setLocalMute(mute) {
    try {
      const VoiceActions = BdApi.Webpack.getModule(m => m && (m.setSelfMute || m.setLocalMute || m.mute));
      if (VoiceActions) {
        if (typeof VoiceActions.setSelfMute === 'function') {
          VoiceActions.setSelfMute(mute);
          return true;
        }
        if (typeof VoiceActions.setLocalMute === 'function') {
          VoiceActions.setLocalMute(mute);
          return true;
        }
        if (typeof VoiceActions.mute === 'function') {
          VoiceActions.mute(mute);
          return true;
        }
      }
    } catch (e) {
      console.warn('[ShawnyHelper] setLocalMute 오류:', e);
    }
    return false;
  }

  async _setNicknamePrefix(guildId, prefix) {
    try {
      if (!guildId) return false;
      const User = BdApi.Webpack.getModule(m => m && typeof m.getCurrentUser === 'function');
      const me = User?.getCurrentUser?.();
      const userId = me?.id;
      if (!userId) return false;

      const GuildMemberActions = BdApi.Webpack.getModule(m => m && (typeof m.editGuildMember === 'function' || typeof m.editMember === 'function'));
      if (GuildMemberActions) {
        const store = BdApi.Webpack.getModule(m => m && typeof m.getMember === 'function');
        let currentNick = null;
        try {
          const member = store?.getMember?.(guildId, userId) || store?.getMember?.(guildId + '','' + userId) || null;
          currentNick = member?.nick || null;
        } catch (_) {}
        // save original
        if (!this._originalNicknames) this._originalNicknames = new Map();
        if (!this._originalNicknames.has(guildId)) this._originalNicknames.set(guildId, currentNick);

        const newNick = `${prefix}${currentNick ?? ''}`.trim();
        try {
          if (typeof GuildMemberActions.editGuildMember === 'function') {
            await GuildMemberActions.editGuildMember(guildId, userId, { nick: newNick });
            return true;
          }
          if (typeof GuildMemberActions.editMember === 'function') {
            await GuildMemberActions.editMember(guildId, userId, { nick: newNick });
            return true;
          }
        } catch (e) {
          console.warn('[ShawnyHelper] editGuildMember 실패:', e);
        }
      }
    } catch (e) {
      console.warn('[ShawnyHelper] _setNicknamePrefix 오류:', e);
    }
    return false;
  }

  async _restoreNickname(guildId) {
    try {
      if (!guildId || !this._originalNicknames) return false;
      const orig = this._originalNicknames.get(guildId);
      if (orig === undefined) return false;
      const User = BdApi.Webpack.getModule(m => m && typeof m.getCurrentUser === 'function');
      const me = User?.getCurrentUser?.();
      const userId = me?.id;
      if (!userId) return false;
      const GuildMemberActions = BdApi.Webpack.getModule(m => m && (typeof m.editGuildMember === 'function' || typeof m.editMember === 'function'));
      if (GuildMemberActions) {
        try {
          if (typeof GuildMemberActions.editGuildMember === 'function') {
            await GuildMemberActions.editGuildMember(guildId, userId, { nick: orig });
            this._originalNicknames.delete(guildId);
            return true;
          }
          if (typeof GuildMemberActions.editMember === 'function') {
            await GuildMemberActions.editMember(guildId, userId, { nick: orig });
            this._originalNicknames.delete(guildId);
            return true;
          }
        } catch (e) {
          console.warn('[ShawnyHelper] restoreNickname 실패:', e);
        }
      }
    } catch (e) {
      console.warn('[ShawnyHelper] _restoreNickname 오류:', e);
    }
    return false;
  }

  _parseVersion(version) {
    return String(version)
      .split('.')
      .map((part) => parseInt(part, 10) || 0);
  }

  _isRemoteVersionNewer(remoteVersion, currentVersion) {
    try {
      if (BdApi.Utils?.semverCompare) {
        // BD semverCompare: 1 = remote is newer, -1 = current is newer, 0 = equal
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
    const ok = typeof res.ok === 'boolean' ? res.ok : status >= 200 && status < 300;
    if (!ok && status !== 0) {
      throw new Error(`HTTP ${status}`);
    }

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
      'User-Agent': 'ShawnyHelper-Updater',
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
        console.warn('[ShawnyHelper] commit SHA lookup failed:', err);
      }
    }

    try {
      const res = await this._fetchUpdateSource(url);
      return this._readUpdateResponse(res);
    } catch (netErr) {
      console.warn('[ShawnyHelper] Net.fetch update failed, trying XHR:', netErr);
      return this._fetchUpdateViaXHR(url);
    }
  }

  _reportUpdateStatus(message, type = 'info') {
    this._toast(message, { type });
  }

  _automaticallyUpdate(retryCount = 0, notify = false) {
    this._downloadRemotePlugin(retryCount)
      .then((data) => {
        const remoteVersion = this._extractRemoteVersion(data);
        if (!remoteVersion) throw new Error('Could not extract version from remote');

        const localVersion = this.getVersion();
        if (!this._isRemoteVersionNewer(remoteVersion, localVersion)) {
          if (notify) {
            this._reportUpdateStatus(`최신 버전입니다 (v${localVersion})`, 'info');
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
          this._reportUpdateStatus(
            `업데이트 확인 실패: ${err?.message || err}`,
            'error',
          );
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
        afkSettings: this.afkSettings,
        afkActive: this.afkActive,
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

    // load afk settings
    try {
      const savedAfk = BdApi.loadData('ShawnyHelper', 'settings');
      if (savedAfk) {
        this.afkSettings = savedAfk.afkSettings ?? this.afkSettings;
        this.afkActive = !!savedAfk.afkActive;
      }
    } catch (_) {}

    // inject AFK button into the UI
    try {
      this._ensureAfkButtonObserver();
      if (this.afkActive) this._applyAfkOn();
    } catch (e) {
      console.warn('[ShawnyHelper] AFK 버튼 초기화 실패:', e);
    }

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
    // cleanup afk UI observer/button
    try {
      if (this._afkObserver) {
        this._afkObserver.disconnect();
        this._afkObserver = null;
      }
      if (this._afkButton && this._afkButton.parentElement) {
        this._afkButton.parentElement.removeChild(this._afkButton);
        this._afkButton = null;
      }
    } catch (_) {}
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

    // AFK 설정 영역
    const afkWrap = Object.create(null);
    afkWrap.container = Object.assign(document.createElement('div'), {
      style: 'display:flex;flex-direction:column;gap:8px;padding:8px 0;'
    });

    const afkTitle = Object.create(null);
    afkTitle.el = document.createElement('div');
    afkTitle.el.innerHTML = `
      <div style="font-size:14px;font-weight:600;color:var(--header-primary);">자리비움 버튼</div>
      <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">툴바의 톱니 바로 앞에 버튼을 추가합니다. 프리픽스·상태·마이크 동작을 설정하세요.</div>
    `;

    const prefixRow = document.createElement('div');
    prefixRow.style = 'display:flex;align-items:center;gap:8px;';
    const prefixLabel = document.createElement('div');
    prefixLabel.style = 'min-width:120px;font-size:13px;color:var(--text-normal);';
    prefixLabel.textContent = '닉네임 프리픽스';
    const prefixInput = document.createElement('input');
    prefixInput.type = 'text';
    prefixInput.value = this.afkSettings.prefix || '[자리비움] ';
    prefixInput.style = 'flex:1;padding:6px;border-radius:6px;border:1px solid var(--background-modifier-accent);background:var(--background-primary);color:var(--text-normal);';
    prefixInput.addEventListener('change', () => {
      this.afkSettings.prefix = prefixInput.value;
      this._save();
    });
    prefixRow.append(prefixLabel, prefixInput);

    const statusRow = document.createElement('div');
    statusRow.style = 'display:flex;align-items:center;gap:8px;';
    const statusLabel = document.createElement('div');
    statusLabel.style = 'min-width:120px;font-size:13px;color:var(--text-normal);';
    statusLabel.textContent = '설정할 상태';
    const statusSelect = document.createElement('select');
    ['online','idle','dnd','invisible'].forEach(s => {
      const o = document.createElement('option'); o.value = s; o.textContent = s; statusSelect.append(o);
    });
    statusSelect.value = this.afkSettings.status || 'idle';
    statusSelect.style = 'flex:1;padding:6px;border-radius:6px;border:1px solid var(--background-modifier-accent);background:var(--background-primary);color:var(--text-normal);';
    statusSelect.addEventListener('change', () => { this.afkSettings.status = statusSelect.value; this._save(); });
    statusRow.append(statusLabel, statusSelect);

    const muteRow = document.createElement('div');
    muteRow.style = 'display:flex;align-items:center;justify-content:space-between;';
    const muteLabel = document.createElement('div');
    muteLabel.innerHTML = `
      <div style="font-size:14px;font-weight:600;color:var(--header-primary);">AFK 시 마이크 음소거</div>
      <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">자리비움 시작 시 마이크를 무음 처리합니다.</div>
    `;
    const muteToggle = this._buildToggle(!!this.afkSettings.muteOnAfk, (v) => { this.afkSettings.muteOnAfk = v; this._save(); });
    muteRow.append(muteLabel, muteToggle);

    afkWrap.container.append(afkTitle.el, prefixRow, statusRow, muteRow);

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

    root.append(row, hr, afkWrap.container, audioRow, sliderWrap, status, dispStatus, updateRow, note);
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
