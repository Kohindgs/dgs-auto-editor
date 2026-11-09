const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('dgsDesktop', {
  pickProjectFile: () => ipcRenderer.invoke('pick-project-file'),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || ''
    } catch {
      return ''
    }
  },
})

window.addEventListener('DOMContentLoaded', () => {
  document.title = 'DGS Auto Editor Beta'
})
