const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { exec } = require('child_process');
const query = require('samp-query');
const Store = require('electron-store').default;
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const extract = require('extract-zip');
const { autoUpdater } = require('electron-updater');

const store = new Store();
let mainWindow;

// Primary SA-MP server connection settings
const SERVERS = {
    primary: { host: "209.182.233.91", port: 7777 }
};

// URL pointing directly to your compressed .zip modpack asset file
const ASSET_ZIP_URL = "https://website.com/gta-assets/modpack.zip";

// Configure autoUpdater parameters behavior
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1050,
        height: 650,
        frame: false,
        resizable: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    mainWindow.loadFile('index.html');

    // Trigger application software update check right after window initializes
    mainWindow.once('ready-to-show', () => {
        autoUpdater.checkForUpdatesAndNotify();
    });
}

app.whenReady().then(createWindow);

/* -------------------------------------------------------------
   ELECTRON-BUILDER SOFTWARE AUTO-UPDATER EVENTS
------------------------------------------------------------- */
autoUpdater.on('checking-for-update', () => {
    if (mainWindow) mainWindow.webContents.send('download-status', 'CHECKING FOR CLIENT UPDATES...');
});

autoUpdater.on('update-available', () => {
    if (mainWindow) mainWindow.webContents.send('download-status', 'DOWNLOADING NEW LAUNCHER PATCH...');
});

autoUpdater.on('update-not-available', () => {
    if (mainWindow) mainWindow.webContents.send('download-status', 'SECURE INSTANCE READY');
});

autoUpdater.on('update-downloaded', () => {
    if (mainWindow) mainWindow.webContents.send('download-status', 'RESTARTING TO APPLY CLIENT PATCH...');
    setTimeout(() => {
        autoUpdater.quitAndInstall();
    }, 2500);
});

autoUpdater.on('error', () => {
    if (mainWindow) mainWindow.webContents.send('download-status', 'SECURE INSTANCE READY');
});

/* -------------------------------------------------------------
   TELEMETRY & USER CONFIGURATION HANDLERS
------------------------------------------------------------- */
ipcMain.on('get-advanced-stats', (event) => {
    const startTime = Date.now();
    
    query({ host: SERVERS.primary.host, port: parseInt(SERVERS.primary.port) }, function (error, response) {
        const latency = Date.now() - startTime;
        if (error) {
            event.reply('advanced-stats-response', { 
                status: "Offline", hostname: "AXION NETWORK", players: 0, maxplayers: 0, gamemode: "N/A", ping: 999, player_list: [] 
            });
        } else {
            let activeList = [];
            if (response.players && Array.isArray(response.players)) {
                activeList = response.players;
            } else if (response.player_list && Array.isArray(response.player_list)) {
                activeList = response.player_list;
            }

            event.reply('advanced-stats-response', {
                status: "Online",
                hostname: response.hostname || "AXION CITY",
                players: typeof response.players === 'number' ? response.players : activeList.length,
                maxplayers: response.maxplayers || 500,
                gamemode: response.gamemode || "AXRP1.6",
                ping: latency,
                player_list: activeList
            });
        }
    });
});

ipcMain.on('get-saved-settings', (event) => {
    event.reply('saved-settings-data', {
        gtaPath: store.get('gtaPath', ''),
        playerName: store.get('playerName', '')
    });
});

ipcMain.on('select-gta-path', async (event) => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: [{ name: 'GTA San Andreas Executable', extensions: ['exe'] }]
    });
    if (!result.canceled && result.filePaths.length > 0) {
        const selectedPath = result.filePaths[0];
        store.set('gtaPath', selectedPath);
        event.reply('path-updated', selectedPath);
    }
});

/* -------------------------------------------------------------
   SMART MODPACK CHECKER & GAME RUNTIME COUPLING
------------------------------------------------------------- */
ipcMain.on('launch-game', async (event, { gtaPath, playerName }) => {
    if (!gtaPath) return;
    store.set('playerName', playerName);

    const gtaDirectory = path.dirname(gtaPath);
    const assetsDirectory = path.join(gtaDirectory, 'models', 'assets');
    const tempZipLocation = path.join(gtaDirectory, 'temp_assets.zip');

    try {
        mainWindow.webContents.send('download-status', 'CHECKING MODPACK INTEGRITY...');
        
        // Query server headers to obtain remote validation variables (File Size / Last Modified Date)
        const remoteServerCheck = await axios.head(ASSET_ZIP_URL);
        const remoteIdentifier = remoteServerCheck.headers['content-length'] || remoteServerCheck.headers['last-modified'];
        
        const localSavedIdentifier = store.get('localModpackVersionHash', '');

        // Verify if directory structure stands intact along with matching version metadata
        if (fs.existsSync(assetsDirectory) && localSavedIdentifier === remoteIdentifier) {
            mainWindow.webContents.send('download-status', 'MODS VERIFIED. BOOTING GAME...');
            executeGameLaunch(gtaPath, playerName);
            return;
        }

        // Enforce structural folder baseline
        if (!fs.existsSync(assetsDirectory)) {
            fs.mkdirSync(assetsDirectory, { recursive: true });
        }

        mainWindow.webContents.send('download-status', 'DOWNLOADING ASSETS...');
        
        const response = await axios({
            method: 'GET',
            url: ASSET_ZIP_URL,
            responseType: 'stream'
        });

        const writer = fs.createWriteStream(tempZipLocation);
        response.data.pipe(writer);

        writer.on('finish', async () => {
            try {
                mainWindow.webContents.send('download-status', 'EXTRACTING MODS...');
                
                await extract(tempZipLocation, { dir: assetsDirectory });
                fs.unlinkSync(tempZipLocation);

                // Commit the downloaded unique asset version token to local disk configuration store
                if (remoteIdentifier) {
                    store.set('localModpackVersionHash', remoteIdentifier);
                }

                mainWindow.webContents.send('download-status', 'BOOTING GTA...');
                executeGameLaunch(gtaPath, playerName);
            } catch (err) {
                mainWindow.webContents.send('download-status', 'EXTRACTION ERROR');
                console.error(err);
            }
        });

    } catch (error) {
        // Fallback bypass directly to execution loop if offline or asset distribution link changes
        mainWindow.webContents.send('download-status', 'BYPASSING ASSETS LAYER...');
        executeGameLaunch(gtaPath, playerName);
    }
});

function executeGameLaunch(gtaPath, playerName) {
    const cleanGtaPath = gtaPath.replace(/\\/g, "\\\\");
    const regCmd1 = `reg add "HKCU\\Software\\SAMP" /v "PlayerName" /t REG_SZ /d "${playerName}" /f`;
    const regCmd2 = `reg add "HKCU\\Software\\SAMP" /v "gta_sa_exe" /t REG_SZ /d "${cleanGtaPath}" /f`;

    exec(`${regCmd1} && ${regCmd2}`, (regErr) => {
        const launchCommand = `"${gtaPath}" -c -h ${SERVERS.primary.host} -p ${SERVERS.primary.port} -n ${playerName}`;
        exec(launchCommand, { cwd: path.dirname(gtaPath) }, (error) => {
            if (!error) app.quit();
        });
    });
}

ipcMain.on('close-app', () => { app.quit(); });