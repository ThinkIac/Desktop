import { app, Notification, shell } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'

export const CLOUD_BASE = 'https://thinkiac.cloud/view/auth/Login'
export const PROTOCOLO = 'thinkiac'
export const isCloudUrl = (url) => {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && !parsed.port
      && (parsed.hostname === 'thinkiac.cloud' || parsed.hostname.endsWith('.thinkiac.cloud'))
  } catch {
    return false
  }
}

export function createCloudIntegration({ focusCloud }) {
  // ─── appId único por instalação ────────────────────────────────────────────────
  // Gerado uma vez na primeira execução, persistido em userData, e reutilizado
  // sempre. É o MESMO valor usado como topic do ntfy e anexado à URL (?appId=).
  let appId = obterOuCriarAppId()

  function getAppIdPath() {
    return path.join(app.getPath('userData'), 'app-id.json')
  }

  function gerarAppId() {
    // 32 chars de um alfabeto de 62 símbolos — impraticável de adivinhar.
    // Charset compatível com topic do ntfy ([A-Za-z0-9]).
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    let id = ''
    for (let i = 0; i < 32; i++) id += chars[crypto.randomInt(chars.length)]
    return id
  }

  function obterOuCriarAppId() {
    const file = getAppIdPath()
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')).appId
      if (typeof saved === 'string' && saved.length === 32) return saved
    } catch {
      // arquivo ausente/corrompido — gera abaixo
    }
    const id = gerarAppId()
    try {
      fs.writeFileSync(file, JSON.stringify({ appId: id }))
    } catch (e) {
      console.warn('Não foi possível persistir o appId:', e.message)
    }
    return id
  }

  // URL base sempre com ?appId=<id> (mesmo valor do topic do ntfy).
  function urlBase() {
    return `${CLOUD_BASE}?appId=${appId}`
  }

  // ─── Login com Google ──────────────────────────────────────────────────────────
  //
  // O Google recusa OAuth em navegador embutido — e um BrowserWindow do Electron
  // é tratado como tal (403 disallowed_useragent). Então o consentimento sai para
  // o navegador padrão do sistema, e a sessão volta por deep link.
  //
  // O navegador do sistema tem cookie jar próprio, separado do desta janela: o
  // cookie que o callback gravasse lá não serviria de nada aqui. Por isso o
  // backend, para client=electron, devolve um LoginTicket de uso único em
  // thinkiac://open/auth?ticket=… — e nós o trocamos por sessão carregando
  // /auth/ticket nesta janela, numa navegação top-level normal.
  //
  // Mesmo desenho já usado no app Flutter (apps/mobile/lib/main.dart).

  const GATEWAY_HOST = 'thinkiac.cloud'
  const HOSTS_DE_CONSENTIMENTO = new Set(['accounts.google.com', 'oauth2.googleapis.com'])

  function ehUrlDeOauth(rawUrl) {
    let u
    try {
      u = new URL(rawUrl)
    } catch {
      return false
    }
    if (u.protocol !== 'https:') return false
    if (HOSTS_DE_CONSENTIMENTO.has(u.hostname)) return true
    // O início do fluxo também sai daqui: se deixássemos esta janela seguir o
    // 302 do /auth/google/start, ela cairia em accounts.google.com por dentro.
    return u.hostname === GATEWAY_HOST && u.pathname === '/auth/google/start'
  }

  // Registra o app como dono de thinkiac://. Em dev (electron .) o executável é
  // o próprio binário do Electron, então é preciso passar argv explicitamente —
  // senão o SO tentaria reabrir o Electron sem o caminho do projeto.
  function registrarProtocolo() {
    try {
      if (process.defaultApp && process.argv.length >= 2) {
        app.setAsDefaultProtocolClient(PROTOCOLO, process.execPath, [path.resolve(process.argv[1])])
      } else {
        app.setAsDefaultProtocolClient(PROTOCOLO)
      }
    } catch (e) {
      console.warn('Não foi possível registrar o protocolo thinkiac://:', e.message)
    }
  }

  // thinkiac://open/auth?ticket=…&next=… → carrega /auth/ticket na janela.
  function tratarDeepLink(rawUrl) {
    let u
    try {
      u = new URL(rawUrl)
    } catch {
      return false
    }
    if (u.protocol !== `${PROTOCOLO}:`) return false
    if (u.hostname !== 'open' || u.pathname !== '/auth') return false

    const ticket = u.searchParams.get('ticket')
    if (!ticket) return false

    const destino = new URL(`https://${GATEWAY_HOST}/auth/ticket`)
    destino.searchParams.set('ticket', ticket)
    const next = u.searchParams.get('next')
    // Só caminho relativo; o backend revalida de qualquer forma.
    if (next && next.startsWith('/') && !next.startsWith('//')) {
      destino.searchParams.set('next', next)
    }

    focusCloud(destino.href)
    return true
  }

  // No Windows/Linux o deep link chega como argumento de linha de comando (na
  // primeira instância, em process.argv; nas seguintes, via second-instance).
  function deepLinkDeArgv(argv) {
    return (argv || []).find((a) => typeof a === 'string' && a.startsWith(`${PROTOCOLO}://`)) || null
  }

  // Impede que ESTA janela navegue para o consentimento; manda para fora.
  function instalarInterceptacaoDeOauth(win) {
    win.webContents.on('will-navigate', (event, url) => {
      if (!ehUrlDeOauth(url)) return
      event.preventDefault()
      shell.openExternal(url).catch((e) => console.warn('Falha ao abrir navegador:', e.message))
    })

    // Só o OAuth é desviado. O resto mantém o comportamento de sempre — o SSO
    // manda o usuário para <slug>.thinkiac.cloud, e bloquear isso quebraria o
    // acesso à instância do tenant.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (ehUrlDeOauth(url)) {
        shell.openExternal(url).catch(() => {})
        return { action: 'deny' }
      }
      return { action: 'allow' }
    })
  }

  // ─── Notificações via ntfy (SSE) ────────────────────────────────────────────────
  // Escuta o ntfy em tempo real por Server-Sent Events e dispara notificações
  // nativas. Ao clicar, faz deep-link dos `extras` na janela. Portado do
  // NtfySSEHandler do apps/mobile (worktree online).

  const NTFY_BASE = 'https://ntfy.sh'
  let ntfyController = null
  let ntfyReconnectTimer = null
  let ntfyClosed = false

  function startNtfy() {
    ntfyClosed = false
    conectarNtfy()
  }

  function stopNtfy() {
    ntfyClosed = true
    if (ntfyReconnectTimer) {
      clearTimeout(ntfyReconnectTimer)
      ntfyReconnectTimer = null
    }
    if (ntfyController) {
      ntfyController.abort()
      ntfyController = null
    }
  }

  function agendarReconexao() {
    if (ntfyClosed || ntfyReconnectTimer) return
    ntfyReconnectTimer = setTimeout(() => {
      ntfyReconnectTimer = null
      conectarNtfy()
    }, 5000)
  }

  async function conectarNtfy() {
    if (ntfyClosed) return
    const since = Math.floor(Date.now() / 1000)
    const url = `${NTFY_BASE}/${appId}/sse?since=${since}`
    ntfyController = new AbortController()

    try {

      const res = await fetch(url, { signal: ntfyController.signal })
      if (!res.ok || !res.body) {
        console.error('❌ SSE retornou status', res.status)
        agendarReconexao()
        return
      }
      console.log('✅ SSE conectado')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let eventData = ''

      // Loop de leitura do stream, quebrando em linhas (protocolo SSE).
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        let idx
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const linha = buffer.slice(0, idx).replace(/\r$/, '')
          buffer = buffer.slice(idx + 1)

          if (linha.startsWith('data:')) {
            eventData = linha.slice(5).trim()
          } else if (linha === '' && eventData) {
            processarEvento(eventData)
            eventData = ''
          }
        }
      }
      console.log('🔌 SSE encerrado pelo servidor')
      agendarReconexao()
    } catch (e) {
      if (ntfyClosed || e.name === 'AbortError') return
      console.error('❌ Falha no SSE:', e.message)
      agendarReconexao()
    }
  }

  function processarEvento(jsonStr) {
    try {
      const msg = JSON.parse(jsonStr)
      // ntfy envia "keepalive" periodicamente — ignoramos.
      if (msg.event !== 'message') return

      const title = typeof msg.title === 'string' ? msg.title : 'ThinkIac'
      const body = typeof msg.message === 'string' ? msg.message : ''
      const extras = msg.extras && typeof msg.extras === 'object' ? msg.extras : null

      // Monta query string com os extras para deep-link no WebView.
      // Ex.: extras {open: "whatsapp"} → "open=whatsapp"
      const payload = extras
        ? Object.entries(extras)
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
            .join('&')
        : ''

      console.log('📨 ntfy | título:', title, '| payload:', payload)

      if (!Notification.isSupported()) return
      const n = new Notification({ title, body })
      n.on('click', () => {
        const url = payload ? `${urlBase()}&${payload}` : urlBase()
        focusCloud(url)
      })
      n.show()
    } catch (e) {
      console.warn('⚠️ Erro ao processar evento SSE:', e.message)
    }
  }

  return { urlBase, registrarProtocolo, tratarDeepLink, deepLinkDeArgv, instalarInterceptacaoDeOauth, startNtfy, stopNtfy }
}
