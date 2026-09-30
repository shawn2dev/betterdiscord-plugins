/**
 * @name XpUserMenu
 * @author Shawny
 * @description Add configurable experience commands to the user context menu.
 * @version 1.0.0
 * @source https://github.com/shawn2dev/betterdiscord-plugins
 * @updateUrl https://raw.githubusercontent.com/shawn2dev/betterdiscord-plugins/refs/heads/main/XpUserMenu.plugin.js
 */

'use strict';

const UPDATE_REPO = 'shawn2dev/betterdiscord-plugins';
const UPDATE_BRANCH = 'main';
const UPDATE_FILENAME = 'XpUserMenu.plugin.js';
const UPDATE_INITIAL_DELAY_MS = 5000;
const UPDATE_INTERVAL_MS = 60 * 60 * 1000;

const DEFAULT_SETTINGS = {
  addCommandName: '경험치추가',
  removeCommandName: '경험치제거',
  userOptionName: 'user',
  amountOptionName: 'exp',
  amounts: [500, 1000, 2000],
};

module.exports = class XpUserMenu {
  constructor() {
    this.settings = { ...DEFAULT_SETTINGS };
    this._http = null;
    this._unpatchUserContext = null;
    this._commandCache = new Map();
    this._patchCallback = null;
    this._autoUpdateInterval = null;
    this._autoUpdateTimeout = null;
  }

  getName() {
    return 'XpUserMenu';
  }

  getAuthor() {
    return 'Shawny';
  }

  getVersion() {
    return '1.0.0';
  }

  getDescription() {
    return 'Add configurable experience commands to the user context menu.';
  }

  start() {
    this._loadSettings();
    this._patchContextMenu();
    this._startAutoUpdateChecks();
  }

  stop() {
    if (this._autoUpdateInterval) clearInterval(this._autoUpdateInterval);
    if (this._autoUpdateTimeout) clearTimeout(this._autoUpdateTimeout);
    this._autoUpdateInterval = null;
    this._autoUpdateTimeout = null;
    try {
      if (typeof this._unpatchUserContext === 'function') {
        this._unpatchUserContext();
      } else if (this._patchCallback) {
        BdApi.ContextMenu.unpatch('user-context', this._patchCallback);
      }
    } catch (_) {}
    this._unpatchUserContext = null;
    this._patchCallback = null;
  }

  _loadSettings() {
    try {
      const saved = BdApi.loadData(this.getName(), 'settings');
      this.settings = {
        ...DEFAULT_SETTINGS,
        ...(saved || {}),
        amounts: Array.isArray(saved?.amounts)
          ? [...new Set(saved.amounts.map(Number).filter((value) => Number.isInteger(value) && value > 0))]
          : [...DEFAULT_SETTINGS.amounts],
      };
    } catch (_) {
      this.settings = { ...DEFAULT_SETTINGS, amounts: [...DEFAULT_SETTINGS.amounts] };
    }
  }

  _saveSettings() {
    try {
      BdApi.saveData(this.getName(), 'settings', this.settings);
    } catch (error) {
      this._toast(`Could not save settings: ${error?.message || error}`, 'error');
    }
  }

  _toast(message, type = 'info') {
    try {
      if (BdApi.UI?.showToast) BdApi.UI.showToast(message, { type });
      else BdApi.showToast?.(message, { type });
    } catch (_) {}
  }

  _parseVersion(version) {
    return String(version).split('.').map((part) => Number.parseInt(part, 10) || 0);
  }

  _isRemoteVersionNewer(remoteVersion, currentVersion) {
    const remote = this._parseVersion(remoteVersion);
    const current = this._parseVersion(currentVersion);
    for (let index = 0; index < Math.max(remote.length, current.length); index += 1) {
      const remotePart = remote[index] || 0;
      const currentPart = current[index] || 0;
      if (remotePart !== currentPart) return remotePart > currentPart;
    }
    return false;
  }

  _extractRemoteVersion(content) {
    const match = content.match(/@version\s+([0-9]+(?:\.[0-9]+)*)/i);
    return match?.[1] || null;
  }

  _nodeRequire(id) {
    if (typeof globalThis.__non_webpack_require__ === 'function') {
      return globalThis.__non_webpack_require__(id);
    }
    if (typeof globalThis.non_webpack_require === 'function') {
      return globalThis.non_webpack_require(id);
    }
    return require(id);
  }

  _getPluginFilePath() {
    const path = this._nodeRequire('path');
    const addon = BdApi.Plugins.get(this.getName()) || BdApi.Plugins.get(UPDATE_FILENAME);
    if (addon?.filename && BdApi.Plugins.folder) {
      return path.join(BdApi.Plugins.folder, addon.filename);
    }
    if (typeof __filename !== 'undefined') return __filename;
    throw new Error('Could not determine plugin file path.');
  }

  async _fetchLatestPlugin() {
    const url = `https://raw.githubusercontent.com/${UPDATE_REPO}/refs/heads/${UPDATE_BRANCH}/${UPDATE_FILENAME}?t=${Date.now()}`;
    const options = {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
    };
    const response = BdApi.Net?.fetch
      ? await BdApi.Net.fetch(url, options)
      : await fetch(url, options);
    const status = response.status ?? response.statusCode ?? 0;
    const ok = typeof response.ok === 'boolean' ? response.ok : status >= 200 && status < 300;
    if (!ok && status !== 0) throw new Error(`HTTP ${status}`);
    if (typeof response.text === 'function') return response.text();
    if (typeof response.body === 'string') return response.body;
    if (response.content != null) return String(response.content);
    throw new Error('The update response was empty.');
  }

  async _checkForUpdates(showToast = false) {
    try {
      const content = await this._fetchLatestPlugin();
      const remoteVersion = this._extractRemoteVersion(content);
      if (!remoteVersion || !content.includes('module.exports = class XpUserMenu')) {
        throw new Error('The downloaded plugin did not pass validation.');
      }
      if (!this._isRemoteVersionNewer(remoteVersion, this.getVersion())) {
        if (showToast) this._toast(`XpUserMenu is up to date (v${this.getVersion()}).`, 'info');
        return;
      }

      const fs = this._nodeRequire('fs');
      fs.writeFileSync(this._getPluginFilePath(), content, 'utf8');
      this._toast(`XpUserMenu v${remoteVersion} installed.`, 'success');
      BdApi.Plugins.reload(this.getName());
    } catch (error) {
      console.warn('[XpUserMenu] Update check failed:', error);
      if (showToast) this._toast(`Update check failed: ${error?.message || error}`, 'error');
    }
  }

  _startAutoUpdateChecks() {
    this._stopAutoUpdateChecks();
    this._autoUpdateTimeout = setTimeout(() => {
      this._autoUpdateTimeout = null;
      this._checkForUpdates(false);
    }, UPDATE_INITIAL_DELAY_MS);
    this._autoUpdateInterval = setInterval(() => this._checkForUpdates(false), UPDATE_INTERVAL_MS);
  }

  _stopAutoUpdateChecks() {
    if (this._autoUpdateInterval) clearInterval(this._autoUpdateInterval);
    if (this._autoUpdateTimeout) clearTimeout(this._autoUpdateTimeout);
    this._autoUpdateInterval = null;
    this._autoUpdateTimeout = null;
  }

  _patchContextMenu() {
    if (!BdApi.ContextMenu?.patch || !BdApi.ContextMenu?.buildItem) {
      this._toast('BetterDiscord ContextMenu API is unavailable.', 'error');
      return;
    }

    this._patchCallback = (menu, props) => {
      const userId =
        props?.user?.id ||
        props?.member?.user?.id ||
        props?.userId ||
        props?.targetUser?.id;
      if (!userId || !menu?.props) return;

      const actions = [
        this._buildXpSubmenu('경험치 추가', 'add', userId),
        this._buildXpSubmenu('경험치 제거', 'remove', userId),
      ];
      const children = menu.props.children;
      menu.props.children = [
        ...(Array.isArray(children) ? children : children == null ? [] : [children]),
        ...actions.filter(Boolean),
      ];
    };

    try {
      this._unpatchUserContext = BdApi.ContextMenu.patch('user-context', this._patchCallback);
    } catch (error) {
      this._toast(`Could not add user menu: ${error?.message || error}`, 'error');
    }
  }

  _buildXpSubmenu(label, operation, userId) {
    if (!this.settings.amounts.length) return null;
    return BdApi.ContextMenu.buildItem({
      type: 'submenu',
      label,
      items: this.settings.amounts.map((amount) =>
        BdApi.ContextMenu.buildItem({
          type: 'text',
          label: `${operation === 'add' ? '+' : '-'}${amount.toLocaleString()} XP`,
          action: () => this._runXpCommand(operation, userId, amount),
        }),
      ),
    });
  }

  _getCurrentChannel() {
    try {
      const pathParts = window.location.pathname.split('/').filter(Boolean);
      if (pathParts[0] === 'channels' && pathParts[2]) {
        const channelId = pathParts[2];
        const guildId = pathParts[1] === '@me' ? null : pathParts[1];
        return { channelId, guildId };
      }
    } catch (_) {}

    try {
      const channelStore = BdApi.Webpack.getModule(
        (module) => typeof module?.getChannelId === 'function' && typeof module?.getChannel === 'function',
      );
      const channelId = channelStore?.getChannelId?.();
      const channel = channelId ? channelStore.getChannel(channelId) : null;
      if (channelId) return { channelId, guildId: channel?.guild_id || null };
    } catch (_) {}
    return null;
  }

  _getHttp() {
    if (this._http) return this._http;
    try {
      this._http = BdApi.Webpack.getByKeys('get', 'post', 'patch', 'put', 'delete');
    } catch (_) {}
    if (!this._http) {
      try {
        const filter = BdApi.Webpack.Filters?.byStrings;
        if (filter) {
          this._http = BdApi.Webpack.getModule(filter('/interactions'), { searchExports: true });
        }
      } catch (_) {}
    }
    return this._http;
  }

  async _fetchCommands(channelId, guildId) {
    const cached = this._commandCache.get(channelId);
    if (cached && Date.now() - cached.at < 30000) return cached.commands;

    const http = this._getHttp();
    if (typeof http?.get !== 'function') throw new Error('Discord command API is unavailable.');

    const response = await http.get({ url: `/channels/${channelId}/application-command-index` });
    const body = response?.body ?? response?.data ?? response;
    const commands = [];
    const visited = new Set();

    const visit = (value) => {
      if (!value || typeof value !== 'object' || visited.has(value)) return;
      visited.add(value);
      if (
        !Array.isArray(value) &&
        value.id &&
        (value.application_id || value.applicationId) &&
        value.name &&
        Number(value.type ?? 1) === 1
      ) {
        commands.push(value);
      }
      if (Array.isArray(value)) value.forEach(visit);
      else Object.values(value).forEach(visit);
    };

    visit(body);
    const uniqueCommands = [...new Map(commands.map((command) => [String(command.id), command])).values()];
    this._commandCache.set(channelId, { at: Date.now(), commands: uniqueCommands });
    return uniqueCommands;
  }

  _matchesCommand(command, configuredName) {
    const names = [command.name, command.name_localized, command.name_default]
      .filter((name) => typeof name === 'string')
      .map((name) => name.toLocaleLowerCase());
    return names.includes(configuredName.trim().toLocaleLowerCase());
  }

  _findOption(command, configuredName, type) {
    const options = Array.isArray(command.options) ? command.options : [];
    return options.find((option) => option.name === configuredName) || options.find((option) => Number(option.type) === type);
  }

  _getSessionId() {
    try {
      const module = BdApi.Webpack.getModule((candidate) => typeof candidate?.getSessionId === 'function');
      const sessionId = module?.getSessionId?.();
      if (sessionId) return String(sessionId);
    } catch (_) {}

    try {
      const sessionModule = BdApi.Webpack.getByKeys('getSessionId');
      const sessionId = sessionModule?.getSessionId?.();
      if (sessionId) return String(sessionId);
    } catch (_) {}

    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().replace(/-/g, '');
    return '10000000100040008000100000000000'.replace(/[018]/g, (character) =>
      (Number(character) ^ ((Math.random() * 16) >> (Number(character) / 4))).toString(16),
    );
  }

  async _runXpCommand(operation, userId, amount) {
    try {
      const channel = this._getCurrentChannel();
      if (!channel?.channelId) throw new Error('Open a server text channel first.');

      const configuredName = operation === 'add'
        ? this.settings.addCommandName
        : this.settings.removeCommandName;
      const commands = await this._fetchCommands(channel.channelId, channel.guildId);
      const command = commands.find((candidate) => this._matchesCommand(candidate, configuredName));
      if (!command) throw new Error(`Command not found: ${configuredName}`);

      const userOption = this._findOption(command, this.settings.userOptionName, 6);
      const amountOption = this._findOption(command, this.settings.amountOptionName, 4);
      if (!userOption || !amountOption) {
        throw new Error('The command must have a user option and an integer experience option.');
      }

      const payload = {
        type: 2,
        application_id: String(command.application_id || command.applicationId),
        guild_id: channel.guildId,
        channel_id: String(channel.channelId),
        session_id: this._getSessionId(),
        data: {
          version: String(command.version || '1'),
          id: String(command.id),
          name: String(command.name),
          type: 1,
          options: [
            { type: 6, name: userOption.name, value: String(userId) },
            { type: 4, name: amountOption.name, value: Number(amount) },
          ],
        },
        nonce: `${Date.now()}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`,
        analytics_location: 'user_context_menu',
      };

      const http = this._getHttp();
      await http.post({ url: '/interactions', body: payload });
      this._toast(`${operation === 'add' ? 'Added' : 'Removed'} ${Number(amount).toLocaleString()} XP.`, 'success');
    } catch (error) {
      this._toast(error?.message || 'Could not run the experience command.', 'error');
    }
  }

  getSettingsPanel() {
    const root = document.createElement('div');
    root.style.cssText = 'padding:16px;display:flex;flex-direction:column;gap:16px;max-height:70vh;overflow:auto;';

    const heading = (text) => {
      const element = document.createElement('div');
      element.textContent = text;
      element.style.cssText = 'font-size:14px;font-weight:600;color:var(--header-primary);';
      return element;
    };

    const field = (label, key) => {
      const wrap = document.createElement('label');
      wrap.style.cssText = 'display:flex;flex-direction:column;gap:6px;color:var(--text-normal);font-size:12px;';
      const title = document.createElement('span');
      title.textContent = label;
      const input = document.createElement('input');
      input.type = 'text';
      input.value = this.settings[key];
      input.style.cssText = 'padding:8px;border:1px solid var(--background-modifier-accent);border-radius:4px;background:var(--background-tertiary);color:var(--text-normal);';
      input.addEventListener('change', () => {
        this.settings[key] = input.value.trim();
        this._saveSettings();
      });
      wrap.append(title, input);
      return wrap;
    };

    root.append(heading('Command names'), field('Add command localized name', 'addCommandName'), field('Remove command localized name', 'removeCommandName'));
    root.append(heading('Option names'), field('User option API name', 'userOptionName'), field('Experience option API name', 'amountOptionName'));

    const amountSection = document.createElement('section');
    amountSection.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
    amountSection.appendChild(heading('Experience amounts'));
    const amountList = document.createElement('div');
    amountList.style.cssText = 'display:flex;flex-direction:column;gap:6px;';

    const renderAmounts = () => {
      amountList.replaceChildren();
      this.settings.amounts.forEach((amount, index) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;color:var(--text-normal);';
        const value = document.createElement('span');
        value.textContent = `${amount.toLocaleString()} XP`;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = 'Remove';
        remove.addEventListener('click', () => {
          this.settings.amounts.splice(index, 1);
          this._saveSettings();
          renderAmounts();
        });
        row.append(value, remove);
        amountList.appendChild(row);
      });
    };

    const addRow = document.createElement('div');
    addRow.style.cssText = 'display:flex;gap:8px;';
    const amountInput = document.createElement('input');
    amountInput.type = 'number';
    amountInput.min = '1';
    amountInput.step = '1';
    amountInput.placeholder = 'Amount';
    amountInput.style.cssText = 'min-width:0;flex:1;padding:8px;border:1px solid var(--background-modifier-accent);border-radius:4px;background:var(--background-tertiary);color:var(--text-normal);';
    const addButton = document.createElement('button');
    addButton.type = 'button';
    addButton.textContent = 'Add amount';
    addButton.addEventListener('click', () => {
      const amount = Number(amountInput.value);
      if (!Number.isSafeInteger(amount) || amount < 1) return;
      if (!this.settings.amounts.includes(amount)) {
        this.settings.amounts.push(amount);
        this.settings.amounts.sort((left, right) => left - right);
        this._saveSettings();
        renderAmounts();
      }
      amountInput.value = '';
    });
    addRow.append(amountInput, addButton);
    amountSection.append(amountList, addRow);
    root.appendChild(amountSection);

    const note = document.createElement('div');
    note.textContent = 'Commands are sent through Discord internal APIs and may stop working after Discord updates.';
    note.style.cssText = 'font-size:12px;line-height:1.4;color:var(--text-muted);';
    root.appendChild(note);

    const updateButton = document.createElement('button');
    updateButton.type = 'button';
    updateButton.textContent = 'Check for updates';
    updateButton.addEventListener('click', () => this._checkForUpdates(true));
    root.appendChild(updateButton);

    renderAmounts();
    return root;
  }
};