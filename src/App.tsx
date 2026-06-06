import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

type BaseStatus = "OK" | "PULADO" | "FALHOU" | "PENDENTE" | "SEM_LEGENDA";
type DisplayStatus = BaseStatus | "PRONTO";
type Phase = "empty" | "scanned" | "synced";
type Filter = "all" | "ready" | "ok" | "skip" | "fail" | "pending";
type ProviderId = "subdl" | "subliminal" | "opensubtitles" | "subsource";
type Theme = "light" | "dark";
type LaunchAction = "queue" | "download" | "download-sync";
type SyncPauseState = "running" | "pausing" | "paused" | "cancelling";

type ExplorerIntegrationStatus = {
  installed: boolean;
  helper_path: string;
  wrapper_dir: string;
  send_to_dir: string;
  message: string;
};

type ProviderConfig = {
  enabled: boolean;
  priority: number;
  configured: boolean;
  has_api_key: boolean;
  api_key_masked: string;
  has_username?: boolean;
  has_password?: boolean;
  account_connected?: boolean;
  account_info?: {
    username?: string;
    allowed_downloads?: number | string;
    downloads_count?: number | string;
    downloads_remaining?: number | string;
    vip?: boolean | string;
  };
  last_test_ok?: boolean | null;
  last_test_error?: string;
  last_download_ok?: boolean | null;
  last_download_error?: string;
  username?: string;
};

type Row = {
  status: BaseStatus;
  video: string;
  path: string;
  subtitle: string;
  subtitleMeta: string;
  output: string;
  outputPath: string;
  detail: string;
  subdetail: string;
  video_full?: string;
};

type LiveRowProgress = {
  stage: string;
  percent: number;
  subtitle: string;
  tone: "run" | "ok" | "fail" | "idle";
};

type SavedConfig = {
  sourceDir: string;
  outputDir: string;
  language: string;
  ignoreEmbedded: boolean;
  autoDownloadMissing: boolean;
  syncAfterDownload: boolean;
  preserveFolders: boolean;
  embedSoftsub: boolean;
  updateOriginal: boolean;
  forceDownload: boolean;
  forceResync: boolean;
  keepBak: boolean;
  subtitleDefault: boolean;
  subtitleTrack: string;
  timeoutSeconds: number;
  retries: number;
};

const defaultConfig: SavedConfig = {
  sourceDir: "",
  outputDir: "",
  language: "pt-BR",
  ignoreEmbedded: true,
  autoDownloadMissing: true,
  syncAfterDownload: true,
  preserveFolders: true,
  embedSoftsub: false,
  updateOriginal: true,
  forceDownload: false,
  forceResync: false,
  keepBak: true,
  subtitleDefault: true,
  subtitleTrack: "Portuguese (Sync)",
  timeoutSeconds: 900,
  retries: 1,
};

function loadConfig(): SavedConfig {
  try {
    const raw = window.localStorage.getItem("synclegendas-config");
    if (!raw) return defaultConfig;
    const parsed = { ...defaultConfig, ...JSON.parse(raw) };
    parsed.updateOriginal = true;
    if (parsed.sourceDir === "D:\\Series" && parsed.outputDir === "D:\\Series\\_LEGENDAS_SYNC") {
      parsed.sourceDir = "";
      parsed.outputDir = "";
    }
    return parsed;
  } catch {
    return defaultConfig;
  }
}

function asText(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v);
}

function normalizeRow(raw: Record<string, unknown> | null | undefined): Row {
  return {
    status: (raw?.status || raw?.state || "PENDENTE") as BaseStatus,
    video: asText(raw?.video || raw?.video_name || raw?.filename || raw?.name || raw?.file || raw?.video_file),
    path: asText(raw?.path || raw?.video_path || raw?.full_path || raw?.input_path),
    subtitle: asText(raw?.subtitle || raw?.subtitle_file || raw?.subtitle_name || raw?.subtitle_path),
    subtitleMeta: asText(raw?.subtitleMeta || raw?.subtitle_meta || raw?.subtitle_info || raw?.subtitle_detail),
    output: asText(raw?.output || raw?.output_file || raw?.synced || raw?.target_file),
    outputPath: asText(raw?.outputPath || raw?.output_path || raw?.target_path),
    detail: asText(raw?.detail || raw?.message || raw?.reason || raw?.result),
    subdetail: asText(raw?.subdetail || raw?.info || raw?.extra || raw?.debug),
    video_full: asText(raw?.video_full || raw?.video_path || raw?.path || raw?.input_path),
  };
}

function getDisplayStatus(row: Row, phase: Phase): DisplayStatus {
  if (phase === "scanned" && row.status === "PENDENTE") return "PRONTO";
  return row.status;
}

function cleanMessage(value: unknown): string {
  return asText(value)
    .replace(/^Error:\s*/i, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function friendlyError(value: unknown, fallback = "Não foi possível concluir a ação."): string {
  const raw = cleanMessage(value);
  if (!raw) return fallback;

  const lower = raw.toLowerCase();
  if (/backend offline|failed to fetch|networkerror|fetch failed/.test(lower)) {
    return "Backend offline. Inicie o servidor local na porta 8765.";
  }
  if (lower.includes("pasta origem") && lower.includes("existe")) {
    return "Pasta origem não existe. Confira o caminho selecionado.";
  }
  if (lower.includes("caminho") && lower.includes("existe")) {
    return "Caminho não existe. Confira a pasta ou o arquivo.";
  }
  if (lower.includes("alass") && lower.includes("não encontrado")) {
    return "ALASS não encontrado. Baixe as dependências na aba Configuração.";
  }
  if (lower.includes("ffmpeg") && lower.includes("não encontrado")) {
    return "FFmpeg não encontrado. Baixe as dependências na aba Configuração.";
  }
  if (lower.includes("ffprobe") && lower.includes("não encontrado")) {
    return "FFprobe não encontrado. Baixe as dependências na aba Configuração.";
  }
  if (lower.includes("api key do subdl recusada") || (lower.includes("subdl") && lower.includes("403")) || lower.includes("not authorized")) {
    return "API key do SubDL inválida ou sem permissão. Gere uma chave nova no SubDL.";
  }
  if (lower.includes("opensubtitles") && (lower.includes("503") || lower.includes("service unavailable"))) {
    return "OpenSubtitles respondeu 503 no endpoint da API. Tente novamente em alguns minutos ou use outro provedor.";
  }
  if (lower.includes("http 503") || lower.includes("service unavailable")) {
    return "O provedor respondeu como indisponível. Tente novamente em alguns minutos ou use outro provedor.";
  }
  if (lower.includes("parsing subtitle") || lower.includes("invalid subtitle") || lower.includes("decode")) {
    return "A legenda baixada parece inválida ou corrompida. Use Forçar busca e reprocessar este item.";
  }
  if (lower.includes("timeout") || lower.includes("tempo limite")) {
    return "Tempo limite atingido. Aumente o Timeout ou tente novamente.";
  }
  if (lower.includes("nenhum resultado") || lower.includes("sem legenda") || lower.includes("legenda não encontrada")) {
    return "Nenhuma legenda encontrada para este arquivo no idioma escolhido.";
  }
  if (lower.includes("nenhum download funcionou") || lower.includes("download da legenda falhou") || lower.includes("download falhou")) {
    return "A legenda foi encontrada, mas o download falhou. Tente reprocessar ou use outro provedor.";
  }
  if (lower.includes("job não encontrado") || lower.includes("job n")) {
    return "A sincronização atual foi perdida. Escaneie novamente e tente sincronizar.";
  }

  return raw.length > 220 ? `${raw.slice(0, 217)}...` : raw;
}

function friendlyRowMessage(row: Row, fallback: string): string {
  return friendlyError(row.subdetail || row.detail, fallback);
}

function rowProgressInfo(row: Row, status: DisplayStatus, phase: Phase, live?: LiveRowProgress): {
  stage: string;
  percent: number;
  subtitle: string;
  tone: "run" | "ok" | "fail" | "idle";
} {
  if (live) {
    return live;
  }

  const detailText = `${row.detail} ${row.subdetail}`.toLowerCase();

  if (status === "OK") {
    return {
      stage: "finalizado",
      percent: 100,
      subtitle: friendlyRowMessage(row, "Sincronizada"),
      tone: "ok",
    };
  }
  if (status === "PULADO") {
    return {
      stage: "pulado",
      percent: 100,
      subtitle: friendlyRowMessage(row, "Item pulado"),
      tone: "idle",
    };
  }
  if (status === "FALHOU") {
    const isDownload = /download|legenda/.test(detailText);
    const isSync = /alass|sincron/.test(detailText);
    return {
      stage: isDownload ? "download" : isSync ? "alass" : "falhou",
      percent: isDownload ? 38 : 63,
      subtitle: friendlyRowMessage(row, "Falhou no processamento"),
      tone: "fail",
    };
  }
  if (status === "SEM_LEGENDA") {
    return {
      stage: "sem legenda",
      percent: 0,
      subtitle: friendlyRowMessage(row, "Nenhuma legenda encontrada para este arquivo no idioma escolhido."),
      tone: "fail",
    };
  }
  if (status === "PRONTO" || status === "PENDENTE" || phase === "scanned") {
    return {
      stage: "aguardando",
      percent: 0,
      subtitle: "Na fila para processar",
      tone: "idle",
    };
  }
  return {
    stage: "processando",
    percent: 15,
    subtitle: friendlyRowMessage(row, "Processando arquivo"),
    tone: "run",
  };
}

function pathName(path: string) {
  if (!path) return "";
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? `${parts.at(-1)}\\` : path;
}

function isVideoPath(path: string) {
  return /\.(mkv|mp4|avi|mov|wmv|m4v)$/i.test(path.trim());
}

function cleanWindowsPath(path: string) {
  const value = path.trim();
  if (value.startsWith("\\\\?\\UNC\\")) return `\\\\${value.slice(8)}`;
  if (value.startsWith("\\\\?\\")) return value.slice(4);
  return value;
}

function dirName(path: string) {
  const normalized = cleanWindowsPath(path);
  const index = Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/"));
  return index > 0 ? normalized.slice(0, index) : normalized;
}

function commonParentDir(paths: string[]) {
  const dirs = paths.map(dirName).filter(Boolean);
  if (!dirs.length) return "";
  let prefix = dirs[0];

  for (const dir of dirs.slice(1)) {
    const max = Math.min(prefix.length, dir.length);
    let index = 0;
    while (index < max && prefix[index].toLowerCase() === dir[index].toLowerCase()) {
      index += 1;
    }
    prefix = prefix.slice(0, index);
    const slash = Math.max(prefix.lastIndexOf("\\"), prefix.lastIndexOf("/"));
    prefix = slash > 2 ? prefix.slice(0, slash) : prefix.slice(0, slash + 1);
  }

  return prefix || dirs[0];
}

function nowLog(message: string) {
  return `${new Date().toLocaleTimeString()}   ${message}`;
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function providerLabel(providerId: ProviderId) {
  if (providerId === "subdl") return "SubDL";
  if (providerId === "subliminal") return "Subliminal";
  if (providerId === "subsource") return "SubSource";
  return "OpenSubtitles";
}

function providerStatus(provider?: ProviderConfig, providerId?: ProviderId) {
  if (!provider) return { description: "Carregando", chip: "...", className: "muted" };
  if (provider.enabled === false) return { description: "Desativado", chip: "Off", className: "off" };
  if (!provider.configured) return { description: "Sem API key", chip: "Sem chave", className: "warn" };
  if (provider.last_download_ok === false) {
    return {
      description: friendlyError(provider.last_download_error || "Conexão OK, mas download falhou no último teste"),
      chip: "Falhou",
      className: "bad",
    };
  }
  if (!provider.has_api_key && provider.last_test_ok !== false) {
    return { description: "OpenSubtitles + Podnapisi legado", chip: "Pronto", className: "ok" };
  }
  if (provider.last_test_ok === true) {
    const remaining = provider.account_info?.downloads_remaining;
    if (providerId === "opensubtitles" && Number(remaining) <= 0) {
      return {
        description: "Limite diário de downloads atingido",
        chip: "Limite",
        className: "warn",
      };
    }
    const accountInfo = remaining !== undefined
      ? `Conta OK · ${remaining} restante${Number(remaining) === 1 ? "" : "s"}`
      : provider.account_connected || provider.has_password
        ? "Conta OK"
        : providerId === "opensubtitles"
          ? "API key OK · login necessário para baixar"
        : "API key OK";
    return {
      description: accountInfo,
      chip: "Conectado",
      className: "ok",
    };
  }
  if (provider.last_test_ok === false) {
    return {
      description: friendlyError(provider.last_test_error || "Falha no último teste"),
      chip: "Falhou",
      className: "bad",
    };
  }
  return {
    description: provider.api_key_masked ? `Chave salva · ${provider.api_key_masked}` : "Chave salva",
    chip: "Não testado",
    className: "warn",
  };
}

export default function App() {
  const saved = useMemo(loadConfig, []);
  const launchFilesHandled = useRef(false);
  const [theme, setTheme] = useState<Theme>(() => (window.localStorage.getItem("synclegendas-theme") === "light" ? "light" : "dark"));
  const [activeTab, setActiveTab] = useState<"fila" | "config">("fila");
  const [sourceDir, setSourceDir] = useState(saved.sourceDir);
  const [outputDir, setOutputDir] = useState(saved.outputDir);
  const [outputManuallyChosen, setOutputManuallyChosen] = useState(false);
  const [language, setLanguage] = useState(saved.language);
  const [ignoreEmbedded, setIgnoreEmbedded] = useState(saved.ignoreEmbedded);
  const [autoDownloadMissing, setAutoDownloadMissing] = useState(saved.autoDownloadMissing);
  const [syncAfterDownload, setSyncAfterDownload] = useState(saved.syncAfterDownload);
  const [preserveFolders, setPreserveFolders] = useState(saved.preserveFolders);
  const [embedSoftsub, setEmbedSoftsub] = useState(saved.embedSoftsub);
  const [updateOriginal] = useState(true);
  const [forceDownload, setForceDownload] = useState(saved.forceDownload);
  const [forceResync, setForceResync] = useState(saved.forceResync);
  const keepBak = embedSoftsub;
  const [subtitleDefault, setSubtitleDefault] = useState(saved.subtitleDefault);
  const [subtitleTrack, setSubtitleTrack] = useState(saved.subtitleTrack);
  const [timeoutSeconds, setTimeoutSeconds] = useState(saved.timeoutSeconds);
  const [retries, setRetries] = useState(saved.retries);
  const [rows, setRows] = useState<Row[]>([]);
  const [externalTargets, setExternalTargets] = useState<string[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [loading, setLoading] = useState<"idle" | "scan" | "sync">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [backendOk, setBackendOk] = useState<boolean | null>(null);
  const [deps, setDeps] = useState<{
    alass?: { found?: boolean; path?: string; message?: string; version?: string };
    ffmpeg?: { found?: boolean; path?: string; message?: string; version?: string };
    ffprobe?: { found?: boolean; path?: string; message?: string; version?: string };
  }>({});
  const [phase, setPhase] = useState<Phase>("empty");
  const [filter, setFilter] = useState<Filter>("all");
  const [showLog, setShowLog] = useState(false);
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});
  const [openRowMenu, setOpenRowMenu] = useState<string | null>(null);
  const [depsMessage, setDepsMessage] = useState("");
  const [depsSetupOpen, setDepsSetupOpen] = useState(false);
  const [depsSetupDismissed, setDepsSetupDismissed] = useState(
    () => window.localStorage.getItem("syncora-first-run-setup-dismissed") === "1",
  );
  const [providers, setProviders] = useState<Record<ProviderId, ProviderConfig> | null>(null);
  const [providerDrafts, setProviderDrafts] = useState<Record<string, Record<string, string>>>({});
  const [providerMessage, setProviderMessage] = useState("");
  const [openProvider, setOpenProvider] = useState<ProviderId | null>("subdl");
  const [visibleProviderKeys, setVisibleProviderKeys] = useState<Record<string, boolean>>({});
  const [explorerStatus, setExplorerStatus] = useState<ExplorerIntegrationStatus | null>(null);
  const [explorerMessage, setExplorerMessage] = useState("");
  const [explorerBusy, setExplorerBusy] = useState<"idle" | "install" | "uninstall">("idle");
  const [installExplorerOnSetup, setInstallExplorerOnSetup] = useState(true);
  const [showQueueOptions, setShowQueueOptions] = useState(true);
  const [syncProgress, setSyncProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  const [liveProgressByRow, setLiveProgressByRow] = useState<Record<string, LiveRowProgress>>({});
  const [activeSyncJobId, setActiveSyncJobId] = useState("");
  const [syncPauseState, setSyncPauseState] = useState<SyncPauseState>("running");
  const syncPaused = syncPauseState !== "running";
  const setSyncPaused = (paused: boolean) => setSyncPauseState(paused ? "paused" : "running");
  const showLegacyConfig = new URLSearchParams(window.location.search).has("legacyConfig");

  useEffect(() => {
    void checkBackend();
    void refreshProviders();
    void refreshExplorerIntegration();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (launchFilesHandled.current) return;
    launchFilesHandled.current = true;
    void loadLaunchFiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    window.localStorage.setItem("synclegendas-theme", theme);
  }, [theme]);

  useEffect(() => {
    const config: SavedConfig = {
      sourceDir,
      outputDir,
      language,
      ignoreEmbedded,
      autoDownloadMissing,
      syncAfterDownload,
      preserveFolders,
      embedSoftsub,
      updateOriginal,
      forceDownload,
      forceResync,
      keepBak,
      subtitleDefault,
      subtitleTrack,
      timeoutSeconds,
      retries,
    };
    window.localStorage.setItem("synclegendas-config", JSON.stringify(config));
  }, [
    sourceDir,
    outputDir,
    language,
    ignoreEmbedded,
    autoDownloadMissing,
    syncAfterDownload,
    preserveFolders,
    embedSoftsub,
    updateOriginal,
    forceDownload,
    forceResync,
    keepBak,
    subtitleDefault,
    subtitleTrack,
    timeoutSeconds,
    retries,
  ]);

  const depsKnown = Boolean(deps.alass || deps.ffmpeg || deps.ffprobe);
  const depsReady = Boolean(deps.alass?.found && deps.ffmpeg?.found && deps.ffprobe?.found);
  const depsMissing = depsKnown && !depsReady;
  const explorerKnown = explorerStatus !== null;
  const explorerMissing = explorerKnown && !explorerStatus.installed;

  useEffect(() => {
    if (!depsSetupDismissed && ((backendOk === true && depsMissing) || explorerMissing)) {
      setDepsSetupOpen(true);
    }
  }, [backendOk, depsMissing, depsSetupDismissed, explorerMissing]);

  const summary = useMemo(() => {
    const total = rows.length;
    const ok = rows.filter((r) => r.status === "OK").length;
    const fail = rows.filter((r) => r.status === "FALHOU").length;
    const skip = rows.filter((r) => r.status === "PULADO").length;
    const noSubtitle = rows.filter((r) => r.status === "SEM_LEGENDA").length;
    const pending = rows.filter((r) => r.status === "PENDENTE").length;
    const ready = phase === "scanned" ? pending : 0;
    const externalSubtitle = rows.filter((r) => r.subtitle && r.subtitle !== "-").length;
    const embeddedSubtitle = rows.filter((r) => r.status === "PULADO" || /embutida/i.test(`${r.subtitleMeta} ${r.detail}`)).length;
    return { total, ok, fail, skip, pending, ready, noSubtitle, externalSubtitle, embeddedSubtitle };
  }, [rows, phase]);

  const retryableIssueRows = useMemo(
    () => rows.filter((r) => (r.status === "FALHOU" || r.status === "SEM_LEGENDA") && r.video_full),
    [rows],
  );

  const shouldReprocessFromMain = phase === "synced" && summary.pending === 0 && retryableIssueRows.length > 0;
  const canUseSyncButton = phase === "scanned" ? rows.length > 0 : shouldReprocessFromMain;
  const syncButtonLabel = loading === "sync"
    ? (syncPauseState === "cancelling" ? "Cancelando..." : "Cancelar")
    : shouldReprocessFromMain
      ? "Reprocessar falhas"
      : syncAfterDownload
        ? "Baixar e sincronizar"
        : "Baixar legendas";
  const syncButtonIcon = loading === "sync"
    ? (syncPauseState === "cancelling" ? "\u2026" : "\u00d7")
    : shouldReprocessFromMain
      ? "\u21bb"
      : syncAfterDownload
        ? "\u25b6"
        : "\u2193";

  const progress = useMemo(() => {
    if (loading === "sync" && syncProgress.total > 0) {
      return Math.round((syncProgress.done / syncProgress.total) * 100);
    }
    if (!summary.total || phase !== "synced") return 0;
    return Math.round(((summary.ok + summary.fail + summary.skip) / summary.total) * 100);
  }, [loading, summary, phase, syncProgress.done, syncProgress.total]);

  const phaseInfo = useMemo(() => {
    if (loading === "scan") return { title: "Escaneando pasta...", text: "Lendo vídeos, legendas e trilhas embutidas." };
    if (loading === "sync" && syncPauseState === "cancelling") return { title: `Cancelando ${syncProgress.done}/${syncProgress.total || summary.total}`, text: "O arquivo atual vai terminar antes de encerrar a fila." };
    if (loading === "sync") return { title: `Sincronizando ${syncProgress.done}/${syncProgress.total || summary.total}`, text: "Processando a fila com ALASS e dependências configuradas." };
    if (backendOk === false) return { title: "Backend offline", text: "Inicie o servidor local na porta 8765 para escanear e sincronizar." };
    if (phase === "empty") return { title: "Pronto para escanear", text: "Escolha as pastas e clique em Escanear para montar a fila." };
    if (phase === "scanned") return { title: "Pronto para sincronizar", text: `${summary.total} vídeos encontrados, ${summary.externalSubtitle} com legenda externa, ${summary.embeddedSubtitle} com legenda embutida, ${summary.noSubtitle} sem legenda.` };
    return { title: summary.fail ? `Concluído com ${summary.fail} falha(s)` : "Concluído", text: `${summary.ok} concluídos, ${summary.skip} pulados, ${summary.fail} falharam.` };
  }, [backendOk, loading, phase, summary, syncPauseState, syncProgress.done, syncProgress.total]);
  const showErrorBanner = Boolean(errorMsg && !(backendOk === false && errorMsg.toLowerCase().includes("backend offline")));

  const filteredRows = useMemo(() => {
    return rows.filter((row) => {
      const displayStatus = getDisplayStatus(row, phase);
      if (filter === "all") return true;
      if (filter === "ready") return displayStatus === "PRONTO";
      if (filter === "ok") return displayStatus === "OK";
      if (filter === "skip") return displayStatus === "PULADO";
      if (filter === "fail") return displayStatus === "FALHOU";
      return displayStatus === "PENDENTE" || displayStatus === "PRONTO" || displayStatus === "SEM_LEGENDA";
    });
  }, [rows, filter, phase]);

  async function checkBackend(): Promise<boolean> {
    try {
      const res = await fetch("http://127.0.0.1:8765/health");
      const data = await res.json();
      const ok = Boolean(data?.ok);
      setBackendOk(ok);
      if (ok) void refreshDeps();
      return ok;
    } catch {
      setBackendOk(false);
      return false;
    }
  }

  async function refreshDeps() {
    try {
      const res = await fetch("http://127.0.0.1:8765/deps/status");
      const data = await res.json();
      if (data?.ok) setDeps(data);
    } catch {
      // Dependency status is helpful but should not block the interface.
    }
  }

  async function refreshProviders() {
    try {
      const res = await fetch("http://127.0.0.1:8765/providers");
      const data = await res.json();
      if (data?.ok) setProviders(data.providers);
    } catch {
      // Provider config is optional while backend is offline.
    }
  }

  async function refreshExplorerIntegration() {
    try {
      const core = await import("@tauri-apps/api/core");
      if (!core.isTauri()) return;
      const status = await core.invoke<ExplorerIntegrationStatus>("get_explorer_integration_status");
      setExplorerStatus(status);
      setExplorerMessage(status.message);
    } catch (err) {
      setExplorerMessage(`Falha ao verificar integração: ${friendlyError(err)}`);
    }
  }

  async function runExplorerIntegration(action: "install" | "uninstall"): Promise<boolean> {
    setExplorerBusy(action);
    setExplorerMessage(action === "install" ? "Instalando integração..." : "Removendo integração...");
    try {
      const core = await import("@tauri-apps/api/core");
      if (!core.isTauri()) throw new Error("Disponível apenas no app Syncora.");
      const command = action === "install" ? "install_explorer_integration" : "uninstall_explorer_integration";
      const status = await core.invoke<ExplorerIntegrationStatus>(command);
      setExplorerStatus(status);
      setExplorerMessage(status.message);
      return true;
    } catch (err) {
      setExplorerMessage(friendlyError(err));
      return false;
    } finally {
      setExplorerBusy("idle");
    }
  }

  async function saveProvider(providerId: ProviderId) {
    const current = providers?.[providerId];
    const draft = providerDrafts[providerId] || {};
    setProviderMessage("Salvando provedor...");
    try {
      const res = await fetch("http://127.0.0.1:8765/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider_id: providerId,
          enabled: current?.enabled ?? true,
          priority: Number(draft.priority || current?.priority || 1),
          api_key: draft.api_key,
          username: draft.username,
          password: draft.password,
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Falha ao salvar provedor");
      setProviders(data.providers);
      setProviderDrafts((old) => ({
        ...old,
        [providerId]: {
          ...(old[providerId] || {}),
          priority: String(Number(draft.priority || current?.priority || 1)),
        },
      }));
      setProviderMessage("Provedor salvo. Use Testar para validar a conexão.");
    } catch (err) {
      setProviderMessage(friendlyError(err));
    }
  }

  async function toggleProvider(providerId: ProviderId) {
    const current = providers?.[providerId];
    if (!current) return;
    try {
      const res = await fetch("http://127.0.0.1:8765/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider_id: providerId,
          enabled: !current.enabled,
          priority: current.priority,
        }),
      });
      const data = await res.json();
      if (data.ok) setProviders(data.providers);
    } catch {
      setProviderMessage("Falha ao alternar provedor.");
    }
  }

  async function testProvider(providerId: ProviderId) {
    setProviderMessage("Testando conexão...");
    try {
      const res = await fetch("http://127.0.0.1:8765/providers/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider_id: providerId }),
      });
      const data = await res.json();
      if (data.providers) setProviders(data.providers);
      if (!data.ok) throw new Error(data.error || "Falha no teste");
      setProviderMessage(data.message || `${providerLabel(providerId)} conectado.`);
    } catch (err) {
      setProviderMessage(friendlyError(err));
    }
  }

  function updateProviderDraft(providerId: ProviderId, key: string, value: string) {
    setProviderDrafts((old) => ({ ...old, [providerId]: { ...(old[providerId] || {}), [key]: value } }));
  }

  async function installDeps(target: "all" | "alass" | "ffmpeg"): Promise<boolean> {
    setLoading("sync");
    setErrorMsg("");
    setDepsMessage(target === "all" ? "Instalando ferramentas..." : `Atualizando ${target.toUpperCase()}...`);
    try {
      const ok = await checkBackend();
      if (!ok) throw new Error("Backend offline. Inicie o uvicorn na porta 8765.");
      const res = await fetch("http://127.0.0.1:8765/deps/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target }),
      });
      const text = await res.text();
      let data: { ok?: boolean; error?: string; installed?: Record<string, unknown> } = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(text || `Falha HTTP ${res.status}`);
      }
      if (!res.ok || !data.ok) throw new Error(data.error || "Falha ao instalar dependências");
      await refreshDeps();
      setDepsMessage("Dependências atualizadas.");
      setLogs((old) => [nowLog(`Dependências atualizadas (${target}).`), ...old]);
      return true;
    } catch (err) {
      setErrorMsg(friendlyError(err));
      setDepsMessage("Falha ao atualizar dependências.");
      setLogs((old) => [nowLog(`[FALHOU] Dependências: ${friendlyError(err)}`), ...old]);
      return false;
    } finally {
      setLoading("idle");
    }
  }

  function dismissDepsSetup() {
    window.localStorage.setItem("syncora-first-run-setup-dismissed", "1");
    setDepsSetupDismissed(true);
    setDepsSetupOpen(false);
  }

  function showDepsSetupAgain() {
    window.localStorage.removeItem("syncora-first-run-setup-dismissed");
    setDepsSetupDismissed(false);
    setDepsSetupOpen(true);
    setDepsMessage("");
    setExplorerMessage("");
    setInstallExplorerOnSetup(true);
    void refreshDeps();
    void refreshExplorerIntegration();
  }

  async function runDepsSetup() {
    if (depsMissing) {
      await installDeps("all");
    }
    if (explorerMissing && installExplorerOnSetup) {
      await runExplorerIntegration("install");
    }
  }

  function applySourceDir(nextRaw: string) {
    const next = nextRaw.trim();
    const shouldMirrorOutput = !outputManuallyChosen || !outputDir.trim();
    setExternalTargets([]);
    setSourceDir(next);
    if (shouldMirrorOutput) setOutputDir(next);
  }

  function applyOutputDir(nextRaw: string, manual = true) {
    const next = nextRaw.trim();
    setOutputDir(next);
    if (!manual) return;
    const sameAsSource = !!next && next === sourceDir.trim();
    setOutputManuallyChosen(!sameAsSource && !!next);
  }

  async function pickPathAsync(kind: "origem" | "saida") {
    const current = kind === "origem" ? sourceDir : outputDir;
    try {
      const core = await import("@tauri-apps/api/core");
      if (core.isTauri()) {
        const dialog = await import("@tauri-apps/plugin-dialog");
        const selected = await dialog.open({ directory: true, multiple: false, defaultPath: current || undefined });
        const value = Array.isArray(selected) ? selected[0] : selected;
        if (typeof value === "string" && value.trim()) {
          if (kind === "origem") applySourceDir(value);
          else applyOutputDir(value, true);
          return;
        }
        return;
      }
    } catch (err) {
      setErrorMsg(`Falha ao abrir seletor nativo: ${friendlyError(err)}`);
    }
    const value = window.prompt(
      kind === "origem" ? "Informe o caminho da pasta de origem:" : "Informe o caminho da pasta de saída:",
      current || "",
    );
    if (!value) return;
    if (kind === "origem") applySourceDir(value);
    else applyOutputDir(value, true);
  }

  async function handleScan() {
    if (!sourceDir.trim() || !outputDir.trim()) {
      setErrorMsg("Preencha Pasta origem e Pasta de saída.");
      return;
    }
    setLoading("scan");
    setErrorMsg("");
    setPhase("empty");
    setActiveSyncJobId("");
    setSyncPaused(false);
    setLiveProgressByRow({});
    try {
      const ok = await checkBackend();
      if (!ok) throw new Error("Backend offline. Inicie o uvicorn na porta 8765.");
      const res = await fetch("http://127.0.0.1:8765/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_dir: sourceDir,
          output_dir: outputDir,
          preserve_subfolders: preserveFolders,
          language,
          ignore_embedded_subtitles: ignoreEmbedded,
          files: externalTargets.length ? externalTargets : undefined,
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Falha no scan");
      const normalized = (data.rows || []).map(normalizeRow);
      setRows(normalized);
      setPhase(normalized.length ? "scanned" : "empty");
      setFilter("all");
      setLogs((old) => [nowLog(`Escaneamento concluído. ${normalized.length} arquivo(s).`), ...old]);
    } catch (err) {
      setRows([]);
      setPhase("empty");
      setErrorMsg(friendlyError(err));
      setLogs((old) => [nowLog(`[FALHOU] Scan: ${friendlyError(err)}`), ...old]);
    } finally {
      setLoading("idle");
    }
  }

  async function handleDownloadMissing(targets: string[] | null = null, sourceOverride = "", outputOverride = "") {
    const effectiveSourceDir = sourceOverride || sourceDir;
    const effectiveOutputDir = outputOverride || outputDir;
    if (!effectiveSourceDir.trim() || !effectiveOutputDir.trim()) {
      setErrorMsg("Preencha Pasta origem e Pasta de saida.");
      return;
    }

    const downloadTargets: string[] = (targets && targets.length)
      ? [...targets]
      : rows
        .filter((r) => ["PENDENTE", "SEM_LEGENDA", "FALHOU", "PULADO"].includes(r.status) && r.video_full)
        .map((r) => r.video_full as string);

    setLoading("sync");
    setErrorMsg("");
    setPhase("synced");
    setSyncPaused(false);
    setSyncProgress({ done: 0, total: downloadTargets.length || rows.length || 0 });
    if (downloadTargets.length) {
      setLiveProgressByRow(() => {
        const initial: Record<string, LiveRowProgress> = {};
        for (const target of downloadTargets) {
          initial[target] = { stage: "aguardando", percent: 0, subtitle: "Na fila para baixar", tone: "idle" };
        }
        return initial;
      });
    }

    try {
      const ok = await checkBackend();
      if (!ok) throw new Error("Backend offline. Inicie o uvicorn na porta 8765.");

      const startRes = await fetch("http://127.0.0.1:8765/subtitles/download-missing/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_dir: effectiveSourceDir,
          output_dir: effectiveOutputDir,
          preserve_subfolders: preserveFolders,
          force_download: forceDownload,
          language,
          ignore_embedded_subtitles: ignoreEmbedded,
          targets: downloadTargets.length ? downloadTargets : targets,
        }),
      });
      const startData = await startRes.json().catch(() => ({}));
      if (!startRes.ok || !startData.ok || !startData.job_id) {
        if (startRes.status === 404) {
          await handleDownloadMissingLegacy(downloadTargets.length ? downloadTargets : targets, effectiveSourceDir, effectiveOutputDir);
          return;
        }
        throw new Error(startData.error || startData.detail || `Falha ao iniciar download de legendas (HTTP ${startRes.status})`);
      }

      const jobId = String(startData.job_id);
      setActiveSyncJobId(jobId);
      setSyncPaused(false);

      const applyFinishedJobPayload = (payload: Record<string, unknown>) => {
        if (Array.isArray(payload.rows)) {
          const normalized: Row[] = (payload.rows as Record<string, unknown>[]).map(normalizeRow);
          setRows(normalized);
          setFilter("all");
        }
        if (Array.isArray(payload.logs) && payload.logs.length) {
          setLogs((old) => [...(payload.logs as string[]).map((x: string) => nowLog(x)), ...old]);
        }
        const summaryPayload = (payload.summary as Record<string, unknown>) || {};
        const totalFromSummary = Number(summaryPayload.total || (Array.isArray(payload.rows) ? payload.rows.length : downloadTargets.length));
        setSyncProgress({ done: totalFromSummary, total: totalFromSummary });
        setLogs((old) => [nowLog(`Download de legendas concluido. ${totalFromSummary} item(ns).`), ...old]);
      };

      const reconcileAfterStreamDrop = async () => {
        let activeAttempts = 0;
        while (activeAttempts < 90) {
          const statusRes = await fetch(`http://127.0.0.1:8765/sync/status/${encodeURIComponent(jobId)}`);
          if (statusRes.ok) {
            const statusData = (await statusRes.json()) as Record<string, unknown>;
            const status = String(statusData.status || "");
            const paused = Boolean(statusData.paused);
            const pauseState = String(statusData.pause_state || "");
            setSyncPauseState(
              pauseState === "pausing" || pauseState === "paused" || pauseState === "cancelling"
                ? pauseState
                : paused
                  ? "pausing"
                  : "running",
            );
            if (status === "failed") {
              throw new Error(String(statusData.error || "Falha ao baixar legendas"));
            }
            if (status === "done" || status === "cancelled") {
              const resultRes = await fetch(`http://127.0.0.1:8765/sync/result/${encodeURIComponent(jobId)}`);
              if (!resultRes.ok) {
                throw new Error("Job finalizado, mas resultado final nao ficou disponivel.");
              }
              const resultData = (await resultRes.json()) as Record<string, unknown>;
              applyFinishedJobPayload(resultData);
              return;
            }
            if (!paused) activeAttempts += 1;
          }
          await delay(800);
        }
        throw new Error("Conexao de progresso interrompida e o backend nao confirmou conclusao a tempo.");
      };

      await new Promise<void>((resolve, reject) => {
        const stream = new EventSource(`http://127.0.0.1:8765/sync/events/${encodeURIComponent(jobId)}`);
        let finished = false;
        let recovering = false;

        const closeAndResolve = () => {
          if (finished) return;
          finished = true;
          stream.close();
          resolve();
        };
        const closeAndReject = (error: unknown) => {
          if (finished) return;
          finished = true;
          stream.close();
          reject(error);
        };
        const parseEvent = (event: MessageEvent) => {
          try {
            return JSON.parse(String(event.data || "{}")) as Record<string, unknown>;
          } catch {
            return {} as Record<string, unknown>;
          }
        };

        stream.addEventListener("job_ready", (event) => {
          const data = parseEvent(event as MessageEvent);
          const totalFromEvent = Number(data.total || 0);
          if (totalFromEvent > 0) {
            setSyncProgress((prev) => ({ ...prev, total: totalFromEvent }));
          }
          if (Array.isArray(data.rows)) {
            const normalized: Row[] = (data.rows as Record<string, unknown>[]).map(normalizeRow);
            setRows(normalized);
          }
        });

        stream.addEventListener("job_pause_requested", () => {
          setSyncPauseState("pausing");
        });

        stream.addEventListener("job_paused", () => {
          setSyncPauseState("paused");
        });

        stream.addEventListener("job_resumed", () => {
          setSyncPauseState("running");
        });

        stream.addEventListener("job_cancel_requested", () => {
          setSyncPauseState("cancelling");
        });

        stream.addEventListener("job_cancelled", () => {
          setSyncPauseState("cancelling");
        });

        stream.addEventListener("row_progress", (event) => {
          const data = parseEvent(event as MessageEvent);
          const rowIndex = Number(data.index || 0);
          const totalFromEvent = Number(data.total || downloadTargets.length || rows.length || 0);
          const rowPercent = Math.max(0, Math.min(100, Number(data.percent || 0)));
          if (rowIndex > 0 && totalFromEvent > 0) {
            setSyncProgress({ done: Math.max(0, rowIndex - 1) + rowPercent / 100, total: totalFromEvent });
          }

          const key = String(data.video_full || data.video || "");
          if (!key) return;
          const toneRaw = String(data.tone || "run");
          const tone: LiveRowProgress["tone"] = toneRaw === "ok" || toneRaw === "fail" || toneRaw === "idle" ? toneRaw : "run";
          setLiveProgressByRow((prev) => ({
            ...prev,
            [key]: {
              stage: String(data.stage || "baixando"),
              percent: rowPercent,
              subtitle: String(data.subdetail || data.detail || ""),
              tone,
            },
          }));
        });

        stream.addEventListener("row_result", (event) => {
          const data = parseEvent(event as MessageEvent);
          const rowData = data.row;
          if (rowData && typeof rowData === "object") {
            const normalized = normalizeRow(rowData as Record<string, unknown>);
            const key = normalized.video_full || normalized.video;
            setRows((prev) => prev.map((r) => ((r.video_full || r.video) === key ? normalized : r)));
            if (["OK", "PULADO", "FALHOU", "SEM_LEGENDA"].includes(normalized.status)) {
              const finalInfo = rowProgressInfo(normalized, normalized.status as DisplayStatus, "synced");
              setLiveProgressByRow((prev) => ({ ...prev, [key]: finalInfo }));
            }
          }
          const done = Number(data.done || 0);
          const totalFromEvent = Number(data.total || 0);
          if (done >= 0 && totalFromEvent >= 0) {
            setSyncProgress({ done, total: totalFromEvent || downloadTargets.length || rows.length });
          }
        });

        stream.addEventListener("job_progress", (event) => {
          const data = parseEvent(event as MessageEvent);
          const done = Number(data.done || 0);
          const totalFromEvent = Number(data.total || downloadTargets.length || rows.length);
          setSyncProgress({ done, total: totalFromEvent });
        });

        stream.addEventListener("job_finished", (event) => {
          const data = parseEvent(event as MessageEvent);
          applyFinishedJobPayload(data);
          closeAndResolve();
        });

        stream.addEventListener("job_failed", (event) => {
          const data = parseEvent(event as MessageEvent);
          closeAndReject(new Error(String(data.error || "Falha ao baixar legendas")));
        });

        stream.onerror = () => {
          if (finished || recovering) return;
          recovering = true;
          stream.close();
          setErrorMsg("Conexao de progresso interrompida. Reconciliando estado...");
          void reconcileAfterStreamDrop()
            .then(() => {
              setErrorMsg("");
              closeAndResolve();
            })
            .catch((error) => {
              closeAndReject(error);
            });
        };
      });
    } catch (err) {
      setErrorMsg(friendlyError(err));
      setLogs((old) => [nowLog(`[FALHOU] Download de legendas: ${friendlyError(err)}`), ...old]);
    } finally {
      setActiveSyncJobId("");
      setSyncPaused(false);
      setLiveProgressByRow({});
      setSyncProgress({ done: 0, total: 0 });
      setLoading("idle");
    }
  }

  async function handleDownloadMissingLegacy(targets: string[] | null = null, sourceOverride = "", outputOverride = "") {
    const effectiveSourceDir = sourceOverride || sourceDir;
    const effectiveOutputDir = outputOverride || outputDir;
    if (!effectiveSourceDir.trim() || !effectiveOutputDir.trim()) {
      setErrorMsg("Preencha Pasta origem e Pasta de saída.");
      return;
    }
    setLoading("sync");
    setErrorMsg("");
    setPhase("synced");
    setSyncProgress({ done: 0, total: targets?.length || rows.length || 0 });
    try {
      const ok = await checkBackend();
      if (!ok) throw new Error("Backend offline. Inicie o uvicorn na porta 8765.");
      const res = await fetch("http://127.0.0.1:8765/subtitles/download-missing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_dir: effectiveSourceDir,
          output_dir: effectiveOutputDir,
          preserve_subfolders: preserveFolders,
          force_download: forceDownload,
          language,
          ignore_embedded_subtitles: ignoreEmbedded,
          targets,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        if (res.status === 404) {
          throw new Error("Backend antigo sem rota de download de legendas. Reinicie o app/backend e tente novamente.");
        }
        throw new Error(data.error || data.detail || `Falha ao baixar legendas (HTTP ${res.status})`);
      }
      const normalized: Row[] = (data.rows || []).map(normalizeRow);
      setRows(normalized);
      setFilter("all");
      if (Array.isArray(data.logs) && data.logs.length) {
        setLogs((old) => [...data.logs.map((x: string) => nowLog(x)), ...old]);
      }
      setLogs((old) => [nowLog(`Download de legendas concluído. ${normalized.length} item(ns).`), ...old]);
      const total = normalized.length;
      setSyncProgress({ done: total, total });
    } catch (err) {
      setErrorMsg(friendlyError(err));
      setLogs((old) => [nowLog(`[FALHOU] Download de legendas: ${friendlyError(err)}`), ...old]);
    } finally {
      setLiveProgressByRow({});
      setSyncProgress({ done: 0, total: 0 });
      setLoading("idle");
    }
  }

  async function scanExternalFiles(files: string[], action: LaunchAction = "queue") {
    const selectedFiles = [...new Set(files.map(cleanWindowsPath).filter(isVideoPath))];
    if (!selectedFiles.length) return;

    const root = commonParentDir(selectedFiles);
    if (!root) return;

    setActiveTab("fila");
    setSourceDir(root);
    setOutputDir(root);
    setOutputManuallyChosen(false);
    setExternalTargets(selectedFiles);
    setLoading("scan");
    setErrorMsg("");
    setPhase("empty");
    setActiveSyncJobId("");
    setSyncPaused(false);
    setLiveProgressByRow({});

    try {
      const ok = await checkBackend();
      if (!ok) throw new Error("Backend offline. Inicie o uvicorn na porta 8765.");
      const res = await fetch("http://127.0.0.1:8765/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_dir: root,
          output_dir: root,
          preserve_subfolders: preserveFolders,
          language,
          ignore_embedded_subtitles: ignoreEmbedded,
          files: selectedFiles,
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Falha no scan");
      const normalized = (data.rows || []).map(normalizeRow);
      setRows(normalized);
      setPhase(normalized.length ? "scanned" : "empty");
      setFilter("all");
      const actionText = action === "download"
        ? "Baixando legendas dos arquivos selecionados"
        : action === "download-sync"
          ? "Baixando e sincronizando arquivos selecionados"
          : "Arquivos externos carregados";
      setLogs((old) => [nowLog(`${actionText}. ${normalized.length} item(ns).`), ...old]);
      if (action === "download" && normalized.length) {
        await handleDownloadMissing(selectedFiles, root, root);
      }
      if (action === "download-sync" && normalized.length) {
        await handleSyncProgress(selectedFiles, false, root, root);
      }
    } catch (err) {
      setRows([]);
      setPhase("empty");
      setErrorMsg(friendlyError(err));
      setLogs((old) => [nowLog(`[FALHOU] Arquivos externos: ${friendlyError(err)}`), ...old]);
    } finally {
      setLoading("idle");
    }
  }

  async function loadLaunchFiles() {
    try {
      const core = await import("@tauri-apps/api/core");
      if (!core.isTauri()) return;
      const files = await core.invoke<string[]>("get_launch_files");
      let actionRaw = "queue";
      try {
        actionRaw = await core.invoke<string>("get_launch_action");
      } catch {
        actionRaw = "queue";
      }
      const action: LaunchAction = actionRaw === "download-sync" ? "download-sync" : actionRaw === "download" ? "download" : "queue";
      if (Array.isArray(files) && files.length) {
        await scanExternalFiles(files, action);
      }
    } catch (err) {
      setErrorMsg(`Falha ao ler arquivos recebidos pelo Windows: ${friendlyError(err)}`);
    }
  }

  async function handleSync(targets: string[] = [], forceNow = false) {
    await handleSyncProgress(targets, forceNow);
  }

  async function toggleSyncPause() {
    if (!activeSyncJobId || loading !== "sync" || syncPauseState === "cancelling") return;
    setErrorMsg("");
    setSyncPauseState("cancelling");
    try {
      const res = await fetch(
        `http://127.0.0.1:8765/sync/cancel/${encodeURIComponent(activeSyncJobId)}`,
        { method: "POST" },
      );
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.status === 404) {
        setActiveSyncJobId("");
        setSyncPauseState("running");
        setSyncProgress({ done: 0, total: 0 });
        setLoading("idle");
        setLogs((old) => [nowLog("[CANCELADO] Fila anterior nao existe mais no backend. Interface liberada."), ...old]);
        return;
      }
      if (!res.ok || !data.ok) throw new Error(String(data.error || data.detail || "Falha ao cancelar a fila"));
      setSyncPauseState("cancelling");
    } catch (err) {
      setSyncPauseState("running");
      setErrorMsg(friendlyError(err));
      setLogs((old) => [nowLog(`[FALHOU] Cancelar: ${friendlyError(err)}`), ...old]);
    }
  }

  function handleSyncButton() {
    if (loading === "sync") {
      void toggleSyncPause();
      return;
    }
    if (shouldReprocessFromMain) {
      handleReprocessFails();
      return;
    }
    if (!syncAfterDownload) {
      void handleDownloadMissing(externalTargets.length ? externalTargets : []);
      return;
    }
    void handleSync(externalTargets.length ? externalTargets : [], false);
  }

  async function handleSyncProgressLegacy(targets: string[] | null = null, forceNow = false, sourceOverride = "", outputOverride = "") {
    const effectiveSourceDir = sourceOverride || sourceDir;
    const effectiveOutputDir = outputOverride || outputDir;
    if (!effectiveSourceDir.trim() || !effectiveOutputDir.trim()) {
      setErrorMsg("Preencha Pasta origem e Pasta de saída.");
      return;
    }
    setLoading("sync");
    setErrorMsg("");
    setSyncPaused(false);
    setPhase("synced");
    setSyncProgress({ done: 0, total: 0 });
    try {
      const ok = await checkBackend();
      if (!ok) throw new Error("Backend offline. Inicie o uvicorn na porta 8765.");

      const syncTargets: string[] = (targets && targets.length)
        ? [...targets]
        : rows
          .filter((r) => ["PENDENTE", "SEM_LEGENDA", "FALHOU", "PULADO"].includes(r.status) && r.video_full)
          .map((r) => r.video_full as string);
      setSyncProgress({ done: 0, total: syncTargets.length });

      for (let index = 0; index < syncTargets.length; index += 1) {
        const target = syncTargets[index];
        const res = await fetch("http://127.0.0.1:8765/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source_dir: effectiveSourceDir,
            output_dir: effectiveOutputDir,
            alass_path: null,
            preserve_subfolders: preserveFolders,
            force_resync: forceNow || forceResync,
            force_download: forceDownload,
            auto_download_missing_subtitles: autoDownloadMissing,
            language,
            ignore_embedded_subtitles: ignoreEmbedded,
            targets: [target],
            embed_softsub: embedSoftsub,
            update_original: updateOriginal,
            keep_bak: keepBak,
            subtitle_default: subtitleDefault,
            subtitle_track: subtitleTrack,
            timeout_seconds: timeoutSeconds,
            retries,
          }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "Falha na sincronização");
        const normalized: Row[] = (data.rows || []).map(normalizeRow);
        const updatedByKey = new Map<string, Row>(normalized.map((r: Row) => [r.video_full || r.video, r]));
        setRows((prev) => prev.map((r) => updatedByKey.get(r.video_full || r.video) || r));
        if (Array.isArray(data.logs) && data.logs.length) {
          setLogs((old) => [...data.logs.map((x: string) => nowLog(x)), ...old]);
        }
        setSyncProgress({ done: index + 1, total: syncTargets.length });
      }
    } catch (err) {
      setErrorMsg(friendlyError(err));
      setLogs((old) => [nowLog(`[FALHOU] Sync: ${friendlyError(err)}`), ...old]);
    } finally {
      setSyncProgress({ done: 0, total: 0 });
      setLoading("idle");
    }
  }

  async function handleSyncProgress(targets: string[] | null = null, forceNow = false, sourceOverride = "", outputOverride = "") {
    const effectiveSourceDir = sourceOverride || sourceDir;
    const effectiveOutputDir = outputOverride || outputDir;
    if (!effectiveSourceDir.trim() || !effectiveOutputDir.trim()) {
      setErrorMsg("Preencha Pasta origem e Pasta de saída.");
      return;
    }
    setLoading("sync");
    setErrorMsg("");
    setPhase("synced");
    setSyncProgress({ done: 0, total: 0 });
    try {
      const ok = await checkBackend();
      if (!ok) throw new Error("Backend offline. Inicie o uvicorn na porta 8765.");

      const syncTargets: string[] = (targets && targets.length)
        ? [...targets]
        : rows
          .filter((r) => ["PENDENTE", "SEM_LEGENDA", "FALHOU", "PULADO"].includes(r.status) && r.video_full)
          .map((r) => r.video_full as string);
      if (!syncTargets.length) {
        setLoading("idle");
        return;
      }

      setSyncProgress({ done: 0, total: syncTargets.length });
      setLiveProgressByRow(() => {
        const initial: Record<string, LiveRowProgress> = {};
        for (const target of syncTargets) {
          initial[target] = { stage: "aguardando", percent: 0, subtitle: "Na fila para processar", tone: "idle" };
        }
        return initial;
      });

      const startRes = await fetch("http://127.0.0.1:8765/sync/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_dir: effectiveSourceDir,
          output_dir: effectiveOutputDir,
          alass_path: null,
          preserve_subfolders: preserveFolders,
          force_resync: forceNow || forceResync,
          force_download: forceDownload,
          auto_download_missing_subtitles: autoDownloadMissing,
          language,
          ignore_embedded_subtitles: ignoreEmbedded,
          targets: syncTargets,
          embed_softsub: embedSoftsub,
          update_original: updateOriginal,
          keep_bak: keepBak,
          subtitle_default: subtitleDefault,
          subtitle_track: subtitleTrack,
          timeout_seconds: timeoutSeconds,
          retries,
        }),
      });
      if (!startRes.ok) {
        setLiveProgressByRow({});
        await handleSyncProgressLegacy(syncTargets, forceNow, effectiveSourceDir, effectiveOutputDir);
        return;
      }
      const startData = await startRes.json();
      if (!startData.ok || !startData.job_id) {
        setLiveProgressByRow({});
        await handleSyncProgressLegacy(syncTargets, forceNow, effectiveSourceDir, effectiveOutputDir);
        return;
      }

      const jobId = String(startData.job_id);
      setActiveSyncJobId(jobId);
      setSyncPaused(false);

      const applyFinishedJobPayload = (payload: Record<string, unknown>) => {
        if (Array.isArray(payload.rows)) {
          const normalized: Row[] = (payload.rows as Record<string, unknown>[]).map(normalizeRow);
          const updatedByKey = new Map<string, Row>(normalized.map((r: Row) => [r.video_full || r.video, r]));
          if (targets && targets.length) {
            setRows((prev) => prev.map((r) => updatedByKey.get(r.video_full || r.video) || r));
          } else {
            setRows(normalized);
          }
        }
        if (Array.isArray(payload.logs) && payload.logs.length) {
          setLogs((old) => [...(payload.logs as string[]).map((x: string) => nowLog(x)), ...old]);
        }
        const summary = (payload.summary as Record<string, unknown>) || {};
        const totalFromSummary = Number(summary.total || syncTargets.length);
        setSyncProgress({ done: totalFromSummary, total: totalFromSummary });
      };

      const reconcileAfterStreamDrop = async () => {
        let activeAttempts = 0;
        while (activeAttempts < 90) {
          const statusRes = await fetch(`http://127.0.0.1:8765/sync/status/${encodeURIComponent(jobId)}`);
          if (statusRes.ok) {
            const statusData = (await statusRes.json()) as Record<string, unknown>;
            const status = String(statusData.status || "");
            const paused = Boolean(statusData.paused);
            const pauseState = String(statusData.pause_state || "");
            setSyncPauseState(
              pauseState === "pausing" || pauseState === "paused" || pauseState === "cancelling"
                ? pauseState
                : paused
                  ? "pausing"
                  : "running",
            );
            if (status === "failed") {
              throw new Error(String(statusData.error || "Falha na sincronizacao"));
            }
            if (status === "done" || status === "cancelled") {
              const resultRes = await fetch(`http://127.0.0.1:8765/sync/result/${encodeURIComponent(jobId)}`);
              if (!resultRes.ok) {
                throw new Error("Job finalizado, mas resultado final nao ficou disponivel.");
              }
              const resultData = (await resultRes.json()) as Record<string, unknown>;
              applyFinishedJobPayload(resultData);
              return;
            }
            if (!paused) activeAttempts += 1;
          }
          await delay(800);
        }
        throw new Error("Conexao de progresso interrompida e o backend nao confirmou conclusao a tempo.");
      };

      await new Promise<void>((resolve, reject) => {
        const stream = new EventSource(`http://127.0.0.1:8765/sync/events/${encodeURIComponent(jobId)}`);
        let finished = false;
        let recovering = false;

        const closeAndResolve = () => {
          if (finished) return;
          finished = true;
          stream.close();
          resolve();
        };
        const closeAndReject = (error: unknown) => {
          if (finished) return;
          finished = true;
          stream.close();
          reject(error);
        };
        const parseEvent = (event: MessageEvent) => {
          try {
            return JSON.parse(String(event.data || "{}")) as Record<string, unknown>;
          } catch {
            return {} as Record<string, unknown>;
          }
        };

        stream.addEventListener("job_ready", (event) => {
          const data = parseEvent(event as MessageEvent);
          const totalFromEvent = Number(data.total || 0);
          if (totalFromEvent > 0) {
            setSyncProgress((prev) => ({ ...prev, total: totalFromEvent }));
          }
          if (Array.isArray(data.rows)) {
            const normalized: Row[] = (data.rows as Record<string, unknown>[]).map(normalizeRow);
            const updatedByKey = new Map<string, Row>(normalized.map((r: Row) => [r.video_full || r.video, r]));
            setRows((prev) => prev.map((r) => updatedByKey.get(r.video_full || r.video) || r));
          }
        });

        stream.addEventListener("job_pause_requested", () => {
          setSyncPauseState("pausing");
        });

        stream.addEventListener("job_paused", () => {
          setSyncPauseState("paused");
        });

        stream.addEventListener("job_resumed", () => {
          setSyncPauseState("running");
        });

        stream.addEventListener("job_cancel_requested", () => {
          setSyncPauseState("cancelling");
        });

        stream.addEventListener("job_cancelled", () => {
          setSyncPauseState("cancelling");
        });

        stream.addEventListener("row_progress", (event) => {
          const data = parseEvent(event as MessageEvent);
          const rowIndex = Number(data.index || 0);
          const totalFromEvent = Number(data.total || syncTargets.length || 0);
          const rowPercent = Math.max(0, Math.min(100, Number(data.percent || 0)));
          if (rowIndex > 0 && totalFromEvent > 0) {
            setSyncProgress({ done: Math.max(0, rowIndex - 1) + rowPercent / 100, total: totalFromEvent });
          }
          const key = String(data.video_full || data.video || "");
          if (!key) return;
          const toneRaw = String(data.tone || "run");
          const tone: LiveRowProgress["tone"] = toneRaw === "ok" || toneRaw === "fail" || toneRaw === "idle" ? toneRaw : "run";
          setLiveProgressByRow((prev) => ({
            ...prev,
            [key]: {
              stage: String(data.stage || "processando"),
              percent: rowPercent,
              subtitle: String(data.subdetail || data.detail || ""),
              tone,
            },
          }));
        });

        stream.addEventListener("row_result", (event) => {
          const data = parseEvent(event as MessageEvent);
          const rowData = data.row;
          if (rowData && typeof rowData === "object") {
            const normalized = normalizeRow(rowData as Record<string, unknown>);
            const key = normalized.video_full || normalized.video;
            setRows((prev) => prev.map((r) => ((r.video_full || r.video) === key ? normalized : r)));
            if (["OK", "PULADO", "FALHOU", "SEM_LEGENDA"].includes(normalized.status)) {
              const finalInfo = rowProgressInfo(normalized, normalized.status as DisplayStatus, "synced");
              setLiveProgressByRow((prev) => ({ ...prev, [key]: finalInfo }));
            }
          }
          const done = Number(data.done || 0);
          const totalFromEvent = Number(data.total || 0);
          if (done >= 0 && totalFromEvent >= 0) {
            setSyncProgress({ done, total: totalFromEvent || syncTargets.length });
          }
        });

        stream.addEventListener("job_progress", (event) => {
          const data = parseEvent(event as MessageEvent);
          const done = Number(data.done || 0);
          const totalFromEvent = Number(data.total || syncTargets.length);
          setSyncProgress({ done, total: totalFromEvent });
        });

        stream.addEventListener("job_finished", (event) => {
          const data = parseEvent(event as MessageEvent);
          applyFinishedJobPayload(data);
          closeAndResolve();
        });

        stream.addEventListener("job_failed", (event) => {
          const data = parseEvent(event as MessageEvent);
          closeAndReject(new Error(String(data.error || "Falha na sincronização")));
        });

        stream.onerror = () => {
          if (finished || recovering) return;
          recovering = true;
          stream.close();
          setErrorMsg("Conexão de progresso interrompida. Reconciliando estado...");
          void reconcileAfterStreamDrop()
            .then(() => {
              setErrorMsg("");
              closeAndResolve();
            })
            .catch((error) => {
              closeAndReject(error);
            });
        };
      });
    } catch (err) {
      setErrorMsg(friendlyError(err));
      setLogs((old) => [nowLog(`[FALHOU] Sync: ${friendlyError(err)}`), ...old]);
    } finally {
      setActiveSyncJobId("");
      setSyncPaused(false);
      setLiveProgressByRow({});
      setSyncProgress({ done: 0, total: 0 });
      setLoading("idle");
    }
  }

  function handleReprocessFails() {
    const failed = retryableIssueRows.map((r) => r.video_full!);
    if (!failed.length) return;
    void handleSyncProgress(failed, true);
  }

  function toggleRow(key: string) {
    setOpenRowMenu(null);
    setExpandedRows((old) => ({ ...old, [key]: !old[key] }));
  }

  async function openPath(path: string) {
    if (!path) return;
    try {
      const ok = await checkBackend();
      if (!ok) throw new Error("Backend offline.");
      const res = await fetch("http://127.0.0.1:8765/open-path", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Falha ao abrir pasta");
      setLogs((old) => [nowLog("Pasta aberta no Explorer."), ...old]);
    } catch (err) {
      setErrorMsg(friendlyError(err));
      setLogs((old) => [nowLog(`[FALHOU] Abrir pasta: ${friendlyError(err)}`), ...old]);
    }
  }

  async function copyPath(path: string) {
    if (!path) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(path);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = path;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setLogs((old) => [nowLog("Caminho copiado."), ...old]);
    } catch (err) {
      setErrorMsg(`Não foi possível copiar o caminho: ${friendlyError(err)}`);
    }
  }

  const providerIds: ProviderId[] = ["subdl", "opensubtitles", "subsource"];

  function renderApiKeyField(providerId: ProviderId, provider?: ProviderConfig, draft: Record<string, string> = {}) {
    const isVisible = visibleProviderKeys[providerId] ?? false;
    const savedPlaceholder = provider?.api_key_masked ? `Chave salva (${provider.api_key_masked})` : "Chave salva";
    return (
      <label className="api-key-field">
        API key
        <div className="secret-input">
          <input
            type={isVisible ? "text" : "password"}
            value={draft.api_key || ""}
            onChange={(e) => updateProviderDraft(providerId, "api_key", e.target.value)}
            placeholder={provider?.has_api_key ? savedPlaceholder : "Cole a API key"}
          />
          <button
            className="secret-toggle"
            type="button"
            aria-label={isVisible ? "Esconder API key" : "Mostrar API key"}
            title={isVisible ? "Esconder API key" : "Mostrar API key"}
            onClick={() => setVisibleProviderKeys((old) => ({ ...old, [providerId]: !isVisible }))}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
              <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
              {!isVisible ? <path d="M4 20 20 4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /> : null}
            </svg>
          </button>
        </div>
      </label>
    );
  }

  function renderProviderList() {
    return (
      <div className="provider-list">
        {providerIds.map((providerId) => {
          const provider = providers?.[providerId];
          const draft = providerDrafts[providerId] || {};
          const status = providerStatus(provider, providerId);
          return (
            <div className="provider-list-item" key={providerId}>
              <button className={`provider-row ${openProvider === providerId ? "active" : ""}`} type="button" onClick={() => setOpenProvider(openProvider === providerId ? null : providerId)}>
                <div>
                  <strong>{providerLabel(providerId)}</strong>
                  <small>{status.description}</small>
                </div>
                <span
                  className={`status-pill ${status.className} ${provider ? "status-pill-toggle" : ""}`}
                  role={provider ? "button" : undefined}
                  tabIndex={provider ? 0 : undefined}
                  onClick={(event) => {
                    if (!provider) return;
                    event.stopPropagation();
                    void toggleProvider(providerId);
                  }}
                  onKeyDown={(event) => {
                    if (!provider) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      event.stopPropagation();
                      void toggleProvider(providerId);
                    }
                  }}
                >
                  {status.chip}
                </span>
                <span className="chevron">{openProvider === providerId ? "^" : "v"}</span>
              </button>

              {openProvider === providerId ? (
                <div className={`inline-form ${providerId === "opensubtitles" ? "open-provider-form" : ""}`}>
                  {providerId !== "subliminal" ? (
                    renderApiKeyField(providerId, provider, draft)
                  ) : (
                    <div className="provider-note">Usa Subliminal com OpenSubtitles e Podnapisi. Nao precisa configurar API key.</div>
                  )}
                  {providerId === "opensubtitles" ? (
                    <>
                      <label>
                        Usuario (opcional)
                        <input value={draft.username ?? provider?.username ?? ""} onChange={(e) => updateProviderDraft(providerId, "username", e.target.value)} />
                      </label>
                      <label>
                        Senha (opcional)
                        <input type="password" value={draft.password || ""} onChange={(e) => updateProviderDraft(providerId, "password", e.target.value)} placeholder={provider?.has_password ? "Senha salva" : "Cole a senha"} />
                      </label>
                      <div className="provider-note">API key obrigatória. Usuário e senha são opcionais para validar sua conta e limites de download.</div>
                    </>
                  ) : null}
                  <label>
                    Prioridade
                    <input type="number" min={1} max={9} value={draft.priority ?? provider?.priority ?? 1} onChange={(e) => updateProviderDraft(providerId, "priority", e.target.value)} />
                  </label>
                  <button className="primary-btn provider-small-btn" onClick={() => void saveProvider(providerId)}>Salvar</button>
                  <button className="provider-small-btn" onClick={() => void testProvider(providerId)}>Testar</button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    );
  }

  function renderLanguageCard() {
    return (
      <article className="panel config-card side-card">
        <h2>1. Idioma e fontes</h2>
        <div className="config-two compact-config-two">
          <label>
            Idioma da legenda
            <select value={language} onChange={(e) => setLanguage(e.target.value)}>
              <option>pt-BR</option>
              <option>pt-PT</option>
              <option>en</option>
              <option>es</option>
            </select>
          </label>
          <div className="embedded-language">
            <small>Idioma alvo detectado nas trilhas embutidas</small>
            <b>{language}</b>
          </div>
        </div>
      </article>
    );
  }

  function renderProvidersCard() {
    return (
      <article className="panel config-card side-card">
        <h2>Provedores de legenda</h2>
        {renderProviderList()}
        {providerMessage ? <div className="provider-message">{providerMessage}</div> : null}
      </article>
    );
  }

  function renderToolsCard(withNumber = false) {
    return (
      <article className="panel config-card side-card">
        <h2>{withNumber ? "2. Ferramentas" : "Ferramentas"}</h2>
        <div className="tools-grid tools-grid-status">
          <div>
            <span className="label">Status das dependências</span>
            <div className="deps">
              <span className={deps?.alass?.found ? "ok" : "bad"}>ALASS {deps?.alass?.found ? "OK" : "OFF"}</span>
              <span className={deps?.ffmpeg?.found ? "ok" : "bad"}>FFmpeg {deps?.ffmpeg?.found ? "OK" : "OFF"}</span>
              <span className={deps?.ffprobe?.found ? "ok" : "bad"}>FFprobe {deps?.ffprobe?.found ? "OK" : "OFF"}</span>
            </div>
            <small>As ferramentas ficam na pasta runtime do aplicativo. Use esta área para atualizar ou reparar.</small>
          </div>
        </div>
        <div className="tool-actions single-action">
          <button className="primary-btn" onClick={() => void installDeps("all")} disabled={loading !== "idle"}>
            {loading === "sync" ? "Atualizando..." : "Atualizar dependências"}
          </button>
        </div>
        {depsMessage ? <div className="deps-message">{depsMessage}</div> : null}
      </article>
    );
  }

  function renderExplorerCard() {
    const showExplorerMessage = explorerMessage && explorerMessage !== "Integração instalada.";
    return (
      <article className="panel config-card explorer-card">
        <div className="config-card-title-row">
          <h2>Menu do Explorer</h2>
          <span className={`status-pill ${explorerStatus?.installed ? "ok" : "off"}`}>
            {explorerStatus?.installed ? "Instalada" : "Off"}
          </span>
        </div>
        <p>Ações no menu de contexto para arquivos de vídeo.</p>
        <div className="explorer-actions compact">
          <button
            className="primary-btn"
            onClick={() => void runExplorerIntegration("install")}
            disabled={explorerBusy !== "idle"}
          >
            {explorerBusy === "install" ? "Instalando..." : explorerStatus?.installed ? "Atualizar" : "Instalar"}
          </button>
          <button
            onClick={() => void runExplorerIntegration("uninstall")}
            disabled={explorerBusy !== "idle" || !explorerStatus?.installed}
          >
            {explorerBusy === "uninstall" ? "Removendo..." : "Remover"}
          </button>
          <button type="button" onClick={showDepsSetupAgain}>
            Mostrar tela inicial
          </button>
        </div>
        {showExplorerMessage ? <div className="deps-message">{explorerMessage}</div> : null}
      </article>
    );
  }

  function renderDepsSetupModal() {
    const firstRunBusy = loading !== "idle" || explorerBusy !== "idle";
    const depsChip = !depsKnown ? "Verificando" : depsReady ? "Instalado" : "Necessario";
    const depsChipClass = depsReady ? "ok" : depsKnown ? "bad" : "warn";
    const explorerSetupSelected = Boolean(explorerStatus?.installed || installExplorerOnSetup);
    const explorerChip = !explorerKnown
      ? "Verificando"
      : explorerStatus?.installed
        ? "Instalado"
        : installExplorerOnSetup
          ? "Selecionado"
          : "Opcional";
    const explorerChipClass = explorerStatus?.installed ? "ok" : installExplorerOnSetup ? "warn" : "muted";
    const setupComplete = !depsMissing && (!explorerMissing || !installExplorerOnSetup);
    const primaryLabel = firstRunBusy
      ? loading !== "idle"
        ? "Baixando dependencias..."
        : "Instalando menu..."
      : depsMissing && explorerMissing && installExplorerOnSetup
        ? "Instalar tudo"
        : depsMissing
          ? "Baixar dependencias"
          : explorerMissing && installExplorerOnSetup
            ? "Instalar menu do Explorer"
            : "Entrar no Syncora";
    const handlePrimarySetupAction = setupComplete ? dismissDepsSetup : runDepsSetup;

    return (
      <div className="setup-overlay" role="presentation">
        <section className="setup-modal first-run-modal" role="dialog" aria-modal="true" aria-labelledby="deps-setup-title">
          <div className="setup-modal-head">
            <div className="setup-modal-icon">✓</div>
            <div>
              <h2 id="deps-setup-title">Preparar o Syncora</h2>
              <p>Instale o que falta para usar o app sem voltar na configuração depois.</p>
            </div>
          </div>

          <div className="setup-modal-body first-run-body">
            <div className={`setup-dep-row setup-task-row ${depsReady ? "done" : ""}`}>
              <span className="setup-check">{depsReady ? "✓" : "1"}</span>
              <div>
                <strong>Dependências</strong>
                <small>Baixa ALASS, FFmpeg e FFprobe para sincronizar e embutir legendas.</small>
                <div className="setup-mini-chips">
                  <span className={`status-pill ${deps?.alass?.found ? "ok" : "bad"}`}>ALASS {deps?.alass?.found ? "OK" : "OFF"}</span>
                  <span className={`status-pill ${deps?.ffmpeg?.found ? "ok" : "bad"}`}>FFmpeg {deps?.ffmpeg?.found ? "OK" : "OFF"}</span>
                  <span className={`status-pill ${deps?.ffprobe?.found ? "ok" : "bad"}`}>FFprobe {deps?.ffprobe?.found ? "OK" : "OFF"}</span>
                </div>
              </div>
              <span className={`status-pill ${depsChipClass}`}>{depsChip}</span>
            </div>
            <label className={`setup-dep-row setup-task-row setup-choice-row ${explorerStatus?.installed ? "done" : ""} ${explorerSetupSelected ? "selected" : ""}`}>
              <input
                type="checkbox"
                checked={explorerSetupSelected}
                disabled={firstRunBusy || explorerStatus?.installed}
                onChange={(event) => setInstallExplorerOnSetup(event.target.checked)}
              />
              <span className="setup-check">{explorerSetupSelected ? "✓" : "2"}</span>
              <div>
                <strong>Menu do Explorer</strong>
                <small>Adiciona Abrir com Syncora, Baixar legendas e Baixar legendas e sincronizar.</small>
              </div>
              <span className={`status-pill ${explorerChipClass}`}>{explorerChip}</span>
            </label>
            {depsMessage ? <div className="deps-message setup-message">{depsMessage}</div> : null}
            {explorerMessage && explorerMessage !== "Integração instalada." ? (
              <div className="deps-message setup-message">{explorerMessage}</div>
            ) : null}
          </div>

          <div className="setup-modal-actions">
            <button type="button" onClick={dismissDepsSetup} disabled={firstRunBusy}>Pular por agora</button>
            <button className="primary-btn" type="button" onClick={() => void handlePrimarySetupAction()} disabled={firstRunBusy}>
              {primaryLabel}
            </button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="app-shell syncora-v2" data-theme={theme}>
      <header className="titlebar">
        <div className="brand">
          <img className="brand-mark" src="/syncora-icon.svg" alt="" aria-hidden="true" />
          <div className="brand-name">Syncora</div>
        </div>
        <nav className="tabs">
          <button className={activeTab === "fila" ? "active" : ""} onClick={() => setActiveTab("fila")}>
            <span>▪</span> Fila
          </button>
          <button className={activeTab === "config" ? "active" : ""} onClick={() => setActiveTab("config")}>
            <span>⚙</span> Configuração
          </button>
        </nav>
        <div className="top-actions">
          <button className="theme-btn" onClick={() => setTheme((value) => (value === "dark" ? "light" : "dark"))}>
            {theme === "dark" ? "☀" : "☾"}
          </button>
        </div>
      </header>

      {showErrorBanner ? <div className="error-banner">{errorMsg}</div> : null}

      <main className="content">
        <div className="content-inner">
        {activeTab === "fila" ? (
          <>
            {backendOk === false ? (
              <section className="phase-strip bad">
                <div>
                  <strong>{phaseInfo.title}</strong>
                  <span>{phaseInfo.text}</span>
                </div>
                <span>{summary.total} item(ns)</span>
                <span>Backend offline</span>
              </section>
            ) : null}

            <section className="panel path-panel">
              <div className="path-field">
                <label>Pasta origem (vídeos + legendas)</label>
                <div className="input-action">
                  <input value={sourceDir} onChange={(e) => applySourceDir(e.target.value)} />
                  <button onClick={() => void pickPathAsync("origem")}><span>□</span> Procurar</button>
                </div>
              </div>
              <div className="path-field">
                <label>Pasta de saída</label>
                <div className="input-action">
                  <input value={outputDir} onChange={(e) => applyOutputDir(e.target.value, true)} />
                  <button onClick={() => void pickPathAsync("saida")}><span>□</span> Procurar</button>
                </div>
              </div>
              <button className="scan-btn" onClick={handleScan} disabled={loading !== "idle"}>
                <span>⌕</span>{loading === "scan" ? "Escaneando..." : "Escanear"}
              </button>
              <button
                className={`primary-btn sync-btn ${syncPaused ? "paused" : ""}`}
                onClick={handleSyncButton}
                disabled={loading === "scan" || (loading === "sync" && (!activeSyncJobId || syncPauseState === "cancelling")) || (loading !== "sync" && !canUseSyncButton)}
              >
                <span>{syncButtonIcon}</span>{syncButtonLabel}
              </button>
            </section>

            <section className={`panel queue-options-panel ${showQueueOptions ? "" : "collapsed"}`}>
              <div className="queue-options-head">
                <div className="queue-option-summary">
                  <strong>Opções</strong>
                  <span>{preserveFolders ? "Subpastas" : "Sem subpastas"}</span>
                  <span>{autoDownloadMissing ? "Busca online" : "Sem busca online"}</span>
                  <span>{syncAfterDownload ? "Sync on" : "Só download"}</span>
                  <span>{embedSoftsub ? "Softsub on" : "Softsub off"}</span>
                  <span>Timeout {timeoutSeconds}s</span>
                </div>
                <button onClick={() => setShowQueueOptions((value) => !value)}>{showQueueOptions ? "Fechar opções" : "Abrir opções"}</button>
              </div>
              {showQueueOptions ? (
                <div className="queue-option-content compact-options opcoes-body">
                  <div className="option-group behavior-group opcao-card">
                    <div className="opcao-titulo">Comportamento</div>
                    <div className="option-two-cols">
                      <label className="switch-row toggle-row">
                        <input type="checkbox" checked={autoDownloadMissing} onChange={(e) => setAutoDownloadMissing(e.target.checked)} />
                        <span className="switch" />
                        Busca online
                      </label>
                      <label className="switch-row toggle-row">
                        <input
                          type="checkbox"
                          checked={ignoreEmbedded || forceDownload}
                          onChange={(e) => {
                            setIgnoreEmbedded(e.target.checked);
                            setForceDownload(e.target.checked);
                          }}
                        />
                        <span className="switch" />
                        Forçar busca
                      </label>
                      <label className="switch-row toggle-row">
                        <input type="checkbox" checked={syncAfterDownload} onChange={(e) => setSyncAfterDownload(e.target.checked)} />
                        <span className="switch" />
                        Sincronizar após baixar
                      </label>
                      <label className="switch-row toggle-row">
                        <input type="checkbox" checked={forceResync} onChange={(e) => setForceResync(e.target.checked)} />
                        <span className="switch" />
                        Forçar sincronização
                      </label>
                    </div>
                  </div>

                  <div className="option-group output-group opcao-card">
                    <div className="opcao-titulo">Saída</div>
                    <div className="option-two-cols">
                      <label className="switch-row toggle-row">
                        <input type="checkbox" checked={preserveFolders} onChange={(e) => setPreserveFolders(e.target.checked)} />
                        <span className="switch" />
                        Manter subpastas
                      </label>
                      <label className="switch-row toggle-row">
                        <input type="checkbox" checked={embedSoftsub} onChange={(e) => setEmbedSoftsub(e.target.checked)} />
                        <span className="switch" />
                        Embutir softsub
                      </label>
                      <label className="switch-row toggle-row">
                        <input type="checkbox" checked={subtitleDefault} onChange={(e) => setSubtitleDefault(e.target.checked)} />
                        <span className="switch" />
                        Legenda default
                      </label>
                    </div>
                    <label className="text-setting wide-setting opcao-label-muted">
                      Trilha
                      <input value={subtitleTrack} onChange={(e) => setSubtitleTrack(e.target.value)} placeholder="Portuguese (Sync)" />
                    </label>
                  </div>

                  <div className="option-group advanced-group opcao-card">
                    <div className="opcao-titulo">Avançado</div>
                    <div className="advanced-compact opcao-grid-2col">
                      <label className="text-setting opcao-label-muted">
                        Timeout
                        <input type="number" min={30} value={timeoutSeconds} onChange={(e) => setTimeoutSeconds(Number(e.target.value) || 900)} />
                      </label>
                      <label className="text-setting opcao-label-muted">
                        Retries
                        <input type="number" min={0} max={10} value={retries} onChange={(e) => setRetries(Number(e.target.value) || 0)} />
                      </label>
                    </div>
                  </div>
                </div>
              ) : null}
            </section>

            <section className="queue-table">
              <div className="table-toolbar">
                <strong>Fila de processamento</strong>
                <div className="filter-tabs" aria-label="Filtros da fila">
                  <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>Todos <b>{summary.total}</b></button>
                  <button className={filter === "ready" ? "active" : ""} onClick={() => setFilter("ready")} disabled={phase !== "scanned"}>Aguardando <b>{summary.ready}</b></button>
                  <button className={filter === "ok" ? "active" : ""} onClick={() => setFilter("ok")}>OK <b>{summary.ok}</b></button>
                  <button className={filter === "skip" ? "active" : ""} onClick={() => setFilter("skip")}>Pulados <b>{summary.skip}</b></button>
                  <button className={filter === "fail" ? "active" : ""} onClick={() => setFilter("fail")}>Falhas <b>{summary.fail}</b></button>
                </div>
              </div>
              <div className="table-head">
                <span>Vídeo</span><span>Andamento</span><span>Ações</span>
              </div>
              <div className="table-body">
                {rows.length === 0 ? (
                  <div className="empty-state">
                    <strong>Nenhum vídeo escaneado ainda</strong>
                    <span>Preencha as pastas acima e clique em Escanear para montar a fila.</span>
                  </div>
                ) : filteredRows.length === 0 ? (
                  <div className="empty-state">
                    <strong>Nenhum item neste filtro</strong>
                    <span>Troque o filtro para ver os outros arquivos da fila.</span>
                  </div>
                ) : (
                  filteredRows.map((row) => {
                    const displayStatus = getDisplayStatus(row, phase);
                    const rowKey = row.video_full || row.video;
                    const liveProgress = loading === "sync" ? liveProgressByRow[rowKey] : undefined;
                    const progressInfo = rowProgressInfo(row, displayStatus, phase, liveProgress);
                    const key = `${row.video}-${row.video_full || row.path}`;
                    const outputTarget = row.outputPath || row.output || row.path || row.video_full || "";
                    const sourceTarget = row.path || row.video_full || outputTarget;
                    const copyTarget = row.outputPath || row.video_full || row.path || row.output || "";
                    const mainActionLabel = displayStatus === "FALHOU"
                      ? "Reprocessar"
                      : displayStatus === "OK" || displayStatus === "PULADO"
                        ? "Abrir saída"
                        : "Abrir pasta";
                    return (
                      <div className="table-item" key={key}>
                        <div className="table-row">
                          <div className="file-cell queue-video">
                            <strong title={row.video}>{row.video || "-"}</strong>
                            <small title={row.path}>{row.path || pathName(row.video_full || "")}</small>
                          </div>
                          <div className={`queue-progress ${progressInfo.tone}`}>
                            <div className="queue-progress-head">
                              <span>{progressInfo.stage}</span>
                              <span>{progressInfo.percent}%</span>
                            </div>
                            <div className="queue-progress-bar">
                              <div style={{ width: `${progressInfo.percent}%` }} />
                            </div>
                            <small title={progressInfo.subtitle}>{progressInfo.subtitle}</small>
                          </div>
                          <div className="row-actions compact-actions">
                            {displayStatus === "FALHOU" && row.video_full ? (
                              <button className="main" title={mainActionLabel} aria-label={mainActionLabel} onClick={() => void handleSync([row.video_full!], true)}>{"\u21bb"}</button>
                            ) : (
                              <button
                                className={displayStatus === "OK" || displayStatus === "PULADO" ? "main" : ""}
                                title={mainActionLabel}
                                aria-label={mainActionLabel}
                                onClick={() => void openPath(displayStatus === "OK" || displayStatus === "PULADO" ? outputTarget : sourceTarget)}
                              >
                                {displayStatus === "OK" || displayStatus === "PULADO" ? "\u2713" : "\u2197"}
                              </button>
                            )}
                            <button
                              className={openRowMenu === key ? "active" : ""}
                              title="Mais ações"
                              aria-label="Mais ações"
                              onClick={() => setOpenRowMenu((current) => (current === key ? null : key))}
                            >
                              ...
                            </button>
                          </div>
                        </div>
                        {openRowMenu === key ? (
                          <div className="row-menu-inline">
                            <button onClick={() => toggleRow(key)}>{expandedRows[key] ? "Ocultar detalhes" : "Detalhes"}</button>
                            <button onClick={() => { setOpenRowMenu(null); void openPath(sourceTarget); }}>Abrir pasta</button>
                            <button onClick={() => { setOpenRowMenu(null); void copyPath(copyTarget); }}>Copiar caminho</button>
                          </div>
                        ) : null}
                        {expandedRows[key] ? (
                          <div className="row-details">
                            <span><b>Vídeo:</b> {row.video_full || row.path || "-"}</span>
                            <span><b>Legenda:</b> {row.subtitle || "-"} {row.subtitleMeta ? `(${row.subtitleMeta})` : ""}</span>
                            <span><b>Saída:</b> {phase === "scanned" ? "Aguardando sincronização" : row.output || "-"}</span>
                            <span><b>Info:</b> {friendlyRowMessage(row, "-")}</span>
                          </div>
                        ) : null}
                      </div>
                    );
                  })
                )}
              </div>
            </section>

            <section className={`dashboard-row ${summary.total === 0 ? "empty" : ""} ${showLog ? "" : "compact-dashboard"}`}>
              <article className="panel progress-panel">
                <h3>Progresso geral</h3>
                <div className="progress-line"><div style={{ width: `${progress}%` }} /></div>
                <strong>{progress}%</strong>
                <div className="stats">
                  <div><small>Total</small><b>{summary.total}</b></div>
                  <div><small>Concluídos</small><b className="ok-text">{summary.ok}</b></div>
                  <div><small>Pulados</small><b className="skip-text">{summary.skip}</b></div>
                  <div><small>Falhas</small><b className="fail-text">{summary.fail}</b></div>
                </div>
                <button className="log-toggle compact-log-toggle" onClick={() => setShowLog((value) => !value)}>{showLog ? "Ocultar log" : "Mostrar log"}</button>
              </article>

              {showLog ? (
                <article className="panel log-panel">
                  <div className="panel-head">
                    <h3>Log <span>(últimas atividades)</span></h3>
                    <button onClick={() => setLogs([])}>Limpar</button>
                  </div>
                  {logs.length ? (
                    <ul>
                      {logs.slice(0, 40).map((line, index) => (
                        <li key={`${line}-${index}`} className={line.includes("FALHOU") ? "fail" : line.includes("PULADO") ? "skip" : line.includes("[OK]") ? "ok" : ""}>
                          {line}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="log-empty">Sem atividades ainda.</div>
                  )}
                </article>
              ) : null}
            </section>
          </>
        ) : (
          <section className="config-page syncora-config">
            <div className="config-main-grid">
              {renderLanguageCard()}
              {renderProvidersCard()}
            </div>
            {renderToolsCard(false)}
            {renderExplorerCard()}
            {showLegacyConfig && (
            <>
            <article className="panel config-card">
              <h2>1. Idioma e fontes</h2>
              <div className="config-two">
                <label>
                  Idioma da legenda
                  <select value={language} onChange={(e) => setLanguage(e.target.value)}>
                    <option>pt-BR</option>
                    <option>pt-PT</option>
                    <option>en</option>
                    <option>es</option>
                  </select>
                </label>
                <div className="embedded-language">
                  <small>Idioma alvo detectado nas trilhas embutidas</small>
                  <b>{language}</b>
                </div>
              </div>
              <h3 className="subsection-title">Provedores de legenda</h3>
              <div className="provider-list">
                {(["subdl", "opensubtitles", "subsource"] as ProviderId[]).map((providerId) => {
                  const provider = providers?.[providerId];
                  const draft = providerDrafts[providerId] || {};
                  const status = providerStatus(provider, providerId);
                  return (
                    <div className="provider-list-item" key={providerId}>
                      <button
                        className={`provider-row ${openProvider === providerId ? "active" : ""}`}
                        type="button"
                        onClick={() => setOpenProvider(openProvider === providerId ? null : providerId)}
                      >
                        <div>
                          <strong>{providerLabel(providerId)}</strong>
                          <small>{status.description}</small>
                        </div>
                        <span className={`status-pill ${status.className}`}>
                          {status.chip}
                        </span>
                        {provider ? (
                          <span
                            className="row-action"
                            role="button"
                            tabIndex={0}
                            onClick={(event) => {
                              event.stopPropagation();
                              void toggleProvider(providerId);
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                event.stopPropagation();
                                void toggleProvider(providerId);
                              }
                            }}
                          >
                            {provider.enabled === false ? "Ativar" : "Desativar"}
                          </span>
                        ) : null}
                        <span className="chevron">{openProvider === providerId ? "⌃" : "⌄"}</span>
                      </button>
                      {openProvider === providerId ? (
                        <div className={`inline-form ${providerId === "opensubtitles" ? "open-provider-form" : ""}`}>
                          {providerId !== "subliminal" ? (
                            renderApiKeyField(providerId, provider, draft)
                          ) : (
                            <div className="provider-note">
                              Usa Subliminal com OpenSubtitles e Podnapisi. Não precisa configurar API key.
                            </div>
                          )}
                          {providerId === "opensubtitles" ? (
                            <>
                              <label>
                                Usuário (opcional)
                                <input value={draft.username ?? provider?.username ?? ""} onChange={(e) => updateProviderDraft(providerId, "username", e.target.value)} />
                              </label>
                              <label>
                                Senha (opcional)
                                <input type="password" value={draft.password || ""} onChange={(e) => updateProviderDraft(providerId, "password", e.target.value)} placeholder={provider?.has_password ? "Senha salva" : "Cole a senha"} />
                              </label>
                              <div className="provider-note">
                                API key obrigatória. Usuário e senha são opcionais para validar sua conta e limites de download.
                              </div>
                            </>
                          ) : null}
                          <label>
                            Prioridade
                            <input type="number" min={1} max={9} value={draft.priority ?? provider?.priority ?? 1} onChange={(e) => updateProviderDraft(providerId, "priority", e.target.value)} />
                          </label>
                          <button className="primary-btn provider-small-btn" onClick={() => void saveProvider(providerId)}>Salvar</button>
                          <button className="provider-small-btn" onClick={() => void testProvider(providerId)}>Testar</button>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              {providerMessage ? <div className="provider-message">{providerMessage}</div> : null}
            </article>

            <article className="panel config-card">
              <h2>2. Ferramentas</h2>
              <div className="tools-grid tools-grid-status">
                <div>
                  <span className="label">Status das dependências</span>
                  <div className="deps">
                    <span className={deps?.alass?.found ? "ok" : "bad"}>ALASS {deps?.alass?.found ? "OK" : "OFF"}</span>
                    <span className={deps?.ffmpeg?.found ? "ok" : "bad"}>FFmpeg {deps?.ffmpeg?.found ? "OK" : "OFF"}</span>
                    <span className={deps?.ffprobe?.found ? "ok" : "bad"}>FFprobe {deps?.ffprobe?.found ? "OK" : "OFF"}</span>
                  </div>
                  <small>As ferramentas ficam na pasta runtime do aplicativo. Use esta área para atualizar ou reparar.</small>
                </div>
              </div>
              <div className="tool-actions single-action">
                <button className="primary-btn" onClick={() => void installDeps("all")} disabled={loading !== "idle"}>
                  {loading === "sync" ? "Atualizando..." : "Atualizar dependências"}
                </button>
              </div>
              {depsMessage ? <div className="deps-message">{depsMessage}</div> : null}
            </article>

            <article className="panel config-card explorer-card">
              <div className="config-card-title-row">
                <h2>3. Integração do Windows</h2>
                <span className={`status-pill ${explorerStatus?.installed ? "ok" : "off"}`}>
                  {explorerStatus?.installed ? "Instalada" : "Off"}
                </span>
              </div>
              <p>
                Adiciona as ações Abrir com Syncora, Baixar legendas e Baixar legendas e sincronizar no Explorer.
              </p>
              <div className="explorer-actions">
                <button
                  className="primary-btn"
                  onClick={() => void runExplorerIntegration("install")}
                  disabled={explorerBusy !== "idle"}
                >
                  {explorerBusy === "install" ? "Instalando..." : explorerStatus?.installed ? "Atualizar integração" : "Instalar integração"}
                </button>
                <button
                  onClick={() => void runExplorerIntegration("uninstall")}
                  disabled={explorerBusy !== "idle" || !explorerStatus?.installed}
                >
                  {explorerBusy === "uninstall" ? "Removendo..." : "Remover"}
                </button>
                <button type="button" onClick={showDepsSetupAgain}>
                  Mostrar tela inicial
                </button>
              </div>
              {explorerMessage ? <div className="deps-message">{explorerMessage}</div> : null}
            </article>

            </>
            )}
          </section>
        )}
        </div>
      </main>
      {depsSetupOpen ? renderDepsSetupModal() : null}
      <footer className="statusbar">
        <span>{phaseInfo.title}</span>
        <span>{phase === "synced" ? `Tempo restante: 0 min` : `${summary.total} item(ns) na fila`}</span>
      </footer>
    </div>
  );
}
