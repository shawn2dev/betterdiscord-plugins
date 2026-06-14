/**
 * @name AfkStatusToggle
 * @author Shawny
 * @version 1.0.5
 * @description 자리비움 토글 버튼을 사용자 설정 톱니 바로 앞에 추가합니다. 닉네임 프리픽스, 상태, 마이크 음소거를 설정할 수 있습니다. 자동 업데이트 지원.
 * @source https://github.com/shawn2dev/betterdiscord-plugins
 * @updateUrl https://raw.githubusercontent.com/shawn2dev/betterdiscord-plugins/refs/heads/main/AfkStatusToggle.plugin.js
 */

'use strict';

const AUTO_UPDATE_CHECK_INTERVAL_MS = 1000 * 60 * 60;
const DEFAULT_PLUGIN_SETTINGS = {
  prefix: '[자리비움] ',
  status: 'idle',
  muteOnAfk: true,
  afkActive: false,
};

module.exports = class AfkStatusToggle {
  constructor() {
    this._button = null;
    this._observer = null;
    this._settings = { ...DEFAULT_PLUGIN_SETTINGS };
    this._originalNicknames = new Map();
    this._autoUpdateInterval = null;
  }

  getName() {
    return 'AfkStatusToggle';
  }

  getAuthor() {
    return 'Shawny';
  }

  getVersion() {
    return '1.0.5';
  }

  getDescription() {
    return '자리비움 토글 버튼을 사용자 설정 버튼 앞에 추가하고, 닉네임 프리픽스, 상태, 마이크 음소거 설정을 적용합니다.';
  }

  start() {
    this._loadSettings();
    this._ensureAfkButton();
    if (this._settings.afkActive) {
      this._applyAfkOn();
    }
    this._startAutoUpdateTimer();
  }

  stop() {
    this._removeAfkButton();
    this._disconnectObserver();
    this._stopAutoUpdateTimer();
  }

  getSettingsPanel() {
    const root = document.createElement('div');
    root.style.cssText = 'padding:16px;display:flex;flex-direction:column;gap:16px;';

    const makeSection = (title, desc) => {
      const section = document.createElement('div');
      section.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
      section.innerHTML = `
        <div style="font-size:14px;font-weight:600;color:var(--header-primary);">${title}</div>
        <div style="font-size:12px;color:var(--text-muted);">${desc}</div>
      `;
      return section;
    };

    const prefixSection = makeSection('프리픽스', '활성화 시 닉네임 앞에 붙일 텍스트입니다.');
    const prefixInput = document.createElement('input');
    prefixInput.type = 'text';
    prefixInput.value = this._settings.prefix;
    prefixInput.style.cssText = 'width:100%;padding:8px;border-radius:8px;border:1px solid var(--background-modifier-accent);background:var(--background-primary);color:var(--text-normal);';
    prefixInput.addEventListener('change', () => {
      this._settings.prefix = prefixInput.value;
      this._saveSettings();
    });
    prefixSection.appendChild(prefixInput);

    const statusSection = makeSection('상태', '자리비움 버튼을 눌렀을 때 적용할 접속 상태를 선택합니다.');
    const statusSelect = document.createElement('select');
    ['online', 'idle', 'dnd', 'invisible'].forEach((status) => {
      const option = document.createElement('option');
      option.value = status;
      option.textContent = status;
      statusSelect.appendChild(option);
    });
    statusSelect.value = this._settings.status;
    statusSelect.style.cssText = 'width:100%;padding:8px;border-radius:8px;border:1px solid var(--background-modifier-accent);background:var(--background-primary);color:var(--text-normal);';
    statusSelect.addEventListener('change', () => {
      this._settings.status = statusSelect.value;
      this._saveSettings();
    });
    statusSection.appendChild(statusSelect);

    const muteSection = makeSection('마이크 음소거', '자리비움 모드에서 마이크를 자동으로 음소거할지 여부를 설정합니다.');
    const muteRow = document.createElement('div');
    muteRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;';
    const muteText = document.createElement('div');
    muteText.textContent = 'AFK 시 마이크 음소거';
    muteText.style.cssText = 'font-size:13px;color:var(--text-normal);';
    const muteToggle = this._createToggle(this._settings.muteOnAfk, (value) => {
      this._settings.muteOnAfk = value;
      this._saveSettings();
    });
    muteRow.appendChild(muteText);
    muteRow.appendChild(muteToggle);
    muteSection.appendChild(muteRow);

    const updateSection = makeSection('업데이트', '');
    const checkNowButton = document.createElement('button');
    checkNowButton.textContent = '업데이트 확인';
    checkNowButton.style.cssText = 'padding:8px 12px;border-radius:8px;border:none;background:#5865f2;color:#ffffff;font-weight:600;cursor:pointer;margin:0 auto;display:block;';
    checkNowButton.addEventListener('click', () => this._checkForUpdates(true));
    updateSection.appendChild(checkNowButton);

    root.appendChild(prefixSection);
    root.appendChild(statusSection);
    root.appendChild(muteSection);
    root.appendChild(updateSection);

    return root;
  }

  _createToggle(initialValue, onChange) {
    const label = document.createElement('label');
    label.style.cssText = 'position:relative;display:inline-block;width:44px;height:24px;cursor:pointer;';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = initialValue;
    input.style.cssText = 'opacity:0;width:0;height:0;';
    const track = document.createElement('span');
    track.style.cssText = `position:absolute;inset:0;border-radius:999px;transition:background .2s;background:${initialValue ? '#5865f2' : 'var(--background-modifier-accent)'};`;
    const knob = document.createElement('span');
    knob.style.cssText = `position:absolute;top:2px;left:${initialValue ? '22px' : '2px'};width:20px;height:20px;border-radius:50%;background:#ffffff;transition:left .2s;box-shadow:0 1px 2px rgba(0,0,0,.25);`;
    input.addEventListener('change', () => {
      const checked = input.checked;
      track.style.background = checked ? '#5865f2' : 'var(--background-modifier-accent)';
      knob.style.left = checked ? '22px' : '2px';
      onChange(checked);
    });
    label.appendChild(input);
    label.appendChild(track);
    label.appendChild(knob);
    return label;
  }

  _loadSettings() {
    try {
      const saved = BdApi.loadData(this.getName(), 'settings');
      if (saved) {
        this._settings = { ...DEFAULT_PLUGIN_SETTINGS, ...saved };
      }
    } catch (_) {
      this._settings = { ...DEFAULT_PLUGIN_SETTINGS };
    }
  }

  _saveSettings() {
    try {
      BdApi.saveData(this.getName(), 'settings', this._settings);
    } catch (_) {}
  }

  _findModuleWithProps(...props) {
    try {
      if (typeof BdApi.findModuleByProps === 'function') {
        const mod = BdApi.findModuleByProps(...props);
        if (mod) return mod;
      }
      return BdApi.Webpack.getModule((m) => m && props.every((p) => p in m));
    } catch (_) {
      return null;
    }
  }

  _findModule(predicate) {
    try {
      if (typeof BdApi.findModule === 'function') {
        const mod = BdApi.findModule(predicate);
        if (mod) return mod;
      }
      return BdApi.Webpack.getModule(predicate);
    } catch (_) {
      return null;
    }
  }

  _ensureAfkButton() {
    if (this._button) return;
    const attach = () => {
      const gear = document.querySelector('[aria-label*="사용자 설정"],[aria-label*="User Settings"]');
      if (!gear || this._button) return;
      const container = gear.parentElement;
      if (!container) return;
      this._button = this._createAfkButton();
      container.insertBefore(this._button, gear);
    };

    attach();
    if (!this._observer) {
      this._observer = new MutationObserver(() => attach());
      this._observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  _removeAfkButton() {
    if (this._button && this._button.parentElement) {
      this._button.parentElement.removeChild(this._button);
      this._button = null;
    }
  }

  _disconnectObserver() {
    if (this._observer) {
      this._observer.disconnect();
      this._observer = null;
    }
  }

  _createAfkButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.title = '자리비움 토글';
    button.style.cssText = 'background:transparent;border:none;padding:0;margin-right:4px;width:32px;height:32px;border-radius:8px;cursor:pointer;color:var(--text-normal);display:flex;align-items:center;justify-content:center;align-self:center;line-height:0;';
    button.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="20" height="20" fill="currentColor" style="display:block;margin:auto;">
        <path d="M0 0 C3.5 0.125 3.5 0.125 4.5 1.125 C4.54092937 3.45797433 4.54241723 5.79205225 4.5 8.125 C2.85 8.785 1.2 9.445 -0.5 10.125 C4.2918964 14.54593655 4.2918964 14.54593655 10.5 16.125 C10.5 18.105 10.5 20.085 10.5 22.125 C8.87509046 22.15198189 7.25005367 22.17138757 5.625 22.1875 C4.26761719 22.20490234 4.26761719 22.20490234 2.8828125 22.22265625 C0.5 22.125 0.5 22.125 -1.5 21.125 C-2.28783103 22.87523563 -2.28783103 22.87523563 -2.5 25.125 C-1.30679615 27.61210722 -1.30679615 27.61210722 0.4375 30.0625 C2.87107669 33.6491153 3.88271329 35.75894426 3.5 40.125 C1.23828125 40.40625 1.23828125 40.40625 -1.5 40.125 C-3.51953125 38.15625 -3.51953125 38.15625 -5.3125 35.625 C-5.91707031 34.7896875 -6.52164062 33.954375 -7.14453125 33.09375 C-7.59183594 32.4440625 -8.03914063 31.794375 -8.5 31.125 C-9.16 31.785 -9.82 32.445 -10.5 33.125 C-13.3203125 33.3203125 -13.3203125 33.3203125 -16.625 33.25 C-17.72070312 33.23195312 -18.81640625 33.21390625 -19.9453125 33.1953125 C-20.78835937 33.17210937 -21.63140625 33.14890625 -22.5 33.125 C-22.5 31.145 -22.5 29.165 -22.5 27.125 C-20.19 27.125 -17.88 27.125 -15.5 27.125 C-14.84 25.145 -14.18 23.165 -13.5 21.125 C-15.15 20.795 -16.8 20.465 -18.5 20.125 C-18.7225617 16.93494902 -18.57725042 14.3924053 -17.6875 11.3125 C-14.07618738 7.70118738 -9.41505482 8.2167922 -4.5 8.125 C-4.5309375 6.4234375 -4.5309375 6.4234375 -4.5625 4.6875 C-4.4830721 0.16010972 -4.4830721 0.16010972 0 0 Z M-1.5 3.125 C-1.5 4.115 -1.5 5.105 -1.5 6.125 C-0.51 6.125 0.48 6.125 1.5 6.125 C1.5 5.135 1.5 4.145 1.5 3.125 C0.51 3.125 -0.48 3.125 -1.5 3.125 Z M-12.5 11.125 C-12.5 12.115 -12.5 13.105 -12.5 14.125 C-10.52 13.795 -8.54 13.465 -6.5 13.125 C-6.995 14.176875 -7.49 15.22875 -8 16.3125 C-9.29865345 19.38825818 -10.15517742 21.75551612 -9.5 25.125 C-7.5995533 26.96815671 -7.5995533 26.96815671 -5.5 28.125 C-5.5928125 26.825625 -5.5928125 26.825625 -5.6875 25.5 C-5.42459342 20.76768147 -3.84530013 17.47030013 -0.5 14.125 C-4.72949995 11.70814288 -7.62335991 10.77666856 -12.5 11.125 Z M-15.5 15.125 C-14.5 17.125 -14.5 17.125 -14.5 17.125 Z M2.5 18.125 C2.83 18.785 3.16 19.445 3.5 20.125 C4.82 20.125 6.14 20.125 7.5 20.125 C7.5 19.465 7.5 18.805 7.5 18.125 C5.85 18.125 4.2 18.125 2.5 18.125 Z M-12.5 27.125 C-11.5 29.125 -11.5 29.125 -11.5 29.125 Z M-5.5 28.125 C-4.5 30.125 -4.5 30.125 -4.5 30.125 Z M-19.5 29.125 C-19.5 29.785 -19.5 30.445 -19.5 31.125 C-17.52 31.125 -15.54 31.125 -13.5 31.125 C-13.17 30.465 -12.84 29.805 -12.5 29.125 C-14.81 29.125 -17.12 29.125 -19.5 29.125 Z" transform="translate(25.5,6.875)"/>
        <path d="M0 0 C8.58 0 17.16 0 26 0 C26 14.52 26 29.04 26 44 C20.72 44 15.44 44 10 44 C10 43.34 10 42.68 10 42 C14.62 42 19.24 42 24 42 C24 28.8 24 15.6 24 2 C16.08 2 8.16 2 0 2 C0 1.34 0 0.68 0 0 Z" transform="translate(21,3)"/>
        <path d="M0 0 C2.86724686 0.57344937 3.8614515 0.8614515 6 3 C5.67028521 6.29714793 5.3773161 7.6226839 3 10 C2.01 10 1.02 10 0 10 C0 9.01 0 8.02 0 7 C-1.65 6.67 -3.3 6.34 -5 6 C-5 5.34 -5 4.68 -5 4 C-3.35 3.67 -1.7 3.34 0 3 C0 2.01 0 1.02 0 0 Z" transform="translate(37,11)"/>
      </svg>
    `;

    this._updateButtonState(button, this._settings.afkActive);
    button.addEventListener('click', async () => {
      this._settings.afkActive = !this._settings.afkActive;
      this._saveSettings();
      this._updateButtonState(button, this._settings.afkActive);
      if (this._settings.afkActive) {
        await this._applyAfkOn();
        this._toast('자리비움 모드가 활성화되었습니다.', { type: 'info' });
      } else {
        await this._applyAfkOff();
        this._toast('자리비움 모드가 비활성화되었습니다.', { type: 'info' });
      }
    });

    return button;
  }

  _updateButtonState(button, active) {
    if (!button) return;
    if (active) {
      button.style.color = 'var(--interactive-danger, #ED4245)';
    } else {
      button.style.color = 'var(--text-normal)';
    }
  }

  async _applyAfkOn() {
    await this._setPresence(this._settings.status);
    if (this._settings.muteOnAfk) await this._setSelfMute(true);
    const guildId = this._getCurrentGuildId();
    if (guildId) {
      await this._prefixCurrentNickname(guildId, this._settings.prefix);
    }
  }

  async _applyAfkOff() {
    await this._setPresence('online');
    if (this._settings.muteOnAfk) await this._setSelfMute(false);
    const guildId = this._getCurrentGuildId();
    if (guildId) {
      await this._restoreNickname(guildId);
    }
  }

  _getCurrentGuildId() {
    try {
      const path = window.location.pathname.split('/');
      if (path[1] === 'channels' && path[2]) return path[2];
    } catch (_) {}
    return null;
  }

  async _prefixCurrentNickname(guildId, prefix) {
    try {
      const userId = this._getCurrentUserId();
      if (!userId || !guildId) return false;
      const memberStore = BdApi.Webpack.getModule((m) => m && typeof m.getMember === 'function');
      const member = memberStore?.getMember?.(guildId, userId);
      const currentNick = member?.nick || member?.user?.username || null;
      if (!this._originalNicknames.has(guildId)) {
        this._originalNicknames.set(guildId, currentNick);
      }
      const newNick = `${prefix}${currentNick ?? ''}`.trim();
      const guildActions = BdApi.Webpack.getModule((m) => m && (typeof m.editGuildMember === 'function' || typeof m.editMember === 'function'));
      if (guildActions) {
        if (typeof guildActions.editGuildMember === 'function') {
          await guildActions.editGuildMember(guildId, userId, { nick: newNick });
          return true;
        }
        if (typeof guildActions.editMember === 'function') {
          await guildActions.editMember(guildId, userId, { nick: newNick });
          return true;
        }
      }
    } catch (e) {
      console.warn('[AfkStatusToggle] prefixCurrentNickname failed', e);
    }
    return false;
  }

  async _restoreNickname(guildId) {
    try {
      const original = this._originalNicknames.get(guildId);
      if (original === undefined) return false;
      const userId = this._getCurrentUserId();
      if (!userId) return false;
      const guildActions = BdApi.Webpack.getModule((m) => m && (typeof m.editGuildMember === 'function' || typeof m.editMember === 'function'));
      if (guildActions) {
        if (typeof guildActions.editGuildMember === 'function') {
          await guildActions.editGuildMember(guildId, userId, { nick: original });
          this._originalNicknames.delete(guildId);
          return true;
        }
        if (typeof guildActions.editMember === 'function') {
          await guildActions.editMember(guildId, userId, { nick: original });
          this._originalNicknames.delete(guildId);
          return true;
        }
      }
    } catch (e) {
      console.warn('[AfkStatusToggle] restoreNickname failed', e);
    }
    return false;
  }

  _getCurrentUserId() {
    try {
      const userModule = BdApi.Webpack.getModule((m) => m && typeof m.getCurrentUser === 'function');
      return userModule?.getCurrentUser?.()?.id || null;
    } catch (_) {
      return null;
    }
  }

  async _setPresence(status) {
    try {
      const presenceModule = this._findModuleWithProps('setStatus', 'updateStatus') || this._findModule(
        (m) => m && (typeof m.setStatus === 'function' || typeof m.updateStatus === 'function' || typeof m.setPresence === 'function' || typeof m.updatePresence === 'function'),
      );
      if (!presenceModule) return false;
      if (typeof presenceModule.setStatus === 'function') {
        presenceModule.setStatus(status);
        return true;
      }
      if (typeof presenceModule.updateStatus === 'function') {
        presenceModule.updateStatus(status);
        return true;
      }
      if (typeof presenceModule.setPresence === 'function') {
        presenceModule.setPresence(status);
        return true;
      }
      if (typeof presenceModule.updatePresence === 'function') {
        presenceModule.updatePresence(status);
        return true;
      }
    } catch (e) {
      console.warn('[AfkStatusToggle] setPresence failed', e);
    }
    return false;
  }

  async _setSelfMute(mute) {
    try {
      const voiceModule = this._findModuleWithProps('setSelfMute', 'setLocalMute', 'setMute', 'setMuted', 'muteSelf') || this._findModule(
        (m) => m && (typeof m.setSelfMute === 'function' || typeof m.setLocalMute === 'function' || typeof m.setMute === 'function' || typeof m.setMuted === 'function' || typeof m.muteSelf === 'function'),
      );
      if (!voiceModule) return false;
      if (typeof voiceModule.setSelfMute === 'function') {
        voiceModule.setSelfMute(mute);
        return true;
      }
      if (typeof voiceModule.setLocalMute === 'function') {
        voiceModule.setLocalMute(mute);
        return true;
      }
      if (typeof voiceModule.setMute === 'function') {
        voiceModule.setMute(mute);
        return true;
      }
      if (typeof voiceModule.setMuted === 'function') {
        voiceModule.setMuted(mute);
        return true;
      }
      if (typeof voiceModule.muteSelf === 'function') {
        voiceModule.muteSelf(mute);
        return true;
      }
    } catch (e) {
      console.warn('[AfkStatusToggle] setSelfMute failed', e);
    }
    return false;
  }

  _startAutoUpdateTimer() {
    this._stopAutoUpdateTimer();
    const updateUrl = this._getUpdateUrl();
    if (!updateUrl) return;
    this._autoUpdateInterval = setInterval(() => this._checkForUpdates(false), AUTO_UPDATE_CHECK_INTERVAL_MS);
    this._checkForUpdates(false);
  }

  _restartAutoUpdateTimer() {
    this._startAutoUpdateTimer();
  }

  _stopAutoUpdateTimer() {
    if (this._autoUpdateInterval) {
      clearInterval(this._autoUpdateInterval);
      this._autoUpdateInterval = null;
    }
  }

  async _checkForUpdates(showToast) {
    const url = this._getUpdateUrl();
    if (!url) {
      if (showToast) this._toast('@updateUrl이 설정되어 있지 않아 업데이트를 확인할 수 없습니다.', { type: 'warning' });
      return;
    }

    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      const remoteVersion = this._extractRemoteVersion(text);
      if (!remoteVersion) throw new Error('원격 버전을 찾을 수 없습니다.');
      if (this._isRemoteVersionNewer(remoteVersion, this.getVersion())) {
        await this._downloadAndApplyUpdate(url, text, remoteVersion);
        if (showToast) this._toast(`업데이트됨: v${remoteVersion}`, { type: 'success' });
      } else if (showToast) {
        this._toast(`최신 버전입니다 (v${this.getVersion()})`, { type: 'info' });
      }
    } catch (e) {
      if (showToast) {
        this._toast(`업데이트 확인 실패: ${e.message || e}`, { type: 'error' });
      }
      console.warn('[AfkStatusToggle] _checkForUpdates failed', e);
    }
  }

  _getUpdateUrl() {
    try {
      const path = this._getPluginFilePath();
      if (!path) return null;
      const fs = this._nodeRequire('fs');
      const content = fs.readFileSync(path, 'utf8');
      const match = content.match(/@updateUrl\s+(.+)/i);
      return match ? match[1].trim() : null;
    } catch (e) {
      console.warn('[AfkStatusToggle] _getUpdateUrl failed', e);
      return null;
    }
  }

  _extractRemoteVersion(content) {
    const match = content.match(/@version\s+([0-9]+(?:\.[0-9]+)*)/i);
    return match ? match[1] : null;
  }

  _isRemoteVersionNewer(remote, current) {
    const parse = (v) => String(v).split('.').map((p) => parseInt(p, 10) || 0);
    const remoteParts = parse(remote);
    const currentParts = parse(current);
    const length = Math.max(remoteParts.length, currentParts.length);
    for (let i = 0; i < length; i += 1) {
      const r = remoteParts[i] || 0;
      const c = currentParts[i] || 0;
      if (r > c) return true;
      if (r < c) return false;
    }
    return false;
  }

  async _downloadAndApplyUpdate(url, content, version) {
    try {
      const filePath = this._getPluginFilePath();
      if (!filePath) throw new Error('플러그인 파일 경로를 찾을 수 없습니다.');
      const fs = this._nodeRequire('fs');
      fs.writeFileSync(filePath, content, 'utf8');
      this._toast(`AfkStatusToggle v${version} 설치됨. 재시작 중...`, { type: 'success' });
      BdApi.Plugins.reload(this.getName());
    } catch (e) {
      console.warn('[AfkStatusToggle] _downloadAndApplyUpdate failed', e);
      this._toast('업데이트 적용에 실패했습니다.', { type: 'error' });
    }
  }

  _getPluginFilePath() {
    try {
      const path = this._nodeRequire('path');
      const plugin = BdApi.Plugins.get(this.getName());
      if (plugin?.filename && BdApi.Plugins?.folder) {
        return path.join(BdApi.Plugins.folder, plugin.filename);
      }
      if (typeof __dirname !== 'undefined' && typeof __filename !== 'undefined') {
        return path.join(__dirname, path.basename(__filename));
      }
      if (BdApi.Plugins?.folder) {
        return path.join(BdApi.Plugins.folder, `${this.getName()}.plugin.js`);
      }
    } catch (_) {}
    return null;
  }

  _nodeRequire(id) {
    try {
      if (typeof globalThis.__non_webpack_require__ === 'function') return globalThis.__non_webpack_require__(id);
      if (typeof globalThis.non_webpack_require === 'function') return globalThis.non_webpack_require(id);
    } catch (_) {}
    return require(id);
  }

  _toast(message, options = {}) {
    try {
      if (BdApi.UI && typeof BdApi.UI.showToast === 'function') {
        BdApi.UI.showToast(message, options);
      } else if (typeof BdApi.showToast === 'function') {
        BdApi.showToast(message, options);
      }
    } catch (_) {}
  }
};
