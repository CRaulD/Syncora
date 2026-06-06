# Política de Privacidade — Syncora

> Como o Syncora lida com seus dados. Última atualização: junho de 2026 — versão 0.1.0.

## Resumo

- ✅ Tudo é **local** — chaves e preferências ficam no seu PC
- ✅ Nenhum **telemetria** é enviada aos desenvolvedores
- ✅ Suas credenciais vão **direto** ao provedor (SubDL, OpenSubtitles, SubSource)
- ⚠️ Você é responsável por respeitar os termos de cada provedor

## 1. Dados armazenados localmente

O Syncora salva **no seu computador** (em `%LOCALAPPDATA%\Syncora\`):

| Dado | Onde | Por quê |
|---|---|---|
| API keys dos provedores | `%LOCALAPPDATA%\Syncora\config\*.json` | Para autenticar nos serviços configurados |
| Usuário/senha (opcional) | Mesmo local, em arquivo separado | Para validar conta em provedores que exigem |
| Preferências do app | Mesmo local | Tema, opções de download, fila |
| Cache de legendas | `%LOCALAPPDATA%\Syncora\runtime\` | Evitar redownload e acelerar retentativas |
| Dependências baixadas (ALASS, FFmpeg) | `%LOCALAPPDATA%\Syncora\runtime\` | Para funcionar offline após primeira execução |

Esses arquivos **nunca saem do seu PC** a não ser que você mesmo os compartilhe. Você pode apagá-los a qualquer momento desinstalando o app ou removendo a pasta `%LOCALAPPDATA%\Syncora\`.

## 2. Dados enviados a terceiros

O Syncora **não envia dados aos desenvolvedores**. Ele se comunica **diretamente** com os provedores que você configurou, **somente quando você usa o recurso correspondente**.

### SubDL
- **Enviado**: API key (header `Api-Key` / `X-API-Key`) + nome do arquivo/filme buscado + idioma
- **Finalidade**: buscar e baixar legendas

### OpenSubtitles
- **Enviado**: API key + (opcional) usuário e senha para login + nome do arquivo + idioma
- **Finalidade**: autenticar, buscar e baixar legendas
- **Token de sessão**: salvo localmente após login; revogável a qualquer momento pela sua conta no provedor

### SubSource
- **Enviado**: API key + parâmetros de busca
- **Finalidade**: buscar e baixar legendas

> Cada provedor tem **política de privacidade própria**. Recomendamos a leitura dos termos do provedor antes de configurar uma conta.

## 3. Telemetria

**O Syncora não coleta telemetria, métricas de uso, analytics ou qualquer dado de comportamento.**

Não há:

- Coleta de uso (quais recursos você usa, com que frequência)
- Rastreamento de erros remoto
- "Ligar para casa" com estatísticas
- Cookies ou identificadores únicos

## 4. Dependências externas

Na primeira execução (ou quando você baixa as dependências pelo app), o Syncora baixa binários de:

- **ALASS** — repositório oficial
- **FFmpeg / FFprobe** — sites/builds oficiais

Esses downloads usam HTTPS direto, sem proxy ou relay. Os endereços exatos estão no código-fonte aberto e podem ser auditados.

## 5. Permissões no Windows

O instalador do Syncora pode pedir para:

- Criar atalhos (menu Iniciar / área de trabalho)
- Adicionar entradas no menu de contexto do Explorer (botão direito em arquivos de vídeo)
- Criar arquivos em `%LOCALAPPDATA%\Syncora\`

O app **não** pede:

- Permissões de administrador (instala no `LocalAppData`)
- Acesso à internet sem ser via provedor configurado
- Acesso a dados fora da pasta de runtime

A integração com o menu do Explorer é **opcional** — você escolhe na hora da instalação (ou pode instalar/remover depois pelo próprio app).

## 6. Desinstalação

Ao desinstalar o Syncora:

- O app, atalhos e helper do Explorer são removidos
- A integração com o menu de contexto é removida automaticamente
- **Os dados locais (`%LOCALAPPDATA%\Syncora\`) NÃO são removidos por padrão** — apague manualmente se quiser uma limpeza total

## 7. Menores

O Syncora não é direcionado a menores de 13 anos. O uso por menores deve ser supervisionado por responsável, que deve garantir conformidade com as leis locais e com os termos dos provedores.

## 8. Alterações nesta política

Esta política pode ser atualizada. Mudanças relevantes virão com versões novas do Syncora. A versão atual do documento está indicada no topo.

## 9. Contato

Dúvidas sobre privacidade? Abra uma issue em [github.com/CRaulD/Syncora](https://github.com/CRaulD/Syncora/issues).
