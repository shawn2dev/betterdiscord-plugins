/**
 * @name XpUserMenu
 * @author Shawny
 * @description Add configurable experience commands to the user context menu.
 * @version 1.0.7
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
  addCommandName: 'addxp',
  removeCommandName: 'removexp',
  userOptionName: 'user',
  amountOptionName: 'exp',
  debugLogging: true,
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
    return '1.0.7';
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
        addCommandName:
          saved?.addCommandName === '경험치추가'
            ? 'addxp'
            : saved?.addCommandName || DEFAULT_SETTINGS.addCommandName,
        removeCommandName:
          saved?.removeCommandName === '경험치제거'
            ? 'removexp'
            : saved?.removeCommandName || DEFAULT_SETTINGS.removeCommandName,
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

  _debugLog(event, details = {}) {
    if (!this.settings.debugLogging) return;
    console.debug(`[XpUserMenu] ${event}`, details);
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
      this._toast('BetterDiscord ContextMenu API is unavailable.', 'error');
      return;
    }

    this._patchCallback = (tree, props) => {
      const userId =
        props?.user?.id ||
        props?.member?.user?.id ||
        props?.userId ||
        props?.targetUser?.id;
      if (!userId) return;

      const menu = this._findContextMenuNode(tree, 'user-context');
      const menuChildren =
        (Array.isArray(menu?.children) && menu.children) ||
        (Array.isArray(menu?.props?.children) && menu.props.children) ||
        this._getRootMenuChildren(tree);
      if (!menuChildren) {
        console.warn('[XpUserMenu] Could not locate user context menu children.');
        return;
      }

      const actions = [
        this._buildXpSubmenu('경험치 추가', 'add', userId),
        this._buildXpSubmenu('경험치 제거', 'remove', userId),
      ];
      const items = actions.filter(Boolean);
      if (items.length) {
        menuChildren.push(BdApi.ContextMenu.buildMenuChildren([{ type: 'group', items }]));
      }
    };

    try {
      this._unpatchUserContext = BdApi.ContextMenu.patch('user-context', this._patchCallback);
    } catch (error) {
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

      if (node.navId === navId || node.props?.navId === navId) return node;

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
    if (Array.isArray(tree?.children)) return tree.children;
    if (Array.isArray(tree?.props?.children)) return tree.props.children;
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
      const filter = BdApi.Webpack.Filters?.byStrings;
      const module = filter
        ? BdApi.Webpack.getModule(filter('/interactions'), { searchExports: true })
        : null;
      const endpointModule = module?.default || module;
      if (typeof endpointModule?.post === 'function') this._http = endpointModule;
    }
    catch (_) {}
    if (!this._http) {
      try {
        const module = BdApi.Webpack.getByKeys('get', 'post', 'patch', 'put', 'delete');
        if (typeof module?.post === 'function') this._http = module;
      } catch (_) {}
    }
    return this._http;
  }

  async _fetchCommands(channelId, guildId) {
    const cacheKey = `${guildId || ''}:${channelId}`;
    const cached = this._commandCache.get(cacheKey);
    if (cached && Date.now() - cached.at < 30000) {
      this._debugLog('Command index cache hit', {
        channelId,
        guildId,
        commandCount: cached.commands.length,
      });
      return cached.commands;
    }

    const commands = [];
    const store = this._getCommandIndexStore();
    const channel = this._getChannel(channelId);
    this._debugLog('Fetching command index', {
      channelId,
      guildId,
      storeFound: !!store,
      channelFound: !!channel,
    });
    if (store) {
      const append = (source, list) => {
        const entries = Array.isArray(list) ? list : [];
        commands.push(...entries);
        this._debugLog('Command store source', { source, commandCount: entries.length });
      };

      try {
        append('guild state', this._extractCommandsFromIndexState(store.getGuildState?.(guildId)));
      } catch (error) {
        console.warn('[XpUserMenu] Guild command store lookup failed:', error);
      }
      try {
        if (channel) {
          append('channel context', this._extractCommandsFromIndexState(
            store.getContextState?.({ type: 'channel', channel }),
          ));
        }
      } catch (error) {
        console.warn('[XpUserMenu] Channel command store lookup failed:', error);
      }
      try {
        if (channel && typeof store.query === 'function') {
          const result = store.query(
            { type: 'channel', channel },
            { commandTypes: [1], applicationCommands: true },
            { allowFetch: true },
          );
          append('channel query', result?.commands);
          if (result?.loading) {
            await new Promise((resolve) => setTimeout(resolve, 1500));
            append('channel query retry', store.query(
              { type: 'channel', channel },
              { commandTypes: [1], applicationCommands: true },
              { allowFetch: true },
            )?.commands);
          }
        }
      } catch (error) {
        console.warn('[XpUserMenu] Command store query failed:', error);
      }
    }

    const http = this._getHttp();
    if (typeof http?.get === 'function') {
      const urls = [`/channels/${channelId}/application-command-index`];
      if (guildId) urls.push(`/guilds/${guildId}/application-command-index`);
      for (const url of urls) {
        try {
          const response = await http.get({ url });
          const entries = this._extractCommandsFromApiBody(response?.body ?? response?.data ?? response);
          commands.push(...entries);
          this._debugLog('Command API source', {
            url,
            status: response?.status ?? response?.statusCode ?? null,
            commandCount: entries.length,
          });
        } catch (error) {
          console.warn(`[XpUserMenu] Command index request failed (${url}):`, error);
        }
      }
    }

    const normalized = commands.map((command) => this._normalizeCommand(command)).filter(Boolean);
    const uniqueCommands = [...new Map(
      normalized.map((command) => [`${command.application_id}:${command.id}`, command]),
    ).values()];
    this._commandCache.set(cacheKey, { at: Date.now(), commands: uniqueCommands });
    this._debugLog('Command index resolved', {
      commandCount: uniqueCommands.length,
      commands: uniqueCommands.map((command) => ({
        name: command.name,
        localizedName: command.name_localized || null,
        id: command.id,
        applicationId: command.application_id,
      })),
    });
    if (!uniqueCommands.length) {
      console.warn('[XpUserMenu] No application commands found for current channel.', {
        channelId,
        guildId,
        storeFound: !!store,
        channelFound: !!channel,
      });
    }
    return uniqueCommands;
  }

  _getCommandIndexStore() {
    try {
      const store = BdApi.Webpack.getStore?.('ApplicationCommandIndexStore');
      if (store) return store;
    } catch (_) {}

    try {
      return BdApi.Webpack.getModule((module) =>
        module?.indices != null &&
        typeof module.query === 'function' &&
        typeof module.getGuildState === 'function',
      );
    } catch (_) {
      return null;
    }
  }

  _getChannel(channelId) {
    try {
      const store = BdApi.Webpack.getStore?.('ChannelStore') ||
        BdApi.Webpack.getModule((module) =>
          typeof module?.getChannel === 'function' && typeof module?.getChannelId === 'function',
        );
      return store?.getChannel?.(channelId) || null;
    } catch (_) {
      return null;
    }
  }

  _extractCommandsFromIndexState(state) {
    const sections = state?.result?.sections;
    if (!sections || typeof sections !== 'object') return [];
    return Object.values(sections).flatMap((section) => {
      const entries = section?.commands;
      if (!entries) return [];
      return Array.isArray(entries) ? entries : Object.values(entries);
    });
  }

  _extractCommandsFromApiBody(body) {
    if (!body || typeof body !== 'object') return [];
    const commands = [];
    const visited = new Set();
    const visit = (value) => {
      if (!value || typeof value !== 'object' || visited.has(value)) return;
      visited.add(value);
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (value.application_commands) visit(value.application_commands);
      if (value.sections && typeof value.sections === 'object') {
        Object.values(value.sections).forEach((section) => visit(section?.commands));
      }
      if (value.commands) visit(value.commands);
      if (value.id && (value.name || value.rootCommand?.name)) commands.push(value);
      Object.values(value).forEach((child) => {
        if (child && typeof child === 'object') visit(child);
      });
    };
    visit(body);
    return commands;
  }

  _normalizeCommand(command) {
    if (!command || typeof command !== 'object') return null;
    const root = command.rootCommand || command;
    const id = root.id || command.id;
    const name = command.name || command.untranslatedName || command.displayName || root.name;
    const applicationId =
      command.application_id ||
      command.applicationId ||
      command.application?.id ||
      root.application_id;
    if (!id || !name || !applicationId) return null;
    return {
      ...command,
      id: String(id),
      name: String(name),
      application_id: String(applicationId),
      version: command.version ?? command.version_id ?? root.version,
      options: root.options || command.options || [],
      type: root.type ?? command.type ?? 1,
    };
  }

  _getCommandNames(command) {
    const root = command.rootCommand || command;
    const names = [
      command.name,
      command.untranslatedName,
      command.displayName,
      command.name_localized,
      command.name_default,
      root.name,
    ];
    if (command.name_localizations && typeof command.name_localizations === 'object') {
      names.push(...Object.values(command.name_localizations));
    }
    return [...new Set(names.filter((name) => typeof name === 'string').map((name) => name.toLocaleLowerCase()))];
  }

  _matchesCommand(command, configuredName) {
    return this._getCommandNames(command).includes(configuredName.trim().toLocaleLowerCase());
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
      this._debugLog('XP command requested', {
        operation,
        configuredName,
        userId,
        amount,
        channelId: channel.channelId,
        guildId: channel.guildId,
      });
      const commands = await this._fetchCommands(channel.channelId, channel.guildId);
      const command = commands.find((candidate) => this._matchesCommand(candidate, configuredName));
      if (!command) {
        console.error('[XpUserMenu] Command not found.', {
          configuredName,
          channelId: channel.channelId,
          guildId: channel.guildId,
          availableCommands: commands.map((candidate) => ({
            name: candidate.name,
            localizedName: candidate.name_localized,
            applicationId: candidate.application_id,
            id: candidate.id,
          })),
        });
        throw new Error(`Command not found: ${configuredName}. Check the configured API command name in plugin settings.`);
      }
      this._debugLog('XP command matched', {
        configuredName,
        commandName: command.name,
        commandId: command.id,
        applicationId: command.application_id,
        optionNames: (command.options || []).map((option) => option.name),
      });

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
      if (typeof http?.post !== 'function') throw new Error('Discord HTTP post module is unavailable.');
      this._debugLog('Sending interaction', {
        endpoint: '/interactions',
        commandName: command.name,
        commandId: command.id,
        applicationId: command.application_id,
        channelId: channel.channelId,
        guildId: channel.guildId,
        options: payload.data.options,
      });
      const response = await http.post('/interactions', payload);
      this._debugLog('Interaction response received', {
        status: response?.status ?? response?.statusCode ?? null,
        ok: response?.ok ?? null,
        responseType: response == null ? 'empty' : typeof response,
        bodyType: typeof (response?.body ?? response?.data ?? response?.content),
      });
      if (response?.ok === false || (response?.status >= 400)) {
        throw new Error(`Discord rejected the interaction request (HTTP ${response.status}).`);
      }
      const responseBody = response?.body ?? response?.data ?? response?.content;
      const responseText = typeof response?.text === 'function'
        ? await response.text()
        : typeof responseBody === 'string'
          ? responseBody
          : '';
      if (/You need to enable JavaScript to run this app/i.test(responseText)) {
        throw new Error('Discord returned an HTML page instead of accepting the interaction.');
      }
      this._toast(`${operation === 'add' ? 'Added' : 'Removed'} ${Number(amount).toLocaleString()} XP.`, 'success');
    } catch (error) {
      this._debugLog('XP command failed', {
        operation,
        userId,
        amount,
        error: error?.message || String(error),
      });
      console.error('[XpUserMenu] Experience command failed.', {
        operation,
        userId,
        amount,
        error,
      });
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

    root.append(heading('Command API names'), field('Add command API name', 'addCommandName'), field('Remove command API name', 'removeCommandName'));
    root.append(heading('Option names'), field('User option API name', 'userOptionName'), field('Experience option API name', 'amountOptionName'));

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