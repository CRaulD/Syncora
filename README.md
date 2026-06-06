# Syncora

Syncora e um app desktop para encontrar, baixar e sincronizar legendas de arquivos de video.

## Recursos

- Escaneia uma pasta ou arquivos enviados pelo Explorer.
- Baixa legendas por provedores configurados.
- Sincroniza legendas com ALASS.
- Usa FFmpeg/FFprobe para embutir softsubs quando habilitado.
- Integra ao menu do Explorer com acoes para abrir, baixar legendas e baixar + sincronizar.

## Desenvolvimento

```powershell
npm install
npm run tauri:dev
```

O app tenta iniciar o backend local automaticamente na porta `8765`.

Para rodar o backend manualmente:

```powershell
cd backend
py -m pip install -r requirements.txt
py -m uvicorn server:app --host 127.0.0.1 --port 8765 --reload
```

## Dados locais

As chaves dos provedores e dependencias baixadas ficam fora do repositorio, em:

```text
%LOCALAPPDATA%\Syncora\runtime
```

Tambem e possivel definir outro local com a variavel:

```text
SYNCORA_RUNTIME_DIR
```

## Build

```powershell
npm run tauri:build
```

Os instaladores ficam em:

```text
src-tauri\target\release\bundle
```

## Instalador Inno Setup

O projeto tambem tem um script alternativo para gerar um instalador pelo Inno Setup:

```powershell
winget install JRSoftware.InnoSetup
npm run inno:build
```

O instalador Inno fica em:

```text
dist-installer
```

Esse caminho e opcional e nao substitui o instalador NSIS do Tauri.

## Licenca

MIT
