# ThinkIac Desktop

O ThinkIac Desktop abre no **Cloud**. O primeiro botão da barra da janela e
o primeiro item do menu **Window** alternam entre Cloud e Local. O atalho é
`Ctrl+Shift+L` no Windows e `⌘⇧L` no macOS. O modo anterior guarda a página
e a sessão enquanto o aplicativo está aberto.

O executável Windows x64 inclui o ZIP do runtime local, com `node.exe` e as
dependências. Na primeira troca para Local, o aplicativo verifica o SHA-256 e
extrai o ZIP em `<userData>/local/runtime/<versão>`. As próximas aberturas usam
essa instalação. Os bancos gerenciados pelo Lógos ficam em
`<userData>/local/data/db`.

## Integração com views

O preload fornece `window.thinkiacDesktop.mode` e
`window.switchMode(mode?)` para a página principal de uma origem ThinkIac
autorizada. Use `'local'` ou `'cloud'` para pedir um destino explícito. Sem
argumento, a função alterna o modo. O retorno é uma promessa que resolve para
`true` quando o destino está ativo e `false` quando a troca falha ou a
solicitação é recusada.

Em uma view Svelte renderizada pelo Lógos, detecte a ponte em `onMount` e
chame a ação no handler do botão:

```svelte
<script>
  import { onMount } from 'svelte';
  let canOpenLocal = false;

  onMount(() => {
    canOpenLocal = window.thinkiacDesktop?.mode === 'cloud'
      && typeof window.switchMode === 'function';
  });
</script>

{#if canOpenLocal}
  <button on:click={() => window.switchMode?.('local')}>Abrir modo local</button>
{/if}
```

## Desenvolvimento

```bash
npm ci
npm start
```

Em desenvolvimento no Windows x64, o Electron reutiliza uma instalação validada
ou baixa uma release compatível. Para usar um runtime de desenvolvimento já
iniciado, aponte `THINKIAC_DESKTOP_LOCAL_URL` para sua origem HTTP em
`127.0.0.1` com porta explícita. Ele deve responder a `GET /__ready`.

## Windows

O workflow **Build Windows** incorpora uma release compatível, verifica o
checksum e publica `ThinkIac-<versão>-win-x64.exe` em uma pré-release. Em Windows
x64, o mesmo build pode ser executado com:

```bash
npm ci
node scripts/prepare-runtime-bundle.mjs runtime-bundle
npm run build:win
```
