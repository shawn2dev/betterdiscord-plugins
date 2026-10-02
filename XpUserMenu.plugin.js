/**
 * @name XpUserMenu
 * @author Shawny
 * @description Add configurable experience commands to the user context menu.
 * @version 1.0.19
 * @source https://github.com/shawn2dev/betterdiscord-plugins
 * @updateUrl https://raw.githubusercontent.com/shawn2dev/betterdiscord-plugins/refs/heads/main/XpUserMenu.plugin.js
 */

'use strict';

const UPDATE_REPO = 'shawn2dev/betterdiscord-plugins';
const UPDATE_BRANCH = 'main';
const UPDATE_FILENAME = 'XpUserMenu.plugin.js';
const UPDATE_INITIAL_DELAY_MS = 5000;
const UPDATE_INTERVAL_MS = 60 * 60 * 1000;
const USER_CONTEXT_MENU_TARGET = '*';

const DEFAULT_SETTINGS = {
  addCommandName: '경험치추가',
  removeCommandName: '경험치제거',
  userOptionName: '유저',
  amountOptionName: '경험치',
  debugLogging: true,
  amounts: [500, 1000, 2000, 3000, 5000],
};

module.exports = class XpUserMenu {
  constructor() {
    this.settings = { ...DEFAULT_SETTINGS };
    this._unpatchUserContext = null;
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
    return '1.0.19';
  }

  getDescription() {
    return 'Add configurable experience commands to the user context menu.';
  }

  start() {
    this._loadSettings();
    console.info('[XpUserMenu] Plugin started', {
      version: this.getVersion(),
      debugLogging: this.settings.debugLogging,
      amountCount: this.settings.amounts.length,
    });
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
        BdApi.ContextMenu.unpatch(USER_CONTEXT_MENU_TARGET, this._patchCallback);
      }
    } catch (_) {}
    this._unpatchUserContext = null;
    this._patchCallback = null;
  }

  _loadSettings() {
    try {
      const saved = typeof BdApi.Data?.load === 'function'
        ? BdApi.Data.load(this.getName(), 'settings')
        : BdApi.loadData(this.getName(), 'settings');
      this.settings = {
        ...DEFAULT_SETTINGS,
        ...(saved || {}),
        addCommandName:
          saved?.addCommandName === 'addxp'
            ? '경험치추가'
            : saved?.addCommandName || DEFAULT_SETTINGS.addCommandName,
        removeCommandName:
          saved?.removeCommandName === 'removexp'
            ? '경험치제거'
            : saved?.removeCommandName || DEFAULT_SETTINGS.removeCommandName,
        userOptionName:
          saved?.userOptionName === 'user'
            ? '유저'
            : saved?.userOptionName || DEFAULT_SETTINGS.userOptionName,
        amountOptionName:
          saved?.amountOptionName === 'exp'
            ? '경험치'
            : saved?.amountOptionName || DEFAULT_SETTINGS.amountOptionName,
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
      if (typeof BdApi.Data?.save === 'function') {
        BdApi.Data.save(this.getName(), 'settings', this.settings);
      } else if (typeof BdApi.saveData === 'function') {
        BdApi.saveData(this.getName(), 'settings', this.settings);
      } else {
        throw new Error('BetterDiscord data storage API is unavailable.');
      }
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

  _debugLog(event, details = {}) {
    if (!this.settings.debugLogging) return;
    console.info(`[XpUserMenu] ${event}`, details);
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
    if (!BdApi.ContextMenu?.patch || !BdApi.ContextMenu?.buildMenuChildren) {
      console.error('[XpUserMenu] BetterDiscord ContextMenu API is unavailable.');
      this._toast('BetterDiscord ContextMenu API is unavailable.', 'error');
      return;
    }

    this._patchCallback = (tree, props) => {
      try {
        const menu = this._findContextMenuNode(tree);
        const navId = menu?.navId || menu?.props?.navId || '';
        const userId =
          props?.user?.id ||
          props?.member?.user?.id ||
          props?.userId ||
          props?.targetUser?.id;
        this._debugLog('User context menu callback', {
          navId,
          propKeys: Object.keys(props || {}),
          hasUserId: Boolean(userId),
          amountCount: this.settings.amounts.length,
        });
        if (!/(?:^|-)(?:user|member|profile)(?:-|$)/i.test(navId)) return;
        if (!userId) {
          this._debugLog('Menu skipped: no user ID');
          return;
        }

        const menuChildren = this._getRootMenuChildren(menu || tree);
        if (!menuChildren) {
          console.warn('[XpUserMenu] Could not locate user context menu children.');
          return;
        }

        const actions = [
          this._buildXpSubmenu('경험치 추가', 'add', userId),
          this._buildXpSubmenu('경험치 제거', 'remove', userId),
        ];
        const items = actions.filter(Boolean);
        if (!items.length) {
          this._debugLog('Menu skipped: no configured XP amounts');
          return;
        }
        const group = BdApi.ContextMenu.buildMenuChildren([{ type: 'group', items }]);
        menuChildren.push(...(Array.isArray(group) ? group : [group]));
        this._debugLog('XP menu items added', { itemCount: items.length });
      } catch (error) {
        console.error('[XpUserMenu] User context menu patch failed:', error);
      }
    };

    try {
      this._unpatchUserContext = BdApi.ContextMenu.patch(USER_CONTEXT_MENU_TARGET, this._patchCallback);
      console.info('[XpUserMenu] User context menu patch registered', { target: USER_CONTEXT_MENU_TARGET });
    } catch (error) {
      console.error('[XpUserMenu] Could not register user context menu patch:', error);
      this._toast(`Could not add user menu: ${error?.message || error}`, 'error');
    }
  }

  _findContextMenuNode(tree, navId) {
    const pending = [tree];
    const visited = new WeakSet();

    while (pending.length) {
      const node = pending.pop();
      if (!node || typeof node !== 'object' || visited.has(node)) continue;
      visited.add(node);

      if (Array.isArray(node)) {
        pending.push(...node);
        continue;
      }

      const currentNavId = node.navId || node.props?.navId;
      if (currentNavId && (!navId || currentNavId === navId)) return node;

      const children = [node.children, node.props?.children];
      for (const child of children) {
        if (Array.isArray(child)) pending.push(...child);
        else if (child && typeof child === 'object') pending.push(child);
      }
    }
    return null;
  }

  _getRootMenuChildren(tree) {
    if (Array.isArray(tree)) return tree;
    for (const owner of [tree, tree?.props]) {
      if (!owner || typeof owner !== 'object' || !('children' in owner)) continue;
      if (Array.isArray(owner.children)) return owner.children;
      owner.children = owner.children == null ? [] : [owner.children];
      return owner.children;
    }
    return null;
  }

  _buildXpSubmenu(label, operation, userId) {
    if (!this.settings.amounts.length) return null;
    return {
      id: `xp-${operation}`,
      label,
      type: 'submenu',
      items: this.settings.amounts.map((amount) => ({
        id: `xp-${operation}-${amount}`,
        type: 'text',
        label: `${operation === 'add' ? '+' : '-'}${amount.toLocaleString()} XP`,
        action: () => this._runXpCommand(operation, userId, amount),
      })),
    };
  }

  async _runXpCommand(operation, userId, amount) {
    try {
      if (!/^\d+$/.test(String(userId))) throw new Error('The selected user ID is invalid.');
      if (!Number.isSafeInteger(Number(amount)) || Number(amount) < 1) {
        throw new Error('The selected experience amount is invalid.');
      }

      const commandName = operation === 'add'
        ? this.settings.addCommandName
        : this.settings.removeCommandName;
      const commandText = `/${commandName} ${this.settings.userOptionName}:<@${userId}> ${this.settings.amountOptionName}:${Number(amount)}`;

      if (globalThis.navigator?.clipboard?.writeText) {
        await globalThis.navigator.clipboard.writeText(commandText);
      } else {
        let clipboard;
        try {
          clipboard = this._nodeRequire('electron').clipboard;
        } catch (_) {}
        if (typeof clipboard?.writeText !== 'function') {
          throw new Error('Clipboard access is unavailable in this Discord client.');
        }
        clipboard.writeText(commandText);
      }

      this._debugLog('XP command copied to clipboard', { operation, commandName, amount });
      this._toast('명령어를 클립보드에 복사했어요.', 'success');
    } catch (error) {
      this._debugLog('XP command clipboard copy failed', { operation, error: error?.message || String(error) });
      this._toast(error?.message || 'Could not copy the command.', 'error');
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

    root.append(heading('Slash command names'), field('Add command name', 'addCommandName'), field('Remove command name', 'removeCommandName'));
    root.append(heading('Command option names'), field('User option name', 'userOptionName'), field('Experience option name', 'amountOptionName'));

    const debugRow = document.createElement('label');
    debugRow.style.cssText = 'display:flex;align-items:center;gap:8px;color:var(--text-normal);font-size:13px;';
    const debugToggle = document.createElement('input');
    debugToggle.type = 'checkbox';
    debugToggle.checked = this.settings.debugLogging;
    debugToggle.addEventListener('change', () => {
      this.settings.debugLogging = debugToggle.checked;
      this._saveSettings();
    });
    const debugLabel = document.createElement('span');
    debugLabel.textContent = 'Enable debug console logs';
    debugRow.append(debugToggle, debugLabel);
    root.appendChild(debugRow);

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
    note.textContent = 'Selecting an amount copies the slash command to the clipboard. Paste it into Discord, review, then send it manually.';
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