/**
 * @name AfkStatusToggle
 * @author Shawny
 * @version 1.0.6
 * @description AFK status toggle with nickname prefix, presence status, and optional mic mute.
 * @source https://github.com/shawn2dev/betterdiscord-plugins
 * @updateUrl https://raw.githubusercontent.com/shawn2dev/betterdiscord-plugins/refs/heads/main/AfkStatusToggle.plugin.js
 */

'use strict';

const AUTO_UPDATE_CHECK_INTERVAL_MS = 1000 * 60 * 60;
const DEFAULT_PLUGIN_SETTINGS = {
  prefix: '[AFK] ',
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
    return 'AFK status toggle with nickname prefix, presence status, and optional mic mute.';
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

    const prefixSection = makeSection('Nickname Prefix', 'Set the prefix that will be applied to your nickname when AFK mode is enabled.');
    const prefixInput = document.createElement('input');
    prefixInput.type = 'text';
    prefixInput.value = this._settings.prefix;
    prefixInput.style.cssText = 'width:100%;padding:8px;border-radius:8px;border:1px solid var(--background-modifier-accent);background:var(--background-primary);color:var(--text-normal);';
    prefixInput.addEventListener('change', () => {
      this._settings.prefix = prefixInput.value;
      this._saveSettings();
    });
    prefixSection.appendChild(prefixInput);

    const statusSection = makeSection('Status', 'Choose the presence status that will be applied when AFK mode is enabled.');
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

    const muteSection = makeSection('Mute on AFK', 'Mute your microphone automatically while AFK mode is enabled.');
    const muteRow = document.createElement('div');
    muteRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;';
    const muteText = document.createElement('div');
    muteText.textContent = 'Mute microphone';
    muteText.style.cssText = 'font-size:13px;color:var(--text-normal);';
    const muteToggle = this._createToggle(this._settings.muteOnAfk, (value) => {
      this._settings.muteOnAfk = value;
      this._saveSettings();
    });
    muteRow.appendChild(muteText);
    muteRow.appendChild(muteToggle);
    muteSection.appendChild(muteRow);

    const checkNowButton = document.createElement('button');
    checkNowButton.textContent = '업데이트 확인';
    checkNowButton.style.cssText = 'padding:8px 12px;border-radius:8px;border:none;background:#5865f2;color:#ffffff;font-weight:600;cursor:pointer;margin:0 auto;display:block;';
    checkNowButton.addEventListener('click', () => this._checkForUpdates(true));

    root.appendChild(prefixSection);
    root.appendChild(statusSection);
    root.appendChild(muteSection);
    root.appendChild(checkNowButton);

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

  _debugLog(message, data) {
    try {
      console.log('[AfkStatusToggle]', message, data || '');
    } catch (_) {}
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
      return this._unwrapModule(BdApi.Webpack.getModule((m) => m && props.every((p) => p in m)));
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

  _ensureAfkButton() {
    if (this._button) return;
    const attach = () => {
      const gear = document.querySelector('[aria-label="User Settings"], [aria-label="사용자 설정"], [title="User Settings"], [title="사용자 설정"], [data-tooltip-content="User Settings"], [data-tooltip-content="사용자 설정"]');
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
    button.title = 'Toggle AFK';
    button.style.cssText = 'background:transparent;border:none;padding:0;margin-right:4px;width:32px;height:32px;border-radius:8px;cursor:pointer;color:var(--text-normal);display:flex;align-items:center;justify-content:center;align-self:center;line-height:0;';
        button.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512.149 512.149" width="20" height="20" fill="currentColor" style="display:block;margin:auto;">
        <g transform="translate(-1)">
          <g>
            <g>
              <path d="M504.427,111.44l-1.253-1.254c-11.776-11.776-30.967-11.802-42.814,0.035l-46.089,46.574     c-2.428,2.436-6.312,2.534-8.845,0.203l-64.618-59.657c-6.276-5.8-14.442-8.987-22.996-8.987h-96.124     c-2.269,0-4.44,0.865-6.082,2.419l-81.47,77.356c-11.935,11.944-12.756,31.197-1.818,42.92     c5.844,6.268,13.736,9.719,22.219,9.719h0.15c8.413-0.044,16.499-3.619,22.087-9.728l57.538-60.893h20.595L120.63,300.218H37.81     c-19.633,0-35.778,14.68-36.758,33.421c-0.521,9.79,2.904,19.094,9.64,26.191c6.638,7,15.969,11.008,25.618,11.008h123.586     c2.436,0,4.767-1.006,6.444-2.798l63.32-67.593l53.248,55.684l-16.075,102.735c-4.052,17.02,4.114,34.357,19.412,41.198     c4.714,2.119,9.719,3.178,14.698,3.178c5.358,0,10.69-1.227,15.598-3.655c9.481-4.696,16.296-13.285,18.776-23.967     l27.463-147.306c0.53-2.86-0.38-5.809-2.445-7.865l-73.295-73.198l58.227-58.138l40.589,40.58     c11.335,11.335,31.091,11.335,42.417,0l76.156-76.147c5.623-5.623,8.722-13.109,8.722-21.054     C513.149,124.54,510.05,117.063,504.427,111.44z"/>
              <path d="M407.065,114.837c29.211,0,52.966-23.755,52.966-52.966c0-29.211-23.755-52.966-52.966-52.966     c-29.21,0-52.966,23.755-52.966,52.966C354.1,91.082,377.855,114.837,407.065,114.837z"/>
            </g>
          </g>
        </g>
      </svg>
    `;

    this._updateButtonState(button, this._settings.afkActive);
    button.addEventListener('click', async () => {
      this._debugLog('AFK button clicked', { active: this._settings.afkActive });
      this._settings.afkActive = !this._settings.afkActive;
      this._saveSettings();
      this._updateButtonState(button, this._settings.afkActive);
      if (this._settings.afkActive) {
        const result = await this._applyAfkOn();
        this._debugLog('AFK on result', result);
        if (result.success) {
          this._toast('AFK mode enabled.', { type: 'info' });
        } else {
          this._toast(`AFK enable error: ${result.message}`, { type: 'error' });
        }
      } else {
        const result = await this._applyAfkOff();
        this._debugLog('AFK off result', result);
        if (result.success) {
          this._toast('AFK mode disabled.', { type: 'info' });
        } else {
          this._toast(`AFK disable error: ${result.message}`, { type: 'error' });
        }
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
    const presenceSet = await this._setPresence(this._settings.status);
    const muteSet = this._settings.muteOnAfk ? await this._setSelfMute(true) : { success: true };
    const guildId = this._getCurrentGuildId();
    const nicknameSet = guildId ? await this._prefixCurrentNickname(guildId, this._settings.prefix) : { success: true };
    return {
      success: presenceSet.success && muteSet.success,
      message: [
        presenceSet.success ? null : presenceSet.message,
        muteSet.success ? null : muteSet.message,
        guildId ? (nicknameSet.success ? null : nicknameSet.message) : null,
      ]
        .filter(Boolean)
        .join(' | ') || '완료되었습니다.',
    };
  }

  async _applyAfkOff() {
    const presenceSet = await this._setPresence('online');
    const muteSet = this._settings.muteOnAfk ? await this._setSelfMute(false) : { success: true };
    const guildId = this._getCurrentGuildId();
    const nicknameSet = guildId ? await this._restoreNickname(guildId) : { success: true };
    return {
      success: presenceSet.success && muteSet.success,
      message: [
        presenceSet.success ? null : presenceSet.message,
        muteSet.success ? null : muteSet.message,
        guildId ? (nicknameSet.success ? null : nicknameSet.message) : null,
      ]
        .filter(Boolean)
        .join(' | ') || '완료되었습니다.',
    };
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
        (m) => m && (
          typeof m.setStatus === 'function' ||
          typeof m.updateStatus === 'function' ||
          typeof m.setPresence === 'function' ||
          typeof m.updatePresence === 'function' ||
          typeof m.updateLocalPresence === 'function' ||
          typeof m.changeStatus === 'function'
        ),
      );
      this._debugLog('presenceModule', presenceModule);
      if (!presenceModule) return { success: false, message: 'Could not find presence module.' };
      if (typeof presenceModule.setStatus === 'function') {
        presenceModule.setStatus(status);
        return { success: true };
      }
      if (typeof presenceModule.updateStatus === 'function') {
        presenceModule.updateStatus(status);
        return { success: true };
      }
      if (typeof presenceModule.setPresence === 'function') {
        presenceModule.setPresence(status);
        return { success: true };
      }
      if (typeof presenceModule.updatePresence === 'function') {
        presenceModule.updatePresence(status);
        return { success: true };
      }
      if (typeof presenceModule.updateLocalPresence === 'function') {
        presenceModule.updateLocalPresence(status);
        return { success: true };
      }
      if (typeof presenceModule.changeStatus === 'function') {
        presenceModule.changeStatus(status);
        return { success: true };
      }
      return { success: false, message: 'No supported presence function found.' };
    } catch (e) {
      console.warn('[AfkStatusToggle] setPresence failed', e);
      return { success: false, message: `setPresence error: ${e.message || e}` };
    }
  }

  async _setSelfMute(mute) {
    try {
      const voiceModule = this._findModuleWithProps('setSelfMute', 'setLocalMute', 'setMute', 'setMuted', 'muteSelf') || this._findModule(
        (m) => m && (
          typeof m.setSelfMute === 'function' ||
          typeof m.setLocalMute === 'function' ||
          typeof m.setMute === 'function' ||
          typeof m.setMuted === 'function' ||
          typeof m.muteSelf === 'function' ||
          typeof m.setMuted === 'function'
        ),
      );
      this._debugLog('voiceModule', voiceModule);
      if (!voiceModule) return { success: false, message: 'Could not find voice module.' };
      if (typeof voiceModule.setSelfMute === 'function') {
        voiceModule.setSelfMute(mute);
        return { success: true };
      }
      if (typeof voiceModule.setLocalMute === 'function') {
        voiceModule.setLocalMute(mute);
        return { success: true };
      }
      if (typeof voiceModule.setMute === 'function') {
        voiceModule.setMute(mute);
        return { success: true };
      }
      if (typeof voiceModule.setMuted === 'function') {
        voiceModule.setMuted(mute);
        return { success: true };
      }
      if (typeof voiceModule.muteSelf === 'function') {
        voiceModule.muteSelf(mute);
        return { success: true };
      }
      return { success: false, message: 'No supported mute function found.' };
    } catch (e) {
      console.warn('[AfkStatusToggle] setSelfMute failed', e);
      return { success: false, message: `setSelfMute error: ${e.message || e}` };
    }
  }

  _startAutoUpdateTimer() {
    this._stopAutoUpdateTimer();
    const updateUrl = this._getUpdateUrl();
    if (!updateUrl) return;
    this._autoUpdateInterval = setInterval(() => this._checkForUpdates(false), AUTO_UPDATE_CHECK_INTERVAL_MS);
    // If a recent update was just applied, skip the immediate check once to avoid reload loops.
    try {
      if (BdApi && typeof BdApi.loadData === 'function') {
        const skip = BdApi.loadData(this.getName(), 'skipImmediateUpdateCheck');
        if (skip) {
          try { BdApi.saveData(this.getName(), 'skipImmediateUpdateCheck', false); } catch (_) {}
          return;
        }
      }
    } catch (_) {}

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
      if (showToast) this._toast('Update URL not found in plugin metadata.', { type: 'warning' });
      return;
    }

    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      const remoteVersion = this._extractRemoteVersion(text);
      if (!remoteVersion) throw new Error('Remote version could not be detected.');
      if (this._isRemoteVersionNewer(remoteVersion, this.getVersion())) {
        await this._downloadAndApplyUpdate(url, text, remoteVersion);
        if (showToast) this._toast(`Update available v${remoteVersion}`, { type: 'success' });
      } else if (showToast) {
        this._toast(`Current version is up to date (v${this.getVersion()}).`, { type: 'info' });
      }
    } catch (e) {
      if (showToast) {
        this._toast(`Update check failed: ${e.message || e}`, { type: 'error' });
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
      if (!filePath) throw new Error('Unable to determine plugin file path.');
      const fs = this._nodeRequire('fs');
      fs.writeFileSync(filePath, content, 'utf8');
      // Mark that we've just applied an update to avoid an immediate re-check loop after reload.
      try { if (BdApi && typeof BdApi.saveData === 'function') BdApi.saveData(this.getName(), 'skipImmediateUpdateCheck', true); } catch (_) {}
      this._toast(`AfkStatusToggle v${version} successfully updated.`, { type: 'success' });
      BdApi.Plugins.reload(this.getName());
    } catch (e) {
      console.warn('[AfkStatusToggle] _downloadAndApplyUpdate failed', e);
      this._toast('Update download failed.', { type: 'error' });
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

