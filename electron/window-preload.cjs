const { contextBridge, ipcRenderer } = require('electron');

const mode = process.argv.includes('--thinkiac-mode=local') ? 'local' : 'cloud';
const origin = process.argv.find((value) => value.startsWith('--thinkiac-local-origin='))?.split('=')[1];
const trusted = mode === 'local'
  ? location.origin === origin
  : location.protocol === 'https:' && !location.port
    && (location.hostname === 'thinkiac.cloud' || location.hostname.endsWith('.thinkiac.cloud'));

if (process.isMainFrame && trusted) {
  const switchMode = (target) => ipcRenderer.invoke('thinkiac:switch-mode', target);
  contextBridge.exposeInMainWorld('thinkiacDesktop', { mode, switchMode });
  contextBridge.exposeInMainWorld('switchMode', switchMode);
}


window.addEventListener('DOMContentLoaded', () => {
  if (!process.isMainFrame || !trusted) return;
  const style = document.createElement('style');
  style.textContent = `
    .win-hub {
      position: fixed;
      top: 10px;
      right: 10px;
      z-index: 999999;
      display: flex;
      align-items: center;
      gap: 3px;
      color-scheme: light dark;
      color: var(--tk-text, CanvasText);
      background: var(--tk-surface, Canvas);
      border: 1px solid var(--tk-border, color-mix(in srgb, CanvasText 14%, transparent));
      border-radius: var(--tk-radius-md, 8px);
      padding: 3px 5px;
      font-family: var(--tk-font, Ubuntu, system-ui, sans-serif);
    }
    .hub-drag {
      display: flex;
      align-items: center;
      padding: 0 3px;
      cursor: grab;
      color: inherit;
      opacity: .35;
      -webkit-app-region: drag;
      transition: opacity 200ms ease-out;
    }
    .hub-drag:hover { opacity: .7; }
    .hub-sep {
      width: 1px;
      height: 12px;
      background: var(--tk-border, color-mix(in srgb, CanvasText 14%, transparent));
      margin: 0 1px;
    }
    .hub-btn {
      background: transparent;
      border: none;
      width: 22px;
      height: 22px;
      border-radius: 5px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: inherit;
      opacity: .72;
      cursor: pointer;
      transition: opacity 200ms ease-out;
      -webkit-app-region: no-drag;
    }
    .hub-btn.mode-action { width: auto; gap: 5px; padding: 0 6px; color: inherit; font-size: 11px; }
    .hub-btn.mode-action svg { width: 14px; height: 14px; }
    .hub-btn.mode-action:disabled { opacity: .5; }
    .hub-btn:hover {
      background: var(--tk-surface-2, color-mix(in srgb, CanvasText 8%, Canvas));
      opacity: 1;
    }
    .hub-btn:disabled {
      opacity: .4;
      cursor: not-allowed;
    }
    .hub-btn:disabled:hover {
      background: transparent;
      opacity: .4;
    }
    .hub-btn.close-action:hover {
      background: var(--tk-surface-2, color-mix(in srgb, CanvasText 8%, Canvas));
    }
    .hub-btn.pinned {
      background: var(--tk-accent, CanvasText);
      color: var(--tk-on-accent, Canvas);
      opacity: 1;
    }
    .hub-btn.pinned:hover { opacity: .82; }
  `;
  document.head.appendChild(style);

  const hub = document.createElement('div');
  hub.className = 'win-hub';
  hub.innerHTML = `
    <div class="hub-drag">
      <svg width="8" height="12" viewBox="0 0 8 12" fill="none">
        <circle cx="2.5" cy="2.5" r="1" fill="currentColor"/>
        <circle cx="5.5" cy="2.5" r="1" fill="currentColor"/>
        <circle cx="2.5" cy="6" r="1" fill="currentColor"/>
        <circle cx="5.5" cy="6" r="1" fill="currentColor"/>
        <circle cx="2.5" cy="9.5" r="1" fill="currentColor"/>
        <circle cx="5.5" cy="9.5" r="1" fill="currentColor"/>
      </svg>
    </div>
    <div class="hub-sep"></div>
    <button class="hub-btn mode-action" id="zero-mode" type="button">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
        ${mode === 'cloud'
          ? '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>'
          : '<path d="M7 18h11a4 4 0 0 0 .5-8A6 6 0 0 0 7 10a4 4 0 0 0 0 8Z"/>'}
      </svg>
      ${mode === 'cloud' ? 'Local' : 'Cloud'}
    </button>
    <button class="hub-btn" id="zero-pin" title="Fixar no topo">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
        <path d="M9 4h6l-1 6 3 3v2H7v-2l3-3-1-6z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
        <line x1="12" y1="17" x2="12" y2="21" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
      </svg>
    </button>
    <button class="hub-btn" id="zero-minimize" title="Minimizar">
      <svg width="10" height="1" viewBox="0 0 10 1" fill="none">
        <line y1="0.5" x2="10" y2="0.5" stroke="currentColor" stroke-width="1.5"/>
      </svg>
    </button>
    <button class="hub-btn" id="zero-maximize" title="Maximizar">
      <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
        <rect x="0.75" y="0.75" width="7.5" height="7.5" rx="1.5" stroke="currentColor" stroke-width="1.1"/>
      </svg>
    </button>
    <button class="hub-btn close-action" id="zero-close" title="Fechar">
      <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
        <path d="M1 1L8 8M8 1L1 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
      </svg>
    </button>
  `;

  document.body.appendChild(hub);
  const modeButton = hub.querySelector('#zero-mode');
  modeButton.title = mode === 'cloud' ? 'Mudar para o modo local' : 'Mudar para o Cloud';
  modeButton.addEventListener('click', async () => {
    modeButton.disabled = true;
    try {
      await ipcRenderer.invoke('thinkiac:switch-mode');
    } catch (error) {
      console.error(error);
    } finally {
      modeButton.disabled = false;
    }
  });

  const btnPin = document.getElementById('zero-pin');
  const updatePin = (pinned) => {
    btnPin.classList.toggle('pinned', pinned);
    btnPin.title = pinned ? 'Desafixar' : 'Fixar no topo';
  };
  ipcRenderer.invoke('win-get-pin').then(updatePin).catch(console.error);
  btnPin.addEventListener('click', async () => {
    try {
      updatePin(await ipcRenderer.invoke('win-toggle-pin'));
    } catch (error) {
      console.error(error);
    }
  });

  document.getElementById('zero-minimize').addEventListener('click', () => ipcRenderer.send('win-minimize'));
  document.getElementById('zero-maximize').addEventListener('click', () => ipcRenderer.send('win-maximize'));
  document.getElementById('zero-close').addEventListener('click', () => ipcRenderer.send('win-close'));
});