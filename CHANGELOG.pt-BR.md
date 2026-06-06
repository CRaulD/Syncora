# Changelog

Todas as mudanças notáveis neste projeto são documentadas aqui. O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o versionamento segue [Semantic Versioning](https://semver.org/lang/pt-BR/).

> 🌐 **Idioma:** [English](CHANGELOG.md) · **Português (BR)**

## [0.1.1-beta] - 2026-06-06

### Corrigido (follow-up: desinstalação + estado parcial)
- **Desinstalação agora sempre limpa o registro**, mesmo se a pasta de instalação sumiu. Antes, se a pasta de instalação era removida (ex.: por antivírus ou manualmente), as entradas em `HKCU\Software\Syncora` e `HKCU\...\Uninstall\Syncora` ficavam órfãs, fazendo o app aparecer como instalado em Configurações → Aplicativos sem como remover (o `UninstallString` apontava pra um `.exe` que não existia). `run_uninstall` agora sempre remove as chaves do registro, o marcador `.installed`, a pasta `runtime`, os atalhos da Área de Trabalho e Menu Iniciar, e a integração com o Explorer — só a remoção da pasta de instalação em si é condicional ao valor no registro.
- **`is_installed()` agora verifica que a pasta de instalação realmente existe**. Antes, a função retornava `true` sempre que o registro tinha uma entrada `InstallPath`, mesmo se o caminho tivesse sumido — fazendo o app principal abrir com backend quebrado em vez do wizard. Agora o wizard abre com a opção Reparar quando a instalação está nesse estado parcial.
- **Botão "Abrir o Syncora" na tela final do instalador não fazia nada**. O `setup()` criava só UMA janela: a principal se já instalado, senão o wizard. Depois que a instalação terminava, a janela principal nunca tinha sido criada, então `launch_main_app()` chamava `main_win.show()` numa janela inexistente e não acontecia nada. Agora `launch_main_app()` cria a janela principal (e inicia o backend) quando ela está faltando.
- **Status da integração com Explorer sempre mostrava "parcial" mesmo após instalação nova**. O `fs::write` dos atalhos do SendTo usava `let _ = ...`, que engolia erros de permissão silenciosamente. Se o usuário não tinha acesso de escrita em `%APPDATA%\Microsoft\Windows\SendTo`, os wrappers eram criados mas os atalhos não, e a checagem de status (que olha os dois) reportava "parcial" para sempre. Agora o erro é logado, e a mensagem de status diz especificamente qual parte está faltando (`missingShortcutsMessage` ou `missingWrappersMessage`) em vez de um "parcial" genérico.
- **Menu do Explorer não instalava durante o wizard mesmo marcado**. O helper `syncora-open.exe` é embutido no instalador via `include_bytes!` e só é extraído para a pasta de instalação durante o `copy_app_files`. Mas `current_helper_exe()` procurava o helper apenas ao lado do executável atual (o instalador, não a cópia instalada), então nunca era encontrado na primeira instalação. Adicionado `installed_path_from_registry()` que lê `HKCU\Software\Syncora\InstallPath` (definido por `mark_as_installed` antes do explorer ser instalado) e verifica o helper lá como fallback final.

### Adicionado (follow-up: opção de reparo no wizard)
- **Opção "Reparar instalação" no assistente**. Quando o registro tem um `InstallPath` mas a pasta sumiu, o wizard mostra uma tela dedicada com o caminho registrado e dois botões: **Reparar** (reinstalar no mesmo caminho, baixar todas as dependências de novo) e **Instalação nova** (seguir o fluxo normal de instalação do zero). A tela de Reparo é traduzida em pt-BR, en e es.
- **Comando Tauri `get_install_state`** que retorna `fresh`, `partial { path }` ou `complete`, para o wizard detectar o estado parcial e oferecer a ação certa.
- **Mensagens de status da integração com Explorer agora são traduzidas** em pt-BR, en e es (antes ficavam hardcoded em PT-BR).



### Corrigido
- **Bug crítico na `v0.1.0-beta`**: o instalador nunca copiava `syncora-backend.exe`, `syncora-open.exe` nem os ícones para a pasta de instalação. O assistente terminava com sucesso, mas na primeira execução o app mostrava "Backend offline" porque o backend, helper e ícones nunca tinham sido instalados. A nova build embarca tudo dentro do `syncora.exe` via `include_bytes!` e grava na pasta de instalação na hora de instalar, então eles estão sempre lá.

### Adicionado
- **Embed single-binary** do backend, helper do Explorer e todos os ícones. O `syncora.exe` não depende mais do `bundle.resources` estar no caminho certo; tudo viaja dentro do binário.
- **Download na instalação** das duas dependências externas, com fallback gracioso se a rede estiver offline:
  - **ALASS** (CLI de resync de legendas, ~26 MB) de `github.com/kaegi/alass/releases/download/v2.0.0/alass-windows64.zip`.
  - **FFmpeg + FFprobe** (~88 MB) de `github.com/BtbN/FFmpeg-Builds/releases/latest/ffmpeg-master-latest-win64-lgpl-shared.zip`.
  - Os dois são baixados direto para `%LOCALAPPDATA%\Syncora\runtime\` e um `manifest.json` é gravado pra o app poder detectar e atualizar depois.
- **Progresso de instalação em 10 etapas** com progresso de download a nível de bytes (ex. "13 MB / 26 MB") para o assistente não parecer travado em downloads grandes. Todos os rótulos de etapa são traduzidos em pt-BR, en e es.
- **Segurança de reinstalação**: `run_install` agora mata qualquer processo `syncora`, `syncora-backend` ou `syncora-open` em execução antes de sobrescrever arquivos, eliminando o `os error 32` quando o usuário tenta reinstalar com a build anterior ainda aberta.
- **Manifest** em `%LOCALAPPDATA%\Syncora\runtime\manifest.json` registra versão, caminho de instalação e instalador de cada dependência.

### Mudado
- **Build script** (`npm run build:syncora`) agora compila o helper Rust (`syncora-open.exe`) antes do `tauri build` principal, para que `include_bytes!("../target/release/syncora-open.exe")` resolva na hora do build.
- **Desinstalação** agora também remove `%LOCALAPPDATA%\Syncora\runtime\` (o ALASS + FFmpeg + manifest baixados), não deixando arquivos para trás.
- **Descoberta do backend**: `find_backend_exe` agora tenta `exe_dir/backend/syncora-backend.exe` primeiro, então o layout de instalação embarcado é encontrado sem nenhuma mexida em ambiente.

### Corrigido
- **Botão "Remover" do Explorer sempre desabilitado**: a condição de `disabled` checava um estado busy `"uninstall"` que não existia, então o botão nunca era clicável. Agora checa `explorerBusy !== "idle"` corretamente e funciona como deveria.
- **Progresso de instalação travado no download**: o fluxo antigo de 4 etapas não tinha atualização por bytes durante downloads, fazendo a barra parecer congelada; o novo fluxo emite progresso em chunks de 64 KB.

## [0.1.0-beta] - 2026-06-06

### Added
- **Instalador único Tauri (`syncora.exe`)** que substitui o instalador Inno Setup. O mesmo binário é o assistente de instalação e o app principal; detecta primeira execução via arquivo `.installed` em `%LOCALAPPDATA%\app.syncora.desktop\`.
- **Assistente de instalação em 4 passos**: Termos de Uso (aceite obrigatório), Preparar (caminho + opções), Instalar (progresso com etapa e percentual) e Concluir (abre o app).
- **Validação de caminho** antes de instalar (comprimento, caracteres inválidos, pastas do sistema, permissão de escrita, existência do pai).
- **Instalação por usuário** (HKCU + `%LOCALAPPDATA%\Programs\Syncora` por padrão) sem prompt de UAC, com atalhos na Área de Trabalho e Menu Iniciar.
- **Desinstalação robusta** via `syncora.exe --uninstall` (registrada no Adicionar/Remover Programas): spawna PowerShell oculto que mata processos em execução e remove pasta de instalação, marcador `.installed`, chaves de registro e atalhos.
- **Verificador de atualizações** integrado que consulta `api.github.com/repos/CRaulD/Syncora/releases/latest` no startup (com delay de 1.5s) e em verificação manual. Cache de 24h para respeitar o rate limit do GitHub (60 req/h).
- **Toast amber não-bloqueante** no canto inferior direito quando há atualização disponível, com botão "Baixar" que abre a release page no navegador.
- **Seção "Atualizações"** na aba Configuração com versão atual, timestamp da última checagem e botão "Verificar agora".
- **Internacionalização** (i18n) completa em **pt-BR**, **en** e **es** para instalador, assistente, app principal e mensagens de atualização.
- **Ícones do app** agora incluídos como recursos Tauri (`icons/` em `bundle.resources`), copiados para a pasta de instalação e usados em atalhos e registro.
- **Helper de contexto do Explorer** (`syncora-open.exe`) empacotado e instalado, com menu em 3 idiomas (PT/EN/ES) instalado por padrão no registro HKCU.

### Changed
- **Identificador interno** do Cargo package renomeado de `app` para `syncora`, e o binário de `app.exe` para `syncora.exe` para refletir o `productName`.
- **Build script** atualizado: `npm run build:syncora` agora usa `tauri build --no-bundle` para gerar o `.exe` único com frontend e backend embarcados.
- **Capability `shell:default`** adicionada para permitir abertura de URLs externas (release page do GitHub).
- **`tauri.conf.json`**: `windows: []` (as janelas são criadas em código conforme o estado de instalação) e `icons/` em `bundle.resources`.

### Removed
- Script `scripts/generate-nsis-assets.mjs` (gerador de bitmaps NSIS).
- `src-tauri/installer/syncora-inno.iss` (script Inno Setup).
- `src-tauri/installer/syncora-installer.nsi` (template NSIS).
- `src-tauri/installer/nsis-header.bmp` e `nsis-sidebar.bmp` (bitmaps NSIS).
- `docs/installer-tauri-plan.md` (plano original, superado pela implementação).
- Comando `npm run inno:build` (substituído por `build:syncora`).

### Fixed
- **File lock no build**: `cargo` falhava com `os error 32` quando `syncora.exe` ainda estava rodando; agora o build embede corretamente os recursos.
- **Desinstalação incompleta**: o instalador antigo deixava o marcador `.installed` e a pasta de instalação após `fs::remove_dir_all` falhar por arquivos em uso; nova versão mata os processos antes de remover.
- **Ícones nos atalhos**: ícones não eram copiados para a pasta de instalação porque não estavam em `bundle.resources`; agora são incluídos e ficam disponíveis para `IconLocation` do `.lnk` e `DisplayIcon` do registro.

### Security
- **Desinstalador verificado**: usa spawn de PowerShell com `CREATE_NO_WINDOW` (sem janela visível) e comandos `-NoProfile -ExecutionPolicy Bypass`.
- **Validação de caminho** contra list-prefix de pastas protegidas (`C:\Windows`, `C:\Program Files`, `C:\ProgramData`, etc.).

[0.1.0-beta]: https://github.com/CRaulD/Syncora/releases/tag/v0.1.0-beta
