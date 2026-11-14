# ThinkIac Desktop

Bootstrap Electron para o Runtime publicado em `ThinkIac/ThinkIac`.

Na primeira execução, o aplicativo consulta a release mais recente que contém
`runtime-manifest.json`, baixa o ZIP indicado, valida o SHA-256, extrai em
`%LOCALAPPDATA%/ThinkIac/local/runtime/<versão>`, que já inclui `node.exe` e as
dependências de produção para Windows, e inicia o Runtime em uma porta livre de
`127.0.0.1`. A janela então carrega o
endereço local. Não há clone de Git nem execução direta da branch `main`.

O estado persistente fica fora do diretório extraído, em
`%LOCALAPPDATA%/ThinkIac/local/data`.

## Desenvolvimento

```bash
npm ci
npm start
```

## Windows

Cada push em `main` executa a validação e publica uma GitHub Release prévia com
`ThinkIac-<versão>-win-x64.exe` como asset baixável. O aplicativo consome a
release mais recente do Runtime para Windows, sem clone de Git ou instalação npm
no computador do usuário.
