// Runs in the app window before the page. It hands the page a few things only the desktop app can do.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('timelinesApp', {
  desktop: true,
  platform: process.platform,
  /** Opens the system file picker for audio and video files; resolves to a list of paths. */
  pickFiles: () => ipcRenderer.invoke('pick-files'),
  /** Opens the system folder picker; resolves to a list with one path, or an empty list. */
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  /** The path of a file dropped onto the window. */
  pathForFile: (file) => webUtils.getPathForFile(file),
});
