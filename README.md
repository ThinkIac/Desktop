# ThinkIac Desktop

Bootstrap Electron para o Runtime publicado em `ThinkIac/ThinkIac`.

Na primeira execução, o aplicativo consulta a release mais recente que contém
`runtime-manifest.json`, baixa o ZIP indicado, valida o SHA-256, extrai em
`%LOCALAPPDATA%/ThinkIac/local/runtime/<versão>`, instala dependências de produção
e inicia o Runtime em uma porta livre de `127.0.0.1`. A janela então carrega o
endereço local. Não há clone de Git nem execução direta da branch `main`.

O estado persistente fica fora do diretório extraído, em
`%LOCALAPPDATA%/ThinkIac/local/data`.

## Desenvolvimento

```bash
npm ci
npm start
```

## Windows

Cada push em `main` executa a validação e anexa `ThinkIac-<versão>-win-x64.exe`
como artefato do workflow **Build Windows**. Para distribuição pública, use uma
tag e uma GitHub Release em uma evolução posterior.

## Limitação atual do Runtime

O ZIP atual do Runtime não contém `node_modules`. Por isso a primeira abertura
instala dependências de produção para a versão do Electron empacotada e precisa
de acesso ao registro npm. O próximo passo no `ThinkIac/ThinkIac` é publicar um
asset Windows com dependências já preparadas; quando existir, este bootstrap pode
trocar a instalação pelo download desse asset.
