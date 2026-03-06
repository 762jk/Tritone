// MASTER LOG CONTROL: Set To false For Production, true For Development (Enables Console Logs Throughout The App)
const DEBUG_MODE = false; // Dev Tools Console

if (!DEBUG_MODE) {
    console.log = () => { };
    console.warn = () => { };
    // console.error Is Left Intact To Allow Error Reporting Even In Production, But You Can Comment It Out If You Want A Silent Console
}

const { ipcRenderer, shell } = require('electron');
const CryptoJS = require('crypto-js');
const colorThief = new ColorThief();

let config = null;
let viewQueue = [], playbackQueue = [];
let originalQueue = [];
let playbackHistory = [];
let albumIndex = [];
let currentIndex = 0, currentlyPlayingTrack = null, lyricsOpen = false, currentSyncedLyrics = [];
let isShuffle = false, isRepeat = false;
let queueOpen = false;
let hasScrobbled = false;
let recentlyPlayedTimeout;
const audio = new Audio();
let rpcEnabled;
let notificationsEnabled;
let closeToTrayEnabled;
let maxBitrate = localStorage.getItem('tritone_bitrate') || '0'; // '0' = Original, '1' = 320kbps, '2' = 256kbps, '3' = 128kbps
let currentLibraryOffset = 0;
let isLibraryFetching = false;
let allLibraryLoaded = false;
let currentSortType = 'alphabeticalByName'; // Default Sort Type (Album Name A-Z)
const libraryPageSize = 500; // Number Of Items To Fetch Per Request When Scrolling The Library

const artistPlaceholder = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%23ffffff" opacity="0.1"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>';
const playlistPlaceholder = 'assets/images/logo.svg';

async function toggleStar() {
    if (!currentlyPlayingTrack) return;
    const isStarred = currentlyPlayingTrack.starred !== undefined;
    const endpoint = isStarred ? 'unstar' : 'star';
    const starBtn = document.getElementById('starBtn');

    try {
        await fetch(`${config.url}/rest/${endpoint}?id=${currentlyPlayingTrack.id}&${getAuth()}`);

        if (isStarred) {
            delete currentlyPlayingTrack.starred;
            starBtn.innerText = '🤍';
            showToast("🗑️ Removed From Favorites");
        } else {
            currentlyPlayingTrack.starred = new Date().toISOString();
            starBtn.innerText = '❤️';
            showToast("✅ Added To Favorites");
            console.log("Track starred, refreshing playlists to reflect change...");
        }

        loadPlaylists();

        const viewTitle = document.getElementById('view-album-title');
        const titleText = viewTitle ? viewTitle.innerText.toLowerCase().trim() : "";

        if (titleText.includes("favour") || titleText.includes("star")) {
            const favSidebarItem = Array.from(document.querySelectorAll('.sidebar-item, .playlist-item'))
                .find(el => el.innerText.toLowerCase().includes('favour'));

            if (favSidebarItem) {
                console.log("Found sidebar item, triggering click for instant refresh...");
                favSidebarItem.click();
            } else {
                console.warn("Could not find Favorites sidebar item for refresh.");
            }
        }
    } catch (e) {
        console.error("Star toggle failed:", e);
    }
}

function setFadeImage(imgElement, src) {
    if (imgElement.src !== src) {
        imgElement.style.opacity = '0';
        imgElement.onload = () => { imgElement.style.opacity = '1'; };
        imgElement.src = src;
    }
}

function sanitizeFilename(name) {
    return name.replace(/[\\/:*?"<>|]/g, '');
}

function applyScroll(el) {
    setTimeout(() => {
        const inner = el.querySelector('.scroll-inner');
        if (inner && inner.scrollWidth > el.clientWidth) {
            const dist = inner.scrollWidth - el.clientWidth + 50;
            inner.style.setProperty('--scroll-dist', `-${dist}px`);
            inner.classList.add('do-scroll');
        } else if (inner) {
            inner.classList.remove('do-scroll');
            inner.style.setProperty('--scroll-dist', `0px`);
        }
    }, 200);
}

let historyStack = [];
let isBackNavigation = false;

function updateBreadcrumbs() {
    const btn = document.getElementById('back-btn');
    const crumb = document.getElementById('breadcrumb');
    const sidebar = document.getElementById('sidebar');
    const isCollapsed = sidebar ? sidebar.classList.contains('collapsed') : false;
    if (historyStack.length <= 1) {
        if (btn) btn.style.display = 'none';
        if (crumb) crumb.innerText = '';
    } else {
        if (btn) btn.style.display = isCollapsed ? 'none' : 'flex';
        if (crumb) crumb.innerText = '';
    }
}

function pushHistory(state, isRoot = false) {
    if (isBackNavigation) {
        isBackNavigation = false;
    } else {
        if (isRoot) {
            historyStack = [state];
        } else {
            const last = historyStack[historyStack.length - 1];
            if (last && last.view === 'search' && state.view === 'search') {
                historyStack[historyStack.length - 1] = state;
            } else if (!last || last.view !== state.view || last.param !== state.param) {
                historyStack.push(state);
            }
        }
    }
    updateBreadcrumbs();
}

window.goBack = function () {
    if (historyStack.length > 1) {
        historyStack.pop();
        const prev = historyStack[historyStack.length - 1];
        isBackNavigation = true;
        if (prev.view === 'grid') showGridView();
        else if (prev.view === 'artist') searchArtist(prev.param);
        else if (prev.view === 'album') loadAlbumTracks(prev.param);
        else if (prev.view === 'playlist') loadPlaylistTracks(prev.param, prev.title);
        else if (prev.view === 'starred') loadStarredTracks();
        else if (prev.view === 'settings') showSettings();
        else if (prev.view === 'search') {
            document.getElementById('library-search').value = prev.param;
            executeSearch(prev.param);
        }
    }
};

function hideAllViews() {
    document.getElementById('empty-state').style.display = 'none';
    document.getElementById('album-view').style.display = 'none';
    document.getElementById('artist-view').style.display = 'none';
    document.getElementById('library-grid-view').style.display = 'none';
    if (document.getElementById('settings-view')) document.getElementById('settings-view').style.display = 'none';
    if (document.getElementById('search-view')) document.getElementById('search-view').style.display = 'none';

    const lyricsLayer = document.getElementById('lyrics-view');
    const closeBtn = document.getElementById('pinnedCloseBtn');

    if (lyricsOpen) {
        lyricsOpen = false; // Reset the global state
        if (lyricsLayer) lyricsLayer.style.display = 'none';
        if (closeBtn) closeBtn.style.display = 'none';

        const floatingNav = document.getElementById('sidebar-nav-floating');
        if (document.getElementById('sidebar').classList.contains('collapsed') && floatingNav) {
            floatingNav.style.display = 'flex';
        }
    }
}

function showToast(message) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerText = message;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.animation = 'fadeOut 0.3s ease forwards';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

async function initApp() {
    const encrypted = localStorage.getItem('server_config');

    // 1. Decrypt and load config
    if (encrypted) {
        try {
            const decrypted = await ipcRenderer.invoke('decrypt-data', encrypted);
            if (decrypted) {
                config = JSON.parse(decrypted);
            }
        } catch (e) {
            console.error("Secure decryption failed:", e);
        }
    }

    // 2. Set Default Sort Logic
    currentSortType = 'alphabeticalByName';

    // 3. Sync HTML Select UI (The Dropdown)
    const sortDropdown = document.getElementById('library-sort');
    if (sortDropdown) {
        sortDropdown.value = "alphabeticalByName";
    }

    // 4. Volume Persistence
    const savedVolValue = localStorage.getItem('tritone_vol');
    if (savedVolValue !== null) {
        audio.volume = parseFloat(savedVolValue);
        const volSlider = document.getElementById('volume-slider');
        if (volSlider) volSlider.value = savedVolValue;
    }

    // 5. Auth Check & Single Load
    if (!config || !config.url) {
        showSetup();
    } else {
        const setupOverlay = document.getElementById('setup-overlay');
        if (setupOverlay) setupOverlay.style.display = 'none';

        loadLibrary(true); // Loads A-Z
        loadPlaylists();   // Loads your sidebar
    }
}

// Ensure this is ONLY called once
window.onload = initApp;

function logout() {
    if (confirm("Are You Sure You Want To Logout?")) {
        localStorage.clear(); // Clear Everything (Including Saved Settings) On Logout For Maximum Security
        config = null;
        audio.pause();
        audio.src = "";
        currentlyPlayingTrack = null;
        hideAllViews();
        document.getElementById('empty-state').style.display = 'flex';
        document.getElementById('album-list').innerHTML = '';
        showSetup();
    }
}

function showSetup() {
    const overlay = document.getElementById('setup-overlay');
    const urlInput = document.getElementById('setup-url');
    overlay.style.display = 'flex';
    urlInput.value = "";
    document.getElementById('setup-user').value = "";
    document.getElementById('setup-pass').value = "";
    ipcRenderer.send('force-focus');
    setTimeout(() => { urlInput.focus(); }, 150);
}

async function saveConnection() {
    const urlInput = document.getElementById('setup-url').value.trim();
    const user = document.getElementById('setup-user').value.trim();
    const pass = document.getElementById('setup-pass').value.trim();
    const errorMsg = document.getElementById('setup-error');

    // 1. Validation
    if (!urlInput || !user) {
        errorMsg.innerText = "URL And Username Are Required";
        errorMsg.style.display = 'block';
        return;
    }

    // 2. Format URL (remove trailing slash)
    const url = urlInput.endsWith('/') ? urlInput.slice(0, -1) : urlInput;

    // Temporarily update global config for the ping test
    config = { url, user, pass };

    try {
        // 3. Attempt to Ping the server
        const res = await fetch(`${config.url}/rest/ping?${getAuth()}&f=json`);
        const data = await res.json();
        const subRes = data['subsonic-response'];

        if (subRes && subRes.status === 'ok') {
            // 4. --- Save Server Metadata (For the Settings Display) ---
            localStorage.setItem('tritone_server_api', subRes.version || '?');
            localStorage.setItem('tritone_server_type', subRes.type || '?');
            localStorage.setItem('tritone_server_version', subRes.serverVersion || '?');

            // Check for OpenSubsonic support
            const isOpen = subRes.openSubsonic === true;
            localStorage.setItem('tritone_is_opensubsonic', isOpen ? 'true' : 'false');

            // 5. Encrypt and save the actual login config
            const encrypted = await ipcRenderer.invoke('encrypt-data', JSON.stringify(config));
            localStorage.setItem('server_config', encrypted);

            // 6. UI Transition
            document.getElementById('setup-overlay').style.display = 'none';

            // 7. Initialize App
            loadLibrary();
            loadPlaylists();

            // Refresh the settings display if it's already open in the background
            if (typeof syncSettingsUI === 'function') syncSettingsUI();

            showToast("✅ Connected to Server!");
        } else {
            // Server responded but said "failed" (likely bad password)
            const reason = subRes?.error?.message || "Invalid Credentials";
            throw new Error(reason);
        }
    } catch (e) {
        // 8. Error Handling
        console.error("Connection Error:", e);
        errorMsg.innerText = `Connection Failed: ${e.message || "Please Check Your Details"}\nExpected Format: http://ip:port`;
        errorMsg.style.display = 'block';
    }
}

function getAuth() {
    if (!config) return "";
    const salt = Math.random().toString(36).substring(2);
    const token = CryptoJS.MD5(config.pass + salt).toString();
    return `u=${config.user}&t=${token}&s=${salt}&v=1.16.1&c=Tritone&f=json`;
}

window.downloadTrack = function (id, title, artist, suffix) {
    const ext = suffix || 'mp3';
    const cleanArtist = sanitizeFilename(artist || 'Unknown');
    const cleanTitle = sanitizeFilename(title || 'Track');
    const url = `${config.url}/rest/download?id=${id}&${getAuth()}`;
    ipcRenderer.send('download-track', { url, filename: `${cleanArtist} - ${cleanTitle}.${ext}` });
    showToast(`📩 Downloading: ${title}...`);
}

window.showSettings = async function () {
    const settingsView = document.getElementById('settings-view');
    const lyricsLayer = document.getElementById('lyrics-view');
    const closeBtn = document.getElementById('pinnedCloseBtn');

    if (settingsView.style.display === 'block') {
        showGridView();
        return;
    }

    if (lyricsOpen) {
        lyricsOpen = false;
        if (lyricsLayer) lyricsLayer.style.display = 'none';
        if (closeBtn) closeBtn.style.display = 'none';
        const floatingNav = document.getElementById('sidebar-nav-floating');
        if (document.getElementById('sidebar').classList.contains('collapsed') && floatingNav) {
            floatingNav.style.display = 'flex';
        }
    }

    hideAllViews();
    settingsView.style.display = 'block';
    pushHistory({ view: 'settings', title: 'Settings' }, false);

    document.getElementById('bitrate-select').value = maxBitrate;

    const notifBtn = document.getElementById('notif-toggle-btn');
    if (notifBtn) {
        notifBtn.innerText = notificationsEnabled ? 'Disable Notifications' : 'Enable Notifications';
        notifBtn.style.background = notificationsEnabled ? 'var(--accent)' : 'rgba(255, 255, 255, 0.1)';
        notifBtn.style.color = notificationsEnabled ? 'black' : 'white';
        notifBtn.style.border = notificationsEnabled ? 'none' : '1px solid rgba(255,255,255,0.2)';
    }

    const versionDisplay = document.getElementById('version-display');
    if (versionDisplay) {
        try {
            const appVersion = await ipcRenderer.invoke('get-app-version');

            // Pull the server-specific info we saved during login
            const apiVer = localStorage.getItem('tritone_server_api') || 'Unknown';
            const serverType = localStorage.getItem('tritone_server_type') || 'Unknown';
            const serverVer = localStorage.getItem('tritone_server_version') || '';
            const isOpenSubsonic = localStorage.getItem('tritone_is_opensubsonic') || '';

            // Build a detailed string
            let serverDetail = `${serverType} ${serverVer}`.trim();
            if (isOpenSubsonic) serverDetail += ' (OpenSubsonic)';

            versionDisplay.innerHTML = `
            <strong>Tritone V${appVersion}</strong><br>
            Made with ❤️ By <a href="https://github.com/Kyle8973/Tritone" target="_blank" style="color: inherit; text-decoration: underline;">Kyle8973</a><br>
                        <span style="font-size: 0.85em; opacity: 0.8;">
                Server: ${serverDetail}<br>
                API Protocol: ${apiVer}
            </span>
        `;
        } catch (e) {
            versionDisplay.innerHTML = `Tritone<br>Made with ❤️ By Kyle8973`;
        }
    }
}

window.clearCache = function () {
    if (!confirm("This Will Clear All Cached Data (Including Recently Played Tracks). Are You Sure?")) return;
    const keys = Object.keys(localStorage);
    keys.forEach(key => {
        if (key.startsWith('bio_') || key === 'recently_played') {
            localStorage.removeItem(key);
        }
    });
    showToast("🗑️ Cache Cleared!");
}

// Bitrate Setting Logic
window.syncAudioUI = function () {
    const bitrateSelect = document.getElementById('bitrate-select');
    if (bitrateSelect) bitrateSelect.value = maxBitrate;
};
window.addEventListener('DOMContentLoaded', window.syncAudioUI);

// The Manual Save Function
window.saveBitrate = function () {
    const selectedBitrate = document.getElementById('bitrate-select').value;

    // Update live variable
    maxBitrate = selectedBitrate;

    // Save to storage
    localStorage.setItem('tritone_bitrate', maxBitrate);

    showToast("💾 Bitrate Saved! Will Apply To The Next Track");
}

// --- UI Performance Settings ---
// Load initial values from localStorage or use defaults
let maxDomItems = parseInt(localStorage.getItem('tritone_max_dom')) || 1500;
let pruneAmount = parseInt(localStorage.getItem('tritone_prune')) || 500;
let imgResolution = localStorage.getItem('tritone_img_res') || "0";

// NEW: Function to sync the HTML dropdowns with your saved data
window.syncPerformanceUI = function () {
    const maxDomSelect = document.getElementById('max-dom-select');
    const pruneSelect = document.getElementById('prune-select');
    const imgResSelect = document.getElementById('img-res-select');

    if (maxDomSelect) maxDomSelect.value = maxDomItems.toString();
    if (pruneSelect) pruneSelect.value = pruneAmount.toString();
    if (imgResSelect) imgResSelect.value = imgResolution;
};

// Run the sync when the window loads
window.addEventListener('DOMContentLoaded', window.syncPerformanceUI);

window.savePerformanceSettings = function () {
    // 1. Update global variables from the UI
    maxDomItems = parseInt(document.getElementById('max-dom-select').value);
    pruneAmount = parseInt(document.getElementById('prune-select').value);
    imgResolution = document.getElementById('img-res-select').value;

    // 2. Persist to localStorage
    localStorage.setItem('tritone_max_dom', maxDomItems);
    localStorage.setItem('tritone_prune', pruneAmount);
    localStorage.setItem('tritone_img_res', imgResolution);

    // 3. APPLY INSTANTLY
    if (typeof window.resetToHome === "function") {
        window.resetToHome();
        showToast("💾 Performance Settings Applied");
    } else {
        showToast("💾 Performance Settings Saved! (Home Or Restart To Apply)");
    }
}

window.syncSettingsUI = function () {
    rpcEnabled = localStorage.getItem('tritone_rpc_enabled') === 'true';
    notificationsEnabled = localStorage.getItem('tritone_notif_enabled') === 'true';
    closeToTrayEnabled = localStorage.getItem('tritone_close_tray') === 'true';

    // 2. Sync RPC Button
    const rpcBtn = document.getElementById('rpc-toggle-btn');
    if (rpcBtn) {
        updateButtonStyle(rpcBtn, rpcEnabled, 'RPC');

        if (typeof window.hasInitialSync === 'undefined') {
            ipcRenderer.send('set-rpc-enabled', rpcEnabled);
            window.hasInitialSync = true;
        }
    }

    // Sync Notifications Button
    const notifBtn = document.getElementById('notif-toggle-btn');
    if (notifBtn) {
        updateButtonStyle(notifBtn, notificationsEnabled, 'Notifications');
    }

    if (localStorage.getItem('server_config') && localStorage.getItem('tritone_server_type') === null) {
        const refreshMetadata = async () => {
            if (!config || !config.url) {
                const encrypted = localStorage.getItem('server_config');
                if (encrypted) {
                    try {
                        const decrypted = await ipcRenderer.invoke('decrypt-data', encrypted);
                        config = JSON.parse(decrypted);
                    } catch (e) { return; }
                }
            }

            try {
                const res = await fetch(`${config.url}/rest/ping?${getAuth()}&f=json`);
                const data = await res.json();
                const subRes = data['subsonic-response'];

                if (subRes && subRes.status === 'ok') {
                    localStorage.setItem('tritone_server_api', subRes.version || '1.16.1');
                    localStorage.setItem('tritone_server_type', subRes.type || 'Subsonic');
                    localStorage.setItem('tritone_server_version', subRes.serverVersion || '');
                    localStorage.setItem('tritone_is_opensubsonic', subRes.openSubsonic === true ? 'true' : 'false');

                    const typeLabel = document.getElementById('server-type-label');
                    if (typeLabel) typeLabel.innerText = subRes.type || 'Subsonic';
                }
            } catch (e) { }
        };
        refreshMetadata();
    }
}

function updateButtonStyle(btn, isEnabled, label) {
    btn.innerText = isEnabled ? `Disable ${label}` : `Enable ${label}`;
    if (isEnabled) {
        btn.style.background = 'var(--accent)';
        const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent');
        const rgb = accent.match(/\d+/g);
        if (rgb) {
            const brightness = ((rgb[0] * 299) + (rgb[1] * 587) + (rgb[2] * 114)) / 1000;
            const isLight = brightness > 150;
            btn.style.color = isLight ? 'black' : 'white';
            btn.style.fontWeight = isLight ? '900' : '600';
            btn.style.letterSpacing = isLight ? '0.5px' : 'normal';
            btn.style.textShadow = !isLight ? '0 1px 3px rgba(0,0,0,0.6)' : 'none';
        }
    } else {
        btn.style.background = 'rgba(255, 255, 255, 0.1)';
        btn.style.color = 'white';
        btn.style.fontWeight = '600';
        btn.style.textShadow = 'none';
    }
}

let rpcCooldown = 0; // Tracks the remaining seconds

window.toggleRPCSetting = function () {
    // 1. Cooldown Check
    if (rpcCooldown > 0) {
        showToast(`⚠️ Please Wait ${rpcCooldown}s Before Toggling RPC Again \n Spamming This Button Can Cause Rate Limits Or Issues With  RPC`);
        return;
    }

    // 2. Update state and save
    rpcEnabled = !rpcEnabled;
    localStorage.setItem('tritone_rpc_enabled', rpcEnabled.toString());

    // 3. Update Button UI
    const rpcBtn = document.getElementById('rpc-toggle-btn');
    if (rpcBtn) {
        rpcBtn.innerText = rpcEnabled ? 'Disable RPC' : 'Enable RPC';
        rpcBtn.style.background = rpcEnabled ? 'var(--accent)' : 'rgba(255, 255, 255, 0.1)';
        rpcBtn.style.color = rpcEnabled ? 'black' : 'white';
        rpcBtn.style.border = rpcEnabled ? 'none' : '1px solid rgba(255,255,255,0.2)';
    }

    ipcRenderer.send('set-rpc-enabled', rpcEnabled);

    if (!rpcEnabled) {
        showToast("❌ RPC Disabled");
    } else {
        // Small delay to let the connection handshake finish
        setTimeout(() => {
            sendRPCUpdate();
        }, 1500);
        showToast("✔️ RPC Enabled");
    }

    // 5. Cooldown timer
    rpcCooldown = 5;
    const cooldownTimer = setInterval(() => {
        rpcCooldown--;
        if (rpcCooldown <= 0) {
            clearInterval(cooldownTimer);
        }
    }, 1000);
}

window.toggleNotifSetting = function () {
    notificationsEnabled = !notificationsEnabled;
    localStorage.setItem('tritone_notif_enabled', notificationsEnabled);

    ipcRenderer.send('set-notifications-enabled', notificationsEnabled);
    updateButtonStyle(document.getElementById('notif-toggle-btn'), notificationsEnabled, 'Notifications');

    showToast(notificationsEnabled ? "✅ Notifications Enabled" : "❌ Notifications Disabled");
}

// 3. Run on Startup
document.addEventListener('DOMContentLoaded', window.syncSettingsUI);

window.toggleCloseToTray = function () {
    closeToTrayEnabled = !closeToTrayEnabled;
    localStorage.setItem('tritone_close_tray', closeToTrayEnabled);
    const trayBtn = document.getElementById('close-tray-btn');
    if (trayBtn) {
        trayBtn.innerText = closeToTrayEnabled ? 'Disable Close To Tray' : 'Enable Close To Tray';
        trayBtn.style.background = closeToTrayEnabled ? 'var(--accent)' : 'rgba(255, 255, 255, 0.1)';
        trayBtn.style.color = closeToTrayEnabled ? 'black' : 'white';
        trayBtn.style.border = closeToTrayEnabled ? 'none' : '1px solid rgba(255,255,255,0.2)';
    }
    ipcRenderer.send('update-close-behavior', closeToTrayEnabled);
    showToast(closeToTrayEnabled ? "✅ Close To Tray Enabled" : "❌ Close To Tray Disabled");
}

let rpcUpdateTimeout;

function sendRPCUpdate() {
    if (!rpcEnabled) {
        ipcRenderer.send('update-rpc', { clear: true });
        return;
    }

    if (!currentlyPlayingTrack) return;
    clearTimeout(rpcUpdateTimeout);
    rpcUpdateTimeout = setTimeout(() => {
        const dur = (audio.duration && audio.duration !== Infinity && !isNaN(audio.duration)) ? audio.duration : (currentlyPlayingTrack.duration || 0);
        ipcRenderer.send('update-rpc', {
            title: currentlyPlayingTrack.title || 'Unknown',
            artist: currentlyPlayingTrack.artist || 'Unknown',
            album: currentlyPlayingTrack.album || 'Unknown Album',
            duration: dur,
            currentTime: audio.currentTime || 0,
            isPaused: audio.paused
        });
    }, 500);
}

function seekAudio(seconds) {
    if (!audio.paused || audio.currentTime > 0) {
        const dur = (audio.duration && audio.duration !== Infinity && !isNaN(audio.duration)) ? audio.duration : (currentlyPlayingTrack ? currentlyPlayingTrack.duration : 0);
        audio.currentTime = Math.max(0, Math.min(dur, audio.currentTime + seconds));
        sendRPCUpdate();
    }
}

window.createNewPlaylist = function () {
    document.getElementById('new-playlist-name').value = '';
    document.getElementById('create-playlist-modal').style.display = 'flex';
    setTimeout(() => document.getElementById('new-playlist-name').focus(), 100);
}

window.closeCreatePlaylistModal = function () {
    document.getElementById('create-playlist-modal').style.display = 'none';
}

window.submitNewPlaylist = async function () {
    const name = document.getElementById('new-playlist-name').value.trim();
    if (name) {
        try {
            await fetch(`${config.url}/rest/createPlaylist?name=${encodeURIComponent(name)}&${getAuth()}`);
            showToast("📃 Playlist Created!");
            closeCreatePlaylistModal();
            loadPlaylists();
        } catch (e) { showToast("❌ Failed To Create Playlist"); }
    }
}

window.deletePlaylist = async function (id, name) {
    if (confirm(`Are You Sure You Want To Permanently Delete The Playlist "${name}"?`)) {
        try {
            await fetch(`${config.url}/rest/deletePlaylist?id=${id}&${getAuth()}`);
            showToast(`🗑️ Deleted ${name}`);
            loadPlaylists();
            showGridView();
        } catch (e) { console.error(e); showToast("❌ Failed To Delete Playlist"); }
    }
}

let trackToAddToPlaylist = null;
window.openPlaylistModal = function (trackId) {
    trackToAddToPlaylist = trackId;
    const modalList = document.getElementById('playlist-modal-list');
    modalList.innerHTML = '<p>Loading...</p>';
    document.getElementById('playlist-modal').style.display = 'flex';
    fetch(`${config.url}/rest/getPlaylists?${getAuth()}`)
        .then(res => res.json())
        .then(data => {
            const playlists = data['subsonic-response'].playlists.playlist || [];
            modalList.innerHTML = '';
            playlists.forEach(pl => {
                const btn = document.createElement('div');
                btn.style.cssText = "padding: 10px; background: rgba(255,255,255,0.05); margin-bottom: 5px; border-radius: 5px; cursor: pointer;";
                btn.innerText = pl.name;
                btn.onclick = () => addToPlaylist(pl.id, trackToAddToPlaylist);
                modalList.appendChild(btn);
            });
        }).catch(e => modalList.innerHTML = '<p>Error loading playlists</p>');
}

window.closePlaylistModal = function () {
    document.getElementById('playlist-modal').style.display = 'none';
    trackToAddToPlaylist = null;
}

async function addToPlaylist(playlistId, songId) {
    try {
        const checkRes = await fetch(`${config.url}/rest/getPlaylist?id=${playlistId}&${getAuth()}`);
        const checkData = await checkRes.json();
        const currentEntries = checkData['subsonic-response'].playlist.entry || [];
        const isDuplicate = currentEntries.some(track => track.id === songId);
        if (isDuplicate) {
            showToast("❌ Track Is Already In This Playlist");
            closePlaylistModal();
            return;
        }
        await fetch(`${config.url}/rest/updatePlaylist?playlistId=${playlistId}&songIdToAdd=${songId}&${getAuth()}`);
        showToast("✅ Added To Playlist!");
        closePlaylistModal();
        loadPlaylists();
    } catch (e) { showToast("❌ Failed To Add To Playlist"); }
}

window.removeFromPlaylist = async function (playlistId, songIndex, playlistName) {
    if (confirm("Are You Sure You Want To Remove This Track From The Playlist?")) {
        try {
            await fetch(`${config.url}/rest/updatePlaylist?playlistId=${playlistId}&songIndexToRemove=${songIndex}&${getAuth()}`);
            showToast("🗑️ Removed From Playlist");
            loadPlaylistTracks(playlistId, playlistName);
            loadPlaylists();
        } catch (e) { showToast("❌ Failed To Remove From Playlist"); }
    }
}

function handleGlobalSearch(e) {
    const query = e.target.value.trim();
    if (e.target.id === 'library-search') {
        const gs = document.getElementById('grid-search');
        if (gs) gs.value = e.target.value;
    } else if (e.target.id === 'grid-search') {
        const ls = document.getElementById('library-search');
        if (ls) ls.value = e.target.value;
    }
    if (query.length < 2) {
        if (query.length === 0) loadLibrary();
        return;
    }
    executeSearch(query);
}

async function executeSearch(query) {
    try {
        // --- FIX: Force lyrics to close when a new search starts ---
        const lyricsOverlay = document.getElementById('lyrics-overlay');
        if (lyricsOverlay) {
            lyricsOverlay.classList.remove('active');
            lyricsOverlay.style.display = 'none'; // Double-guard to ensure it's hidden
        }

        const res = await fetch(`${config.url}/rest/search3?query=${encodeURIComponent(query)}&artistCount=20&albumCount=50&songCount=200&${getAuth()}&f=json`);
        const data = await res.json();
        const results = data['subsonic-response'].searchResult3 || {};

        hideAllViews();
        document.getElementById('search-view').style.display = 'block';
        pushHistory({ view: 'search', param: query, title: `Search Results` }, false);

        // --- 1. Playlist Filtering ---
        const playlistList = document.getElementById('playlist-list');
        const playlists = Array.from(playlistList.querySelectorAll('.playlist-item'));
        const searchResultsView = document.getElementById('search-view');
        let playlistResultsGrid = document.getElementById('search-playlists-grid');

        if (!playlistResultsGrid) {
            const title = document.createElement('h2');
            title.id = 'search-playlists-title';
            title.style.color = 'white';
            title.innerText = 'Playlists';
            playlistResultsGrid = document.createElement('div');
            playlistResultsGrid.id = 'search-playlists-grid';
            playlistResultsGrid.className = 'alphabetical-grid';
            playlistResultsGrid.style.marginBottom = '40px';
            searchResultsView.appendChild(title);
            searchResultsView.appendChild(playlistResultsGrid);
        }

        playlistResultsGrid.innerHTML = '';
        const matchingPlaylists = playlists.filter(pl => pl.innerText.toLowerCase().includes(query.toLowerCase()));
        if (matchingPlaylists.length > 0) {
            document.getElementById('search-playlists-title').style.display = 'block';
            matchingPlaylists.forEach(pl => {
                const clone = pl.cloneNode(true);
                clone.onclick = pl.onclick;
                playlistResultsGrid.appendChild(clone);
            });
        } else {
            document.getElementById('search-playlists-title').style.display = 'none';
        }

        // --- 2. Top Artist Result ---
        const topResultContainer = document.getElementById('search-top-result');
        if (results.artist && results.artist.length > 0) {
            const topArtist = results.artist[0];
            const localArtUrl = `${config.url}/rest/getCoverArt?id=${topArtist.id}&${getAuth()}`;
            topResultContainer.innerHTML = `
                <div class="top-result-card" onclick="searchArtist('${topArtist.name.replace(/'/g, "\\'")}')">
                    <img id="search-top-artist-img" src="${localArtUrl}" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22%23ffffff%22 opacity=%220.1%22><path d=%22M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z%22/></svg>'" style="width: 100px; height: 100px; border-radius: 50%; object-fit: cover; background: rgba(255,255,255,0.05);">
                    <div><h2 style="margin:0;">${topArtist.name}</h2><p style="opacity:0.6; margin:5px 0 0 0;">Artist</p></div>
                </div>`;

            const cacheKey = `bio_${topArtist.name.toLowerCase()}`;
            const cachedStr = localStorage.getItem(cacheKey);
            if (cachedStr) {
                const cachedData = JSON.parse(cachedStr);
                if (cachedData.thumb) document.getElementById('search-top-artist-img').src = cachedData.thumb;
            } else {
                fetch(`https://www.theaudiodb.com/api/v1/json/2/search.php?s=${encodeURIComponent(topArtist.name)}`)
                    .then(r => r.json()).then(adbData => {
                        if (adbData.artists?.[0]?.strArtistThumb) {
                            const thumb = adbData.artists[0].strArtistThumb;
                            document.getElementById('search-top-artist-img').src = thumb;
                            const existingCache = JSON.parse(localStorage.getItem(cacheKey) || '{}');
                            existingCache.thumb = thumb;
                            localStorage.setItem(cacheKey, JSON.stringify(existingCache));
                        }
                    }).catch(() => { });
            }
        } else { topResultContainer.innerHTML = ''; }

        // --- 3. Songs List (With Expand/Collapse Logic) ---
        const songsList = document.getElementById('search-songs-list');
        const songsTitle = document.getElementById('search-songs-title');
        songsList.innerHTML = '';

        if (results.song && results.song.length > 0) {
            songsTitle.style.display = 'block';
            songsTitle.innerText = `Songs (${results.song.length})`;

            results.song.forEach((track, i) => {
                const div = document.createElement('div');
                div.className = 'track-row track-row-artist';
                if (i >= 5) {
                    div.style.display = 'none';
                    div.classList.add('extra-song');
                }

                div.innerHTML = `
                    <span>${i + 1}</span>
                    <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${track.title}</span>
                    <span class="artist-link" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${track.artist}</span>
                    <span>${formatDuration(track.duration)}</span>
                    <span class="download-btn" title="Download">⬇</span>
                    <span class="add-to-pl-btn" onclick="event.stopPropagation(); openPlaylistModal('${track.id}')" title="Add to Playlist">➕</span>`;

                div.onclick = () => playFromList(results.song, i);
                div.querySelector('.artist-link').onclick = (e) => { e.stopPropagation(); searchArtist(track.artist); };
                div.querySelector('.download-btn').onclick = (e) => { e.stopPropagation(); downloadTrack(track.id, track.title, track.artist, track.suffix); };
                songsList.appendChild(div);
            });

            if (results.song.length > 5) {
                const toggleBtn = document.createElement('div');
                toggleBtn.id = 'search-songs-toggle';
                toggleBtn.style = "padding: 12px; text-align: center; color: var(--accent); cursor: pointer; font-weight: bold; font-size: 0.9em; opacity: 0.8; border: 1px solid rgba(168, 85, 247, 0.2); border-radius: 8px; margin-top: 10px;";
                toggleBtn.innerText = `Show ${results.song.length - 5} More Songs...`;

                let isExpanded = false;
                toggleBtn.onclick = () => {
                    isExpanded = !isExpanded;
                    const extraSongs = document.querySelectorAll('.extra-song');
                    if (isExpanded) {
                        extraSongs.forEach(el => el.style.display = 'grid');
                        toggleBtn.innerText = 'Show Less';
                    } else {
                        extraSongs.forEach(el => el.style.display = 'none');
                        toggleBtn.innerText = `Show ${results.song.length - 5} More Songs...`;
                        songsTitle.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }
                };
                songsList.appendChild(toggleBtn);
            }
        } else {
            songsTitle.style.display = 'none';
        }

        // --- 4. Albums Grid ---
        const albumsGrid = document.getElementById('search-albums-grid');
        const albumsTitle = document.getElementById('search-albums-title');
        albumsGrid.innerHTML = '';

        if (results.album && results.album.length > 0) {
            albumsTitle.style.display = 'block';
            albumsTitle.innerText = `Albums (${results.album.length})`;

            results.album.forEach((album, i) => {
                const resParam = (imgResolution !== "0") ? `&size=${imgResolution}` : "";
                const artUrl = `${config.url}/rest/getCoverArt?id=${album.coverArt}${resParam}&${getAuth()}`;

                const card = document.createElement('div');
                card.className = 'grid-album-card';

                if (i >= 5) {
                    card.style.display = 'none';
                    card.classList.add('extra-album');
                }

                card.dataset.id = album.id;
                card.innerHTML = `
                    <img class="grid-album-art" src="${artUrl}" loading="lazy">
                    <div style="font-weight:bold; font-size:14px; margin-top:5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${album.name}</div>
                    <div style="font-size:12px; opacity:0.6;">${album.artist}</div>`;

                card.onclick = () => loadAlbumTracks(album.id);
                albumsGrid.appendChild(card);
            });

            if (results.album.length > 5) {
                const toggleBtn = document.createElement('div');
                toggleBtn.id = 'search-albums-toggle';
                toggleBtn.style = "padding: 12px; text-align: center; color: var(--accent); cursor: pointer; font-weight: bold; font-size: 0.9em; opacity: 0.8; border: 1px solid rgba(168, 85, 247, 0.2); border-radius: 8px; margin-top: 10px; width: 100%; grid-column: 1 / -1;";
                toggleBtn.innerText = `Show ${results.album.length - 5} More Albums...`;

                let isExpanded = false;
                toggleBtn.onclick = () => {
                    isExpanded = !isExpanded;
                    const extraAlbums = albumsGrid.querySelectorAll('.extra-album');
                    if (isExpanded) {
                        extraAlbums.forEach(el => el.style.display = 'block');
                        toggleBtn.innerText = 'Show Less';
                    } else {
                        extraAlbums.forEach(el => el.style.display = 'none');
                        toggleBtn.innerText = `Show ${results.album.length - 5} More Albums...`;
                        albumsTitle.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }
                };
                albumsGrid.appendChild(toggleBtn);
            }
        } else {
            albumsTitle.style.display = 'none';
        }
    } catch (err) {
        console.error("Search failed", err);
    }
}

document.getElementById('library-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') handleGlobalSearch(e); });
document.getElementById('grid-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') handleGlobalSearch(e); });

function showGridView() {
    // 1. Existing hide logic to clear standard view containers
    hideAllViews();
    const searchBar = document.getElementById('library-search');
    const gridSearch = document.getElementById('grid-search');
    if (searchBar) searchBar.value = '';
    if (gridSearch) gridSearch.value = '';

    // 2. TARGET THE LINGERING CLOSE BUTTON
    const pinnedCloseBtn = document.getElementById('pinnedCloseBtn');
    if (pinnedCloseBtn) {
        pinnedCloseBtn.style.display = 'none';
    }

    // 3. FORCE HIDE LYRICS & ALBUM VIEWS
    const lyricsView = document.getElementById('lyrics-view');
    const albumView = document.getElementById('album-view');
    const artistView = document.getElementById('artist-view');

    if (lyricsView) {
        lyricsView.style.display = 'none';
        lyricsOpen = false; // Sync the internal state
    }
    if (albumView) albumView.style.display = 'none';
    if (artistView) artistView.style.display = 'none';

    // --- RESET LOGIC FOR HOME BUTTON ---
    // If we have an albumIndex, reset the library to start from 'A'
    if (albumIndex && albumIndex.length > 0) {
        const mainGrid = document.getElementById('alphabetical-grid');
        const sidebarList = document.getElementById('album-list');

        // Clear any "Teleported" letter results currently on screen
        if (mainGrid) mainGrid.innerHTML = '';
        if (sidebarList) sidebarList.innerHTML = '';

        // Reset the library pointers to the very beginning
        currentLibraryOffset = 0;
        allLibraryLoaded = false;

        // Immediately load the first batch of 500 albums
        const firstBatch = albumIndex.slice(0, libraryPageSize);
        renderAlbumsToUI(firstBatch);
        currentLibraryOffset = libraryPageSize;
    }

    // 4. SECURE THE GRID
    const gridView = document.getElementById('library-grid-view');
    if (gridView) {
        gridView.style.display = 'block';
        // Force scroll back to the very top
        gridView.scrollTo({ top: 0, behavior: 'instant' });
    }

    // 5. Update History
    pushHistory({ view: 'grid', title: 'Library' }, true);
}

// 4. Main Library Loader
async function loadLibrary(isNewLoad = true) {
    if (isLibraryFetching || (allLibraryLoaded && !isNewLoad)) return;

    const mainGrid = document.getElementById('alphabetical-grid');
    const sidebarList = document.getElementById('album-list');
    // Target the wrapper we added to the HTML
    const playlistSection = document.getElementById('playlist-section-wrapper');

    if (isNewLoad) {
        const existingToast = document.querySelector('.toast-container');
        if (existingToast) existingToast.style.display = 'none';

        currentLibraryOffset = 0;
        allLibraryLoaded = false;
        albumIndex = [];

        // 1. Start the fade out for everything
        if (sidebarList) sidebarList.classList.add('loading-fade');
        if (mainGrid) mainGrid.classList.add('loading-fade');

        // Hide the playlists section completely so it doesn't snap to the top
        if (playlistSection) playlistSection.classList.add('loading-fade');

        // 2. WAIT for the fade to finish before we clear anything
        await new Promise(resolve => setTimeout(resolve, 300));

        if (mainGrid) mainGrid.innerHTML = '';
        if (sidebarList) sidebarList.innerHTML = '';

        toggleLibrarySpinner(true, true);
        updateAlphabeticalSidebar();
    }

    isLibraryFetching = true;

    try {
        if (albumIndex.length === 0) {
            const countUrl = `${config.url}/rest/getAlbumList2?type=${currentSortType}&size=1&${getAuth()}`;
            const countRes = await fetch(countUrl);
            const countData = await countRes.json();
            const totalCount = countData['subsonic-response']?.albumList2?.albumCount || 100000;

            let indexUrl = `${config.url}/rest/getAlbumList2?type=${currentSortType}&size=${totalCount}&${getAuth()}`;
            const res = await fetch(indexUrl);
            const data = await res.json();
            const responseData = data['subsonic-response'];

            const listKey = Object.keys(responseData).find(key =>
                responseData[key] && Array.isArray(responseData[key].album)
            );

            let allAlbums = listKey ? responseData[listKey].album : [];

            // --- DYNAMIC SORTING LOGIC ---
            switch (currentSortType) {
                case 'newest':
                    albumIndex = allAlbums;
                    break;
                case 'random':
                    albumIndex = allAlbums.sort(() => Math.random() - 0.5);
                    break;
                default:
                    allAlbums.sort((a, b) => {
                        const isArtistSort = (currentSortType === 'alphabeticalByArtist');
                        let valA = (isArtistSort ? (a.artist || "") : (a.name || "")).trim();
                        let valB = (isArtistSort ? (b.artist || "") : (b.name || "")).trim();

                        const getZone = (str) => {
                            const firstChar = str.charAt(0);
                            if (/[0-9]/.test(firstChar)) return 1;
                            if (/[a-zA-Z]/.test(firstChar)) return 2;
                            return 0;
                        };
                        const zoneA = getZone(valA);
                        const zoneB = getZone(valB);

                        if (zoneA !== zoneB) return zoneA - zoneB;
                        if (zoneA === 0) return valA.charCodeAt(0) - valB.charCodeAt(0);

                        return valA.localeCompare(valB, 'en', { numeric: true, sensitivity: 'base' });
                    });
                    albumIndex = allAlbums;
                    break;
            }
        }

        const nextBatch = albumIndex.slice(currentLibraryOffset, currentLibraryOffset + libraryPageSize);

        if (nextBatch.length === 0) {
            allLibraryLoaded = true;
        } else {
            if (!isNewLoad && currentLibraryOffset > 0) {
                showToast("⏳ Fetching More Albums...");
            }
            renderAlbumsToUI(nextBatch);
            currentLibraryOffset += libraryPageSize;
        }

        if (currentLibraryOffset >= albumIndex.length) {
            allLibraryLoaded = true;
        }

        if (isNewLoad) {
            // 3. Reveal everything once new albums are in the sidebar
            requestAnimationFrame(() => {
                if (mainGrid) mainGrid.classList.remove('loading-fade');
                if (sidebarList) sidebarList.classList.remove('loading-fade');
                if (playlistSection) playlistSection.classList.remove('loading-fade');
            });
            showGridView();
        }

    } catch (err) {
        console.error("Library load error:", err);
        showToast("❌ Connection Error");
    } finally {
        isLibraryFetching = false;
        toggleLibrarySpinner(false);
    }
}

function renderAlbumsToUI(albums) {
    const sidebarList = document.getElementById('album-list');
    const mainGrid = document.getElementById('alphabetical-grid');
    const maxDomItems = 1500;
    const pruneAmount = 500;

    if (mainGrid.children.length + albums.length > maxDomItems) {
        for (let i = 0; i < pruneAmount; i++) {
            if (mainGrid.firstChild) mainGrid.removeChild(mainGrid.firstChild);
            if (sidebarList.firstChild) sidebarList.removeChild(sidebarList.firstChild);
        }
        createLoadPreviousUI();
    }

    albums.forEach((album, i) => {
        const resParam = (imgResolution !== "0") ? `&size=${imgResolution}` : "";
        const artUrl = `${config.url}/rest/getCoverArt?id=${album.coverArt}${resParam}&${getAuth()}`;
        // CRITICAL: Calculate the index relative to the whole library
        const absoluteIndex = currentLibraryOffset - albums.length + i;

        const item = document.createElement('div');
        item.className = 'album-item';
        item.setAttribute('data-index', absoluteIndex);
        item.innerHTML = `<img class="album-thumb" src="${artUrl}"><div><b>${album.name}</b><br><small>${album.artist}</small></div>`;
        item.onclick = () => loadAlbumTracks(album.id);
        sidebarList.appendChild(item);

        const card = document.createElement('div');
        card.className = 'grid-album-card';
        card.setAttribute('data-index', absoluteIndex); // Use setAttribute for consistency
        card.innerHTML = `
            <img class="grid-album-art" src="${artUrl}">
            <div style="font-weight:bold; font-size:14px; margin-top:5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                <b>${album.name}</b>
            </div>
            <div style="font-size:12px; opacity:0.6;">${album.artist}</div>`;
        card.onclick = () => loadAlbumTracks(album.id);
        mainGrid.appendChild(card);
    });
}

window.changeLibrarySort = function (newSort) {
    currentSortType = newSort;
    loadLibrary(true);
};

function toggleLibrarySpinner(show) {
    const spinner = document.getElementById('library-spinner');
    if (spinner) spinner.style.display = show ? 'block' : 'none';
}

// Infinite Scroll logic
document.getElementById('library-grid-view').addEventListener('scroll', function (e) {
    const { scrollTop, scrollHeight, clientHeight } = e.target;
    // Load next 500 when within 300px of bottom
    if (scrollTop + clientHeight >= scrollHeight - 300) {
        if (!allLibraryLoaded && !isLibraryFetching) {
            toggleLibrarySpinner(true);
            loadLibrary(false);
        }
    }
});

async function loadPlaylists() {
    try {
        const res = await fetch(`${config.url}/rest/getPlaylists?${getAuth()}`);
        const data = await res.json();
        const playlists = data['subsonic-response'].playlists.playlist || [];
        const list = document.getElementById('playlist-list');
        if (!list) return;
        list.innerHTML = '';
        const recentItem = document.createElement('div');
        recentItem.className = 'playlist-item';
        recentItem.style.border = "1px solid rgba(255, 255, 255, 0.1)";
        recentItem.innerHTML = `<div class="playlist-thumb">🕒</div><div><b>Recently Played</b><br><small>Your History</small></div>`;
        recentItem.onclick = () => loadRecentlyPlayed();
        list.appendChild(recentItem);
        const favItem = document.createElement('div'); favItem.className = 'playlist-item';
        favItem.style.border = "1px solid rgba(29, 185, 84, 0.3)";
        favItem.innerHTML = `<div class="playlist-thumb"><img src="assets/images/heart.png" style="width: 32px; height: 32px; object-fit: contain;"></div><div><b>Favourite Tracks</b><br><small>Your Favorites</small></div>`;
        favItem.onclick = () => loadStarredTracks();
        list.appendChild(favItem);
        const mixItem = document.createElement('div'); mixItem.className = 'playlist-item';
        mixItem.innerHTML = `<div class="playlist-thumb">🎲</div><div><b>Quick Mix</b><br><small>Random 50 Tracks</small></div>`;
        mixItem.onclick = () => playRandomMix();
        list.appendChild(mixItem);
        if (playlists) {
            playlists.forEach(pl => {
                const item = document.createElement('div');
                item.className = 'playlist-item';
                item.innerHTML = `
                    <div class="playlist-thumb" onclick="event.stopPropagation(); loadPlaylistTracks('${pl.id}', '${pl.name}')">🎵</div>
                    <div style="flex:1; overflow:hidden;" onclick="event.stopPropagation(); loadPlaylistTracks('${pl.id}', '${pl.name}')"><b>${pl.name}</b><br><small>${pl.songCount} tracks</small></div>
                    <button class="queue-del-btn" style="padding: 6px 10px; margin-left: 5px;" onclick="event.stopPropagation(); deletePlaylist('${pl.id}', '${pl.name}')" title="Delete Playlist">✕</button>`;
                list.appendChild(item);
            });
        }
    } catch (err) { console.error("Playlists load error:", err); }
}

window.loadRecentlyPlayed = function () {
    if (lyricsOpen) { lyricsOpen = false; document.getElementById('lyrics-view').style.display = 'none'; document.getElementById('pinnedCloseBtn').style.display = 'none'; }
    hideAllViews();
    document.getElementById('album-view').style.display = 'block';
    const dlAlbumBtn = document.getElementById('downloadAlbumBtn');
    if (dlAlbumBtn) dlAlbumBtn.style.display = 'none';
    viewQueue = JSON.parse(localStorage.getItem('recently_played') || '[]');
    document.getElementById('view-album-title').innerText = "Recently Played";
    const artistSubtitle = document.getElementById('view-album-artist');
    artistSubtitle.innerText = "Listening History";
    artistSubtitle.style.cursor = "default"; artistSubtitle.onclick = null;
    document.getElementById('view-album-art').style.display = 'none';
    const container = document.getElementById('track-items');
    container.innerHTML = '';
    if (viewQueue.length === 0) { container.innerHTML = '<p style="opacity:0.5;">No listening history found yet.</p>'; return; }
    viewQueue.forEach((track, i) => {
        const div = document.createElement('div');
        div.className = 'track-row track-row-artist';
        div.innerHTML = `<span>${i + 1}</span><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${track.title}</span><span class="artist-link" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${track.artist}</span><span>${formatDuration(track.duration)}</span><span class="download-btn" title="Download">⬇</span><span class="add-to-pl-btn" onclick="event.stopPropagation(); openPlaylistModal('${track.id}')" title="Add to Playlist">➕</span>`;
        div.onclick = () => playFromList(viewQueue, i);
        div.querySelector('.artist-link').onclick = (e) => { e.stopPropagation(); searchArtist(track.artist); };
        div.querySelector('.download-btn').onclick = (e) => { e.stopPropagation(); downloadTrack(track.id, track.title, track.artist, track.suffix); };
        div.oncontextmenu = () => { ipcRenderer.send('show-track-menu', track); };
        container.appendChild(div);
    });
}

function playFromList(list, index) {
    playbackQueue = [...list];
    originalQueue = [...list];
    if (isShuffle) {
        const currentTrack = playbackQueue[index];
        let remaining = playbackQueue.filter((_, idx) => idx !== index);
        for (let x = remaining.length - 1; x > 0; x--) {
            const y = Math.floor(Math.random() * (x + 1));
            [remaining[x], remaining[y]] = [remaining[y], remaining[x]];
        }
        playbackQueue = [currentTrack, ...remaining];
        playQueue(0);
    } else { playQueue(index); }
}

async function playRandomMix() {
    showToast("🎲 Generating Mix...");
    try {
        const res = await fetch(`${config.url}/rest/getRandomSongs?size=50&${getAuth()}`);
        const data = await res.json();
        playbackQueue = data['subsonic-response'].randomSongs.song;
        originalQueue = [...playbackQueue];
        currentIndex = 0; playQueue(0);
    } catch (e) { showToast("❌ Mix Failed To Generate"); }
}

async function loadStarredTracks() {
    if (lyricsOpen) { lyricsOpen = false; document.getElementById('lyrics-view').style.display = 'none'; document.getElementById('pinnedCloseBtn').style.display = 'none'; }
    hideAllViews();
    document.getElementById('album-view').style.display = 'block';
    pushHistory({ view: 'starred', title: 'Favourites' }, true);
    const dlAlbumBtn = document.getElementById('downloadAlbumBtn');
    if (dlAlbumBtn) dlAlbumBtn.style.display = 'none';
    const res = await fetch(`${config.url}/rest/getStarred?${getAuth()}`);
    const data = await res.json();
    viewQueue = data['subsonic-response'].starred.song || [];
    document.getElementById('view-album-title').innerText = "Favourite Tracks";
    const artistSubtitle = document.getElementById('view-album-artist');
    artistSubtitle.innerText = "Personal Collection";
    artistSubtitle.style.cursor = "default"; artistSubtitle.onclick = null;
    document.getElementById('view-album-art').style.display = 'block';
    setFadeImage(document.getElementById('view-album-art'), "assets/images/heart.png");
    const container = document.getElementById('track-items');
    container.innerHTML = '';
    viewQueue.forEach((track, i) => {
        const div = document.createElement('div');
        div.className = 'track-row track-row-artist';
        div.innerHTML = `<span>${i + 1}</span><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${track.title}</span><span class="artist-link" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${track.artist}</span><span>${formatDuration(track.duration)}</span><span class="download-btn" title="Download">⬇</span><span class="add-to-pl-btn" onclick="event.stopPropagation(); openPlaylistModal('${track.id}')" title="Add to Playlist">➕</span>`;
        div.onclick = () => playFromList(viewQueue, i);
        div.querySelector('.artist-link').onclick = (e) => { e.stopPropagation(); searchArtist(track.artist); };
        div.querySelector('.download-btn').onclick = (e) => { e.stopPropagation(); downloadTrack(track.id, track.title, track.artist, track.suffix); };
        div.oncontextmenu = () => { ipcRenderer.send('show-track-menu', track); };
        container.appendChild(div);
    });
}

async function searchArtist(artistName) {
    if (lyricsOpen) {
        lyricsOpen = false;
        document.getElementById('lyrics-view').style.display = 'none';
        document.getElementById('pinnedCloseBtn').style.display = 'none';
    }

    hideAllViews();
    const artistView = document.getElementById('artist-view');
    artistView.style.display = 'block';
    artistView.scrollTo(0, 0);

    document.getElementById('artist-name-title').innerText = artistName;
    const albumGrid = document.getElementById('artist-albums-grid');
    const bioContainer = document.getElementById('artist-bio-container');
    const bioText = document.getElementById('artist-bio-text');
    const topTracksContainer = document.getElementById('artist-top-tracks-container');
    const topTracksList = document.getElementById('artist-top-tracks-list');
    const similarContainer = document.getElementById('artist-similar-container');
    const toggleBtn = document.getElementById('bio-toggle-btn');

    setFadeImage(document.getElementById('artist-banner'), artistPlaceholder);
    albumGrid.innerHTML = '<p style="opacity:0.5;">Gathering Discography...</p>';

    if (topTracksList) topTracksList.innerHTML = '';
    if (bioContainer) bioContainer.style.display = 'none';
    if (topTracksContainer) topTracksContainer.style.display = 'none';
    if (similarContainer) similarContainer.style.display = 'none';
    if (bioText) bioText.classList.remove('expanded');
    if (toggleBtn) toggleBtn.style.display = 'none';

    try {
        // 1. Fetch Library Data
        const searchRes = await fetch(`${config.url}/rest/search3?query=${encodeURIComponent(artistName)}&albumCount=100&songCount=20&${getAuth()}&f=json`);
        const searchData = await searchRes.json();
        const results = searchData['subsonic-response']?.searchResult3 || {};

        const albums = (results.album || []).filter(a =>
            a.artist.toLowerCase().includes(artistName.toLowerCase()) ||
            artistName.toLowerCase().includes(a.artist.toLowerCase())
        );

        const topTracks = (results.song || []).filter(s =>
            s.artist.toLowerCase().includes(artistName.toLowerCase()) ||
            artistName.toLowerCase().includes(s.artist.toLowerCase())
        );

        albumGrid.innerHTML = '';

        if (albums.length > 0) {
            albums.forEach(album => {
                const resParam = (imgResolution !== "0") ? `&size=${imgResolution}` : "";
                const artUrl = `${config.url}/rest/getCoverArt?id=${album.coverArt}${resParam}&${getAuth()}`;
                const card = document.createElement('div');
                card.className = 'grid-album-card';
                card.innerHTML = `<img class="grid-album-art" src="${artUrl}"><div><b>${album.name}</b></div>`;
                card.onclick = () => { artistView.style.display = 'none'; loadAlbumTracks(album.id); };
                albumGrid.appendChild(card);
            });

            document.getElementById('artist-stats').innerText = `${albums.length} Albums in Library`;
            setFadeImage(document.getElementById('artist-banner'), `${config.url}/rest/getCoverArt?id=${albums[0].coverArt}&${getAuth()}`);

            try {
                const simRes = await fetch(`${config.url}/rest/getSimilarSongs2?id=${albums[0].id}&count=50&${getAuth()}&f=json`);
                const simData = await simRes.json();
                const simSongs = simData['subsonic-response'].similarSongs2?.song || [];
                const uniqueArtists = [];
                const seen = new Set([artistName.toLowerCase()]);

                for (const s of simSongs) {
                    if (!seen.has(s.artist.toLowerCase())) {
                        seen.add(s.artist.toLowerCase());
                        uniqueArtists.push({ name: s.artist, artId: s.coverArt });
                    }
                }

                if (uniqueArtists.length > 0 && similarContainer) {
                    similarContainer.style.display = 'block';
                    const simGrid = document.getElementById('artist-similar-grid');
                    simGrid.innerHTML = '';
                    uniqueArtists.slice(0, 6).forEach(sim => {
                        const card = document.createElement('div');
                        card.className = 'grid-album-card';
                        card.innerHTML = `<img class="grid-album-art" src="${config.url}/rest/getCoverArt?id=${sim.artId}&${getAuth()}" onerror="this.style.opacity='0'"><div><b>${sim.name}</b></div>`;
                        card.onclick = () => { artistView.scrollTo(0, 0); searchArtist(sim.name); };
                        simGrid.appendChild(card);
                    });
                }
            } catch (e) { console.warn("Similar Artists failed", e); }
        } else {
            albumGrid.innerHTML = '<p style="opacity:0.5;">No albums found in library.</p>';
        }

        if (topTracks.length > 0 && topTracksContainer) {
            topTracksContainer.style.display = 'block';
            topTracks.slice(0, 10).forEach((track, i) => {
                const div = document.createElement('div');
                div.className = 'track-row';
                div.innerHTML = `<span>${i + 1}</span><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${track.title}</span><span>${formatDuration(track.duration)}</span><span class="download-btn" title="Download">⬇</span><span class="add-to-pl-btn" onclick="event.stopPropagation(); openPlaylistModal('${track.id}')" title="Add to Playlist">➕</span>`;
                div.onclick = () => playFromList(topTracks, i);
                div.querySelector('.download-btn').onclick = (e) => { e.stopPropagation(); downloadTrack(track.id, track.title, track.artist, track.suffix); };
                topTracksList.appendChild(div);
            });
        }

        // 2. REINFORCED CACHE & BIO DISCOVERY
        const cacheKey = `bio_${artistName.toLowerCase()}`;
        const cachedStr = localStorage.getItem(cacheKey);
        let cachedData = null;
        try { cachedData = cachedStr ? JSON.parse(cachedStr) : null; } catch (e) { }

        // VALIDATION: Only use cache if it contains BOTH image and significant text
        if (cachedData && cachedData.text && cachedData.text.trim().length > 10) {
            bioText.innerText = cachedData.text;
            if (bioContainer) bioContainer.style.display = 'block';
            if (bioText.scrollHeight > 120 && toggleBtn) toggleBtn.style.display = 'block';
            if (cachedData.thumb) setFadeImage(document.getElementById('artist-banner'), cachedData.thumb);
        } else {
            // Helper to try AudioDB
            const fetchADB = async (name) => {
                const r = await fetch(`https://www.theaudiodb.com/api/v1/json/2/search.php?s=${encodeURIComponent(name)}`);
                const d = await r.json();
                return d?.artists?.[0];
            };

            let artistData = await fetchADB(artistName);

            // Try without "The" if necessary
            if (!artistData && artistName.toLowerCase().startsWith("the ")) {
                artistData = await fetchADB(artistName.substring(4));
            }

            let finalBio = artistData?.strBiographyEN || '';
            let finalThumb = artistData?.strArtistThumb || (cachedData ? cachedData.thumb : '');

            // Wikipedia Fallback: If Bio is still empty or too short
            if (!finalBio || finalBio.trim().length < 10) {
                try {
                    const wikiRes = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(artistName)}`);
                    if (wikiRes.ok) {
                        const wikiData = await wikiRes.json();
                        finalBio = wikiData.extract || '';
                        if (!finalThumb) finalThumb = wikiData.originalimage?.source || wikiData.thumbnail?.source || '';
                    }
                } catch (e) { console.warn("Wiki fallback failed", e); }
            }

            // Apply to UI
            if (finalBio && bioText && bioContainer) {
                bioText.innerText = finalBio;
                bioContainer.style.display = 'block';
                if (bioText.scrollHeight > 120 && toggleBtn) toggleBtn.style.display = 'block';
            }
            if (finalThumb) setFadeImage(document.getElementById('artist-banner'), finalThumb);

            // Save complete data back to cache
            if (finalBio || finalThumb) {
                localStorage.setItem(cacheKey, JSON.stringify({ text: finalBio, thumb: finalThumb }));
            }
        }
    } catch (e) { console.error("Artist Discovery failed", e); }
}

function toggleBio() {
    const bioText = document.getElementById('artist-bio-text');
    const btn = document.getElementById('bio-toggle-btn');
    if (!bioText || !btn) return;
    bioText.classList.toggle('expanded');
    btn.innerText = bioText.classList.contains('expanded') ? 'Read Less' : 'Read More';
}

async function loadPlaylistTracks(playlistId, playlistName) {
    if (lyricsOpen) { lyricsOpen = false; document.getElementById('lyrics-view').style.display = 'none'; document.getElementById('pinnedCloseBtn').style.display = 'none'; }
    hideAllViews();
    document.getElementById('album-view').style.display = 'block';
    const res = await fetch(`${config.url}/rest/getPlaylist?id=${playlistId}&${getAuth()}`);
    const data = await res.json();
    viewQueue = data['subsonic-response'].playlist.entry || [];
    document.getElementById('view-album-title').innerText = playlistName;
    const artistSubtitle = document.getElementById('view-album-artist');
    artistSubtitle.innerText = "Playlist";
    artistSubtitle.style.cursor = "default"; artistSubtitle.onclick = null;
    const container = document.getElementById('track-items');
    container.innerHTML = '';
    if (viewQueue.length === 0) {
        container.innerHTML = `<div class="playlist-empty-state"><div style="font-size: 64px; margin-bottom: 20px;">📁</div><h3>This Playlist Is Empty</h3><p>Add Some Tracks To Get Started</p></div>`;
        setFadeImage(document.getElementById('view-album-art'), playlistPlaceholder);
        return;
    }
    document.getElementById('view-album-art').style.display = 'block';
    const uniqueCovers = [...new Set(viewQueue.map(t => t.coverArt))].slice(0, 4);
    const coverUrls = uniqueCovers.map(id => `${config.url}/rest/getCoverArt?id=${id}&${getAuth()}`);
    const collageDataUrl = await generateSmartCollage(coverUrls);
    setFadeImage(document.getElementById('view-album-art'), collageDataUrl);
    viewQueue.forEach((track, i) => {
        const div = document.createElement('div');
        div.className = 'track-row track-row-artist';
        div.innerHTML = `<span>${i + 1}</span><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis; flex:1;">${track.title}</span><span class="artist-link" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${track.artist}</span><span>${formatDuration(track.duration)}</span><span class="track-actions" style="display:flex; align-items:center; gap:12px; margin-left:15px;"><span class="download-btn" title="Download">⬇</span><span class="add-to-pl-btn" onclick="event.stopPropagation(); openPlaylistModal('${track.id}')" title="Add to Playlist">➕</span><span class="remove-btn" onclick="event.stopPropagation(); removeFromPlaylist('${playlistId}', ${i}, '${playlistName}')" title="Remove Track" style="color:#ff5f5f; cursor:pointer; font-weight:bold; padding: 0 5px;">✕</span></span>`;
        div.onclick = () => playFromList(viewQueue, i);
        div.querySelector('.artist-link').onclick = (e) => { e.stopPropagation(); searchArtist(track.artist); };
        div.oncontextmenu = () => { ipcRenderer.send('show-track-menu', track); };
        container.appendChild(div);
    });
}

async function loadAlbumTracks(albumId) {
    if (lyricsOpen) { lyricsOpen = false; document.getElementById('lyrics-view').style.display = 'none'; document.getElementById('pinnedCloseBtn').style.display = 'none'; }
    hideAllViews();
    document.getElementById('album-view').style.display = 'block';
    const res = await fetch(`${config.url}/rest/getAlbum?id=${albumId}&${getAuth()}`);
    const data = await res.json();
    const albumData = data['subsonic-response'].album;
    viewQueue = (albumData.song || []).map(track => {
        track.album = track.album && track.album !== "" ? track.album : albumData.name;
        track.albumId = track.albumId || albumData.id;
        return track;
    });
    document.getElementById('view-album-title').innerText = albumData.name;
    const artistSubtitle = document.getElementById('view-album-artist');
    artistSubtitle.innerText = albumData.artist;
    artistSubtitle.style.cursor = "pointer"; artistSubtitle.onclick = () => searchArtist(artistSubtitle.innerText);
    const shuffleAlbumBtn = document.getElementById('shuffleBtn');
    if (shuffleAlbumBtn) {
        shuffleAlbumBtn.innerText = isShuffle ? 'Shuffle: On' : 'Shuffle';
        shuffleAlbumBtn.onclick = () => { toggleShuffle(); };
    }
    const dlAlbumBtn = document.getElementById('downloadAlbumBtn');
    if (dlAlbumBtn) {
        dlAlbumBtn.style.display = 'inline-block';
        dlAlbumBtn.onclick = () => {
            const cleanArtist = sanitizeFilename(albumData.artist || 'Unknown');
            const cleanAlbum = sanitizeFilename(albumData.name || 'Album');
            const url = `${config.url}/rest/download?id=${albumId}&${getAuth()}`;
            ipcRenderer.send('download-track', { url, filename: `${cleanArtist} - ${cleanAlbum}.zip` });
            showToast(`📥 Downloading Album: ${albumData.name}...`);
        };
    }
    document.getElementById('view-album-art').style.display = 'block';
    setFadeImage(document.getElementById('view-album-art'), `${config.url}/rest/getCoverArt?id=${albumData.coverArt}&${getAuth()}`);
    const container = document.getElementById('track-items');
    container.innerHTML = '';
    viewQueue.forEach((track, i) => {
        const div = document.createElement('div'); div.className = 'track-row';
        div.innerHTML = `<span>${i + 1}</span><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${track.title}</span><span>${formatDuration(track.duration)}</span><span class="download-btn" title="Download">⬇</span><span class="add-to-pl-btn" onclick="event.stopPropagation(); openPlaylistModal('${track.id}')" title="Add to Playlist">➕</span>`;
        div.onclick = () => playFromList(viewQueue, i);
        div.querySelector('.download-btn').onclick = (e) => { e.stopPropagation(); downloadTrack(track.id, track.title, track.artist, track.suffix); };
        div.oncontextmenu = () => { ipcRenderer.send('show-track-menu', track); };
        container.appendChild(div);
    });
}

window.removeFromQueue = function (e, index) {
    e.stopPropagation();
    playbackQueue.splice(index, 1);
    if (index < currentIndex) { currentIndex--; }
    else if (index === currentIndex) {
        if (playbackQueue.length > 0) { playQueue(currentIndex % playbackQueue.length); }
        else { stopPlayerAndResetUI(); }
    }
    renderQueue();
};

window.reorderQueue = function (fromIndex, toIndex) {
    if (fromIndex === toIndex) return;
    const [movedTrack] = playbackQueue.splice(fromIndex, 1);
    playbackQueue.splice(toIndex, 0, movedTrack);
    if (currentIndex === fromIndex) { currentIndex = toIndex; }
    else {
        if (fromIndex < currentIndex && toIndex >= currentIndex) currentIndex--;
        else if (fromIndex > currentIndex && toIndex <= currentIndex) currentIndex++;
    }
    renderQueue();
};

ipcRenderer.on('menu-play-next', (e, track) => {
    if (!playbackQueue.length) { playbackQueue = [track]; originalQueue = [track]; playQueue(0); return; }
    playbackQueue.splice(currentIndex + 1, 0, track);
    if (isShuffle) originalQueue.push(track);
    showToast(`🎵 Will Play ${track.title} Next`);
    if (queueOpen) renderQueue();
});

ipcRenderer.on('menu-add-queue', (e, track) => {
    if (!playbackQueue.length) { playbackQueue = [track]; originalQueue = [track]; playQueue(0); return; }
    playbackQueue.push(track);
    if (isShuffle) originalQueue.push(track);
    showToast(`✅ Added ${track.title} To Queue`);
    if (queueOpen) renderQueue();
});

function toggleQueue() {
    queueOpen = !queueOpen;
    document.getElementById('queue-view').style.display = queueOpen ? 'flex' : 'none';
    if (queueOpen) renderQueue();
}

function renderQueue() {
    const list = document.getElementById('queue-list');
    list.innerHTML = '';
    if (!playbackQueue.length) { list.innerHTML = '<p style="opacity:0.5; text-align:center; padding: 20px;">Queue is empty.</p>'; return; }
    playbackQueue.forEach((track, originalIndex) => {
        const div = document.createElement('div');
        div.className = `queue-item ${originalIndex === currentIndex ? 'active' : ''}`;
        div.draggable = true;
        div.dataset.index = originalIndex;
        div.innerHTML = `<div style="display:flex; align-items:center; gap:10px; flex:1; overflow:hidden;"><span class="queue-drag-handle">≡</span><span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${track.title}</span></div><div style="display:flex; align-items:center; gap:10px;"><span style="opacity:0.5;">${formatDuration(track.duration)}</span><button class="queue-del-btn" onclick="removeFromQueue(event, ${originalIndex})">✕</button></div>`;
        div.onclick = (e) => { if (!e.target.classList.contains('queue-del-btn') && !e.target.classList.contains('queue-drag-handle')) { playQueue(originalIndex); } };
        div.ondragstart = (e) => { e.dataTransfer.setData('text/plain', originalIndex); div.style.opacity = '0.5'; };
        div.ondragend = (e) => { div.style.opacity = '1'; };
        div.ondragover = (e) => { e.preventDefault(); div.style.background = 'rgba(255,255,255,0.1)'; };
        div.ondragleave = (e) => { div.style.background = ''; };
        div.ondrop = (e) => { e.preventDefault(); div.style.background = ''; const fromIndex = parseInt(e.dataTransfer.getData('text/plain')); reorderQueue(fromIndex, originalIndex); };
        list.appendChild(div);
    });
}

async function toggleLyrics() {
    lyricsOpen = !lyricsOpen;
    const lyricsLayer = document.getElementById('lyrics-view');
    const closeBtn = document.getElementById('pinnedCloseBtn');
    const floatingNav = document.getElementById('sidebar-nav-floating');
    if (lyricsOpen) {
        lyricsLayer.style.display = 'block';
        closeBtn.style.display = 'block';
        if (floatingNav) floatingNav.style.display = 'none';
        if (currentlyPlayingTrack) fetchLyrics();
    } else {
        lyricsLayer.style.display = 'none';
        closeBtn.style.display = 'none';
        if (document.getElementById('sidebar').classList.contains('collapsed')) {
            if (floatingNav) floatingNav.style.display = 'flex';
        }
    }
}

async function fetchLyrics() {
    if (!currentlyPlayingTrack) return;
    const track = currentlyPlayingTrack;
    const container = document.getElementById('lyrics-content');
    container.innerHTML = `<p style="opacity:0.5; font-size:24px;">Syncing lyrics...</p>`;
    currentSyncedLyrics = [];
    try {
        const webRes = await fetch(`https://lrclib.net/api/get?artist_name=${encodeURIComponent(track.artist)}&track_name=${encodeURIComponent(track.title)}`);
        const webData = await webRes.json();
        if (webData.syncedLyrics) parseLRC(webData.syncedLyrics);
        else container.innerHTML = (webData.plainLyrics || "No lyrics found.").split('\n').map(line => line.trim() ? `<div class="lyric-line active">${line}</div>` : '').join('');
    } catch (e) { container.innerText = "Offline."; }
}

function parseLRC(lrcText) {
    const container = document.getElementById('lyrics-content'); container.innerHTML = '';
    lrcText.split('\n').forEach(line => {
        const match = line.match(/\[(\d+):(\d+\.\d+)\](.*)/);
        if (match) {
            const time = parseInt(match[1]) * 60 + parseFloat(match[2]);
            const text = match[3].trim();
            if (text) {
                const div = document.createElement('div'); div.className = 'lyric-line'; div.innerText = text;
                container.appendChild(div); currentSyncedLyrics.push({ time, element: div });
            }
        }
    });
}

function handleLyricsSync(currentTime) {
    if (!lyricsOpen || currentSyncedLyrics.length === 0) return;
    let activeIndex = -1;
    for (let i = 0; i < currentSyncedLyrics.length; i++) { if (currentTime >= currentSyncedLyrics[i].time) activeIndex = i; else break; }
    if (activeIndex !== -1) {
        document.querySelectorAll('.lyric-line').forEach(l => l.classList.remove('active'));
        const activeLine = currentSyncedLyrics[activeIndex].element;
        activeLine.classList.add('active'); activeLine.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

// 2. Updated playQueue
function playQueue(index) {
    clearTimeout(recentlyPlayedTimeout);

    currentIndex = index;
    currentlyPlayingTrack = playbackQueue[index];
    hasScrobbled = false;
    if (queueOpen) renderQueue();

    const track = currentlyPlayingTrack;

    const starBtn = document.getElementById('starBtn');
    if (starBtn) {
        starBtn.style.display = 'block';
        starBtn.innerText = track.starred ? '❤️' : '🤍';
        starBtn.onclick = toggleStar;
    }

    // UI Updates
    const mt = document.getElementById('mini-title');
    mt.innerHTML = `<span class="scroll-inner">${track.title}</span>`; applyScroll(mt);

    const miniArtistEl = document.getElementById('mini-artist');
    miniArtistEl.innerHTML = `<span class="scroll-inner">${track.artist}</span>`;
    miniArtistEl.onclick = () => { searchArtist(track.artist); }; applyScroll(miniArtistEl);

    const miniAlbumEl = document.getElementById('mini-album');
    const safeAlbumName = track.album ? track.album : "Unknown Album";
    miniAlbumEl.innerHTML = `<span class="scroll-inner">${safeAlbumName}</span>`;
    miniAlbumEl.onclick = () => { if (track.albumId) loadAlbumTracks(track.albumId); }; applyScroll(miniAlbumEl);

    /// Cover Art Logic
    const miniArt = document.getElementById('mini-art');
    miniArt.style.opacity = '0';
    miniArt.onload = function () {
        this.style.opacity = '1';
        try {
            const color = colorThief.getColor(this);
            const r = color[0], g = color[1], b = color[2];

            document.body.style.background = `radial-gradient(circle at 20% 30%, rgba(${r},${g},${b},0.55) 0%, #050505 85%)`;

            document.documentElement.style.setProperty('--accent', `rgb(${r},${g},${b})`);
            document.documentElement.style.setProperty('--accent-glow', `rgba(${r},${g},${b}, 0.4)`);

            document.getElementById('sidebar').style.background = `linear-gradient(to bottom, rgba(0,0,0,0.9), rgba(${r},${g},${b}, 0.2))`;

            const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
            window.currentIdealText = (yiq > 150) ? 'black' : 'white';

            document.querySelectorAll('.dynamic-accent-bg').forEach(btn => {
                btn.style.fontWeight = 'bold';

                if (btn.style.background.includes('var(--accent)') || btn.classList.contains('active')) {
                    btn.style.color = window.currentIdealText;
                    btn.style.textShadow = (window.currentIdealText === 'white') ? '0 1px 3px rgba(0,0,0,0.6)' : 'none';
                } else {
                    // Keep white for disabled state
                    btn.style.color = 'white';
                    btn.style.textShadow = 'none';
                }
            });

        } catch (e) {
            console.error("ColorThief Error:", e);
        }
    };

    const uniqueAlbums = [...new Set(playbackQueue.map(t => t.albumId))];
    if (uniqueAlbums.length > 1) { miniArt.src = `${config.url}/rest/getCoverArt?id=${track.coverArt}&${getAuth()}`; }
    else if (track.coverArt) { miniArt.src = `${config.url}/rest/getCoverArt?id=${track.coverArt}&${getAuth()}`; }
    else { miniArt.src = playlistPlaceholder; }
    miniArt.style.display = 'block';

    // Audio Setup
    let streamUrl = `${config.url}/rest/stream?id=${track.id}&${getAuth()}`;
    if (maxBitrate !== '0') streamUrl += `&maxBitRate=${maxBitrate}`;
    audio.src = streamUrl;
    audio.play();
    document.getElementById('playPauseBtn').innerText = '⏸';
    document.getElementById('total-time').innerText = formatDuration(track.duration);

    if (notificationsEnabled) {
        ipcRenderer.send('notify', { title: track.title, body: track.artist, iconDataUrl: `${config.url}/rest/getCoverArt?id=${track.coverArt}&${getAuth()}` });
    }

    // Recently Played Logic (30s rule)
    recentlyPlayedTimeout = setTimeout(() => {
        let recentStr = localStorage.getItem('recently_played');
        let recent = recentStr ? JSON.parse(recentStr) : [];

        recent = recent.filter(t => t.id !== track.id);
        recent.unshift(track);

        if (recent.length > 50) recent.pop();
        localStorage.setItem('recently_played', JSON.stringify(recent));

        loadPlaylists();

        const viewTitle = document.getElementById('view-album-title');
        if (viewTitle && viewTitle.innerText.toLowerCase().trim().includes("recently played")) {
            loadRecentlyPlayed();
        }
    }, 30000);

    sendRPCUpdate();
    if (lyricsOpen) fetchLyrics();
}

async function scrobbleTrack() {
    if (!currentlyPlayingTrack) return;
    try { await fetch(`${config.url}/rest/scrobble?id=${currentlyPlayingTrack.id}&submission=true&${getAuth()}`); showToast("🎵 Scrobbled To Server"); } catch (e) { console.error("Scrobble failed", e); }
}

function stopPlayerAndResetUI() {
    audio.pause(); audio.src = ""; currentlyPlayingTrack = null;
    document.getElementById('mini-title').innerText = "Tritone";
    document.getElementById('mini-artist').innerHTML = '<a href="https://github.com/Kyle8973/Tritone" target="_blank">By Kyle8973</a>';
    document.getElementById('mini-album').innerText = ""; document.getElementById('current-time').innerText = "0:00";
    document.getElementById('total-time').innerText = "0:00"; document.getElementById('progress-bar').value = 0;
    document.getElementById('starBtn').style.display = 'none';
    const miniArt = document.getElementById('mini-art'); miniArt.onload = null; miniArt.src = 'assets/images/logo.svg';
    document.getElementById('playPauseBtn').innerText = '⏸';
}

audio.onended = () => {
    if (isRepeat) { playQueue(currentIndex); }
    else {
        if (currentlyPlayingTrack) {
            if (playbackHistory.length === 0 || playbackHistory[playbackHistory.length - 1].id !== currentlyPlayingTrack.id) { playbackHistory.push(currentlyPlayingTrack); }
            currentlyPlayingTrack = null;
        }
        playbackQueue.splice(currentIndex, 1);
        if (playbackQueue.length > 0) { playQueue(currentIndex % playbackQueue.length); }
        else { stopPlayerAndResetUI(); }
    }
    if (queueOpen) renderQueue();
};

audio.onloadedmetadata = () => {
    const dur = (audio.duration && audio.duration !== Infinity && !isNaN(audio.duration)) ? audio.duration : (currentlyPlayingTrack ? currentlyPlayingTrack.duration : 0);
    if (dur > 0) document.getElementById('total-time').innerText = formatDuration(Math.floor(dur));
};

audio.ontimeupdate = () => {
    const currentDuration = (audio.duration && audio.duration !== Infinity && !isNaN(audio.duration)) ? audio.duration : (currentlyPlayingTrack ? currentlyPlayingTrack.duration : 0);
    if (currentDuration > 0) {
        document.getElementById('progress-bar').value = (audio.currentTime / currentDuration) * 100;
        document.getElementById('current-time').innerText = formatDuration(Math.floor(audio.currentTime));
        document.getElementById('total-time').innerText = formatDuration(Math.floor(currentDuration));
        handleLyricsSync(audio.currentTime);
        if (!hasScrobbled && audio.currentTime > (currentDuration / 2)) { hasScrobbled = true; scrobbleTrack(); }
    }
};

document.getElementById('progress-bar').oninput = function () {
    const dur = (audio.duration && audio.duration !== Infinity && !isNaN(audio.duration)) ? audio.duration : (currentlyPlayingTrack ? currentlyPlayingTrack.duration : 0);
    audio.currentTime = (this.value / 100) * dur; sendRPCUpdate();
};

document.getElementById('volume-slider').oninput = function () { audio.volume = this.value; localStorage.setItem('tritone_vol', this.value); };

function togglePlay() {
    if (!audio.src || audio.src === "" || audio.src.endsWith('index.html')) return;
    if (audio.paused) { audio.play(); document.getElementById('playPauseBtn').innerText = '⏸'; }
    else { audio.pause(); document.getElementById('playPauseBtn').innerText = '▶'; }
    sendRPCUpdate();
}

function toggleShuffle() {
    isShuffle = !isShuffle; const barBtn = document.getElementById('shuffleBarBtn'); const bigBtn = document.getElementById('shuffleBtn');
    if (isShuffle) {
        if (barBtn) barBtn.classList.add('active'); if (bigBtn) bigBtn.innerText = 'Shuffle: On'; isRepeat = false; const rpt = document.getElementById('repeatBtn'); if (rpt) rpt.classList.remove('active');
        if (playbackQueue.length > 0) {
            const currentTrack = playbackQueue[currentIndex];
            let remaining = originalQueue.filter(t => t.id !== currentTrack.id);
            for (let x = remaining.length - 1; x > 0; x--) {
                const y = Math.floor(Math.random() * (x + 1));
                [remaining[x], remaining[y]] = [remaining[y], remaining[x]];
            }
            playbackQueue = [currentTrack, ...remaining]; currentIndex = 0;
        }
    } else {
        if (barBtn) barBtn.classList.remove('active'); if (bigBtn) bigBtn.innerText = 'Shuffle';
        if (originalQueue.length > 0 && playbackQueue.length > 0) {
            const currentTrack = playbackQueue[currentIndex];
            playbackQueue = [...originalQueue]; const newIdx = playbackQueue.findIndex(t => t.id === currentTrack.id);
            currentIndex = newIdx !== -1 ? newIdx : 0;
        }
    }
    if (queueOpen) renderQueue();
}

function toggleRepeat() {
    isRepeat = !isRepeat; const repeatBtn = document.getElementById('repeatBtn');
    if (isRepeat) { repeatBtn.classList.add('active'); if (isShuffle) toggleShuffle(); }
    else { repeatBtn.classList.remove('active'); }
}

function playNext() {
    if (playbackQueue.length > 0) {
        // Record the current song into history before moving
        if (currentlyPlayingTrack) {
            playbackHistory.push(currentlyPlayingTrack);
        }

        // If there are more songs in the queue, just move the index forward
        if (currentIndex < playbackQueue.length - 1) {
            currentIndex++;
            playQueue(currentIndex);
        } else {
            // End of the album
            stopPlayerAndResetUI();
        }
    }
    if (queueOpen) renderQueue();
}

function playPrev() {
    // 1. Standard "Restart" rule: If more than 3 seconds in, reset the playhead
    if (audio.currentTime > 3) {
        audio.currentTime = 0;
        audio.play();
        return;
    }

    // 2. Look at your position in the current album (currentIndex)
    if (currentIndex > 0) {
        // Move back one spot in the tracklist regardless of history
        currentIndex--;
        playQueue(currentIndex);
    } else {
        // If it's the very first song in the list, just restart it
        audio.currentTime = 0;
        audio.play();
    }

    if (queueOpen) renderQueue();
}

function formatDuration(sec) {
    if (sec === Infinity || isNaN(sec) || !sec) return "0:00";
    let m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar'); const floatingNav = document.getElementById('sidebar-nav-floating');
    sidebar.classList.toggle('collapsed');
    updateBreadcrumbs();
    if (sidebar.classList.contains('collapsed')) { if (!lyricsOpen && floatingNav) floatingNav.style.display = 'flex'; }
    else { if (floatingNav) floatingNav.style.display = 'none'; }
}

async function generateSmartCollage(imageUrls) {
    const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 600;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#111'; ctx.fillRect(0, 0, 600, 600);
    const loadImage = (url) => new Promise((resolve) => {
        const img = new Image(); img.crossOrigin = "Anonymous";
        img.onload = () => resolve(img); img.onerror = () => resolve(null); img.src = url;
    });
    const images = (await Promise.all(imageUrls.map(url => loadImage(url)))).filter(img => img !== null);
    const count = images.length;
    if (count === 1) { ctx.drawImage(images[0], 0, 0, 600, 600); }
    else if (count === 2) { ctx.drawImage(images[0], 0, 0, 300, 600); ctx.drawImage(images[1], 300, 0, 300, 600); }
    else if (count === 3) { ctx.drawImage(images[0], 0, 0, 300, 600); ctx.drawImage(images[1], 300, 0, 300, 300); ctx.drawImage(images[2], 300, 300, 300, 300); }
    else if (count >= 4) { ctx.drawImage(images[0], 0, 0, 300, 300); ctx.drawImage(images[1], 300, 0, 300, 300); ctx.drawImage(images[2], 0, 300, 300, 300); ctx.drawImage(images[3], 300, 300, 300, 300); }
    return canvas.toDataURL('image/jpeg', 0.8);
}

// 1. Function to build the sidebar based on current alphabetical sort
function updateAlphabeticalSidebar() {
    const sidebar = document.getElementById('alphabetical-sidebar');
    if (!sidebar) return;

    const isAlpha = currentSortType.includes('alphabetical');
    sidebar.style.display = isAlpha ? 'flex' : 'none';
    if (!isAlpha) return;

    sidebar.style.position = 'fixed';
    sidebar.style.right = '10px';            // Space from the edge/scrollbar
    sidebar.style.top = '50%';
    sidebar.style.transform = 'translateY(-50%)';
    sidebar.style.maxHeight = '70vh';        // Keep clear of the player

    // Width & Spacing: This creates the "both sides" gap
    sidebar.style.width = '28px';            // Narrower width prevents touching albums
    sidebar.style.padding = '12px 0';        // Vertical padding only

    // Visual Style
    sidebar.style.backgroundColor = 'rgba(15, 15, 15, 0.85)';
    sidebar.style.backdropFilter = 'blur(12px)';
    sidebar.style.borderRadius = '30px';
    sidebar.style.border = '1px solid rgba(255,255,255,0.08)';
    sidebar.style.zIndex = '1000';
    sidebar.style.boxShadow = '0 4px 15px rgba(0,0,0,0.5)';

    let html = `
        <button onclick="resetToHome()" 
                title="Reset to A-Z"
                style="background: none; border: none; color: var(--accent); font-size: 16px; cursor: pointer; padding-bottom: 8px; width: 100%; display: flex; align-items: center; justify-content: center; transition: 0.2s;"
                onmouseover="this.style.transform='scale(1.2)'" 
                onmouseout="this.style.transform='scale(1)'">
            🏠
        </button>
    `;

    const letters = "#ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
    html += letters.map(char => `
        <button onclick="jumpToLetter('${char}')" 
                style="background: none; border: none; color: white; opacity: 0.5; font-size: 12px; font-weight: bold; cursor: pointer; padding: 0; height: 13px; width: 100%; display: flex; align-items: center; justify-content: center; transition: 0.2s;"
                onmouseover="this.style.opacity=1; this.style.color='var(--accent)';" 
                onmouseout="this.style.opacity=0.5; this.style.color='white';">
            ${char}
        </button>
    `).join('');

    sidebar.innerHTML = html;
}

window.resetToHome = function () {
    console.log("🏠 Resetting to full alphabetical view...");

    // 1. Determine the sort type immediately
    const isArtistSort = currentSortType === 'alphabeticalByArtist';

    // 2. CLEAR SEARCH UI (The Professional Cleanup)
    const searchBar = document.getElementById('library-search');
    const gridSearch = document.getElementById('grid-search');
    const searchView = document.getElementById('search-view');

    if (searchBar) searchBar.value = '';
    if (gridSearch) gridSearch.value = '';
    if (searchView) searchView.style.display = 'none';

    // 3. RESET LIBRARY STATE
    currentLibraryOffset = 0;
    allLibraryLoaded = false;

    // 4. RELOAD DATA
    loadLibrary(true);

    let label = isArtistSort ? "Artists" : "Albums";
    showToast(`📚 Showing All ${label} (A-Z)`);
};

window.jumpToLetter = async function (letter) {
    if (!albumIndex || albumIndex.length === 0) return;

    const isArtistSort = currentSortType === 'alphabeticalByArtist';

    const filteredBatch = albumIndex.filter(album => {
        const name = (isArtistSort ? album.artist : album.name) || "";
        const cleanName = name.trim().toUpperCase();

        if (letter === "#") {
            return !/^[A-Z]/.test(cleanName);
        } else {
            return cleanName.startsWith(letter.toUpperCase());
        }
    });

    if (filteredBatch.length === 0) {
        let errorMsg;
        if (isArtistSort) {
            errorMsg = `No Results Found For Artists Starting With Letter '${letter}'`;
        } else {
            errorMsg = `No Results Found For Albums Starting With Letter '${letter}'`;
        }

        showToast(`❌ ${errorMsg}`);
        return;
    }

    const mainGrid = document.getElementById('alphabetical-grid');
    const sidebarList = document.getElementById('album-list');

    mainGrid.innerHTML = '';
    sidebarList.innerHTML = '';

    renderAlbumsToUI(filteredBatch);

    allLibraryLoaded = true;

    const container = document.getElementById('library-grid-view');
    container.scrollTo({ top: 0, behavior: 'instant' });

    let toastMsg;
    if (isArtistSort) {
        toastMsg = `Showing Albums By Artists Starting With Letter '${letter}' (${filteredBatch.length})`;
    } else {
        toastMsg = `Showing Albums Starting With Letter '${letter}' (${filteredBatch.length})`;
    }

    showToast(`📁 ${toastMsg}`);
};

ipcRenderer.on('rpc-connection-failed', (event, data) => {
    showToast(`❌ ${data.message}`);
    rpcEnabled = false;
    localStorage.setItem('tritone_rpc_enabled', 'false');

    const rpcBtn = document.getElementById('rpc-toggle-btn');
    if (rpcBtn) {
        updateButtonStyle(rpcBtn, false, 'RPC');
    }
});

ipcRenderer.on('media-play-pause', togglePlay);
ipcRenderer.on('media-next', playNext);
ipcRenderer.on('media-prev', playPrev);