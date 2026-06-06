import { useState, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

type Step = "terms" | "prepare" | "install" | "finish";

interface InstallOptions {
  installDeps: boolean;
  installExplorer: boolean;
  installPath: string;
}

interface InstallProgress {
  step: string;
  pct: number;
  done: boolean;
  error: string | null;
}

const SUPPORTED_LANGS = [
  { code: "pt-BR", label: "Portugues (Brasil)" },
  { code: "en", label: "English" },
  { code: "es", label: "Espanol" },
] as const;

export default function SetupWizard() {
  const { t, i18n } = useTranslation();
  const [step, setStep] = useState<Step>("terms");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [opts, setOpts] = useState<InstallOptions>({
    installDeps: true,
    installExplorer: true,
    installPath: "",
  });
  const [pathError, setPathError] = useState<string | null>(null);
  const [progress, setProgress] = useState<InstallProgress>({
    step: "",
    pct: 0,
    done: false,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const path = await invoke<string>("get_default_install_path");
        if (!cancelled) {
          setOpts((o) => (o.installPath ? o : { ...o, installPath: path }));
        }
      } catch (err) {
        console.error("Falha ao obter caminho padrao:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<InstallProgress>("install-progress", (e) => {
        setProgress(e.payload);
        if (e.payload.done && !e.payload.error) {
          setStep("finish");
        }
      });
    })();
    return () => {
      unlisten?.();
    };
  }, []);

  async function pickFolder() {
    try {
      const selected = await open({
        directory: true,
        defaultPath: opts.installPath,
      });
      if (selected && typeof selected === "string") {
        setOpts((o) => ({ ...o, installPath: selected }));
        setPathError(null);
      }
    } catch (err) {
      console.error("Falha ao abrir seletor de pasta:", err);
    }
  }

  async function startInstall() {
    setPathError(null);
    try {
      await invoke("validate_install_path", { installPath: opts.installPath });
    } catch (e: unknown) {
      setPathError(String(e));
      return;
    }
    setStep("install");
    setProgress({ step: t("installer.steps.starting"), pct: 0, done: false, error: null });
    try {
      await invoke("start_install", { opts });
    } catch (e: unknown) {
      setProgress((p) => ({ ...p, error: String(e), done: true }));
    }
  }

  async function launchApp() {
    try {
      await invoke("launch_main_app");
    } catch (e) {
      console.error("Falha ao abrir Syncora:", e);
    }
  }

  const steps = useMemo(
    () => [
      { id: "terms" as Step, label: t("installer.steps.terms") },
      { id: "prepare" as Step, label: t("installer.steps.prepare") },
      { id: "install" as Step, label: t("installer.steps.install") },
      { id: "finish" as Step, label: t("installer.steps.finish") },
    ],
    [t],
  );

  return (
    <div className="setup-root">
      <Sidebar current={step} steps={steps} t={t} />
      <main className="setup-main">
        {step === "terms" && (
          <TermsPage
            accepted={termsAccepted}
            onChange={setTermsAccepted}
            onNext={() => setStep("prepare")}
            currentLang={i18n.language}
            onChangeLang={(lang) => void i18n.changeLanguage(lang)}
            t={t}
          />
        )}
        {step === "prepare" && (
          <PreparePage
            opts={opts}
            setOpts={(updater) => {
              setOpts(updater);
              setPathError(null);
            }}
            onPickFolder={pickFolder}
            onBack={() => setStep("terms")}
            onNext={startInstall}
            currentLang={i18n.language}
            onChangeLang={(lang) => void i18n.changeLanguage(lang)}
            pathError={pathError}
            t={t}
          />
        )}
        {step === "install" && <InstallPage progress={progress} t={t} />}
        {step === "finish" && (
          <FinishPage
            error={progress.error}
            onLaunch={launchApp}
            t={t}
          />
        )}
      </main>
    </div>
  );
}

interface SidebarProps {
  current: Step;
  steps: { id: Step; label: string }[];
  t: (key: string) => string;
}

function Sidebar({ current, steps, t }: SidebarProps) {
  const order: Step[] = ["terms", "prepare", "install", "finish"];
  const currentIdx = order.indexOf(current);

  return (
    <aside className="setup-sidebar">
      <div className="sidebar-brand">
        <div className="sidebar-logo">
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
            <circle cx="14" cy="14" r="13" stroke="var(--amber)" strokeWidth="2" />
            <path
              d="M8 14l4 4 8-8"
              stroke="var(--amber)"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <div>
          <div className="sidebar-app-name">Syncora</div>
          <div className="sidebar-app-tagline">{t("installer.sidebar.tagline")}</div>
        </div>
      </div>

      <nav className="sidebar-steps">
        {steps.map((s, i) => {
          const state =
            i < currentIdx ? "done" : i === currentIdx ? "active" : "pending";
          return (
            <div key={s.id} className={`sidebar-step sidebar-step--${state}`}>
              <div className="step-bubble">
                {state === "done" ? <CheckIcon /> : i + 1}
              </div>
              <span className="step-label">{s.label}</span>
            </div>
          );
        })}
      </nav>

      <p className="sidebar-desc">{t("installer.sidebar.description")}</p>
    </aside>
  );
}

interface TermsPageProps {
  accepted: boolean;
  onChange: (v: boolean) => void;
  onNext: () => void;
  currentLang: string;
  onChangeLang: (lang: string) => void;
  t: (key: string) => string;
}

function TermsPage({
  accepted,
  onChange,
  onNext,
  currentLang,
  onChangeLang,
  t,
}: TermsPageProps) {
  const body = (i18n.t("installer.terms.body", { returnObjects: true }) as unknown as string[]) ?? [];

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">{t("installer.terms.title")}</h1>
        <p className="page-subtitle">{t("installer.terms.intro")}</p>
      </div>

      <div className="lang-selector">
        <label className="path-label">{t("installer.language.label")}</label>
        <div className="lang-buttons">
          {SUPPORTED_LANGS.map((lang) => (
            <button
              key={lang.code}
              className={`lang-btn ${currentLang === lang.code ? "lang-btn--active" : ""}`}
              onClick={() => onChangeLang(lang.code)}
              type="button"
            >
              {lang.label}
            </button>
          ))}
        </div>
      </div>

      <div className="terms-box" role="region" aria-label={t("installer.terms.title")}>
        {body.map((paragraph, i) => (
          <p key={i} className="terms-paragraph">
            {paragraph}
          </p>
        ))}
      </div>

      <label className="terms-accept">
        <button
          className={`terms-checkbox ${accepted ? "terms-checkbox--checked" : ""}`}
          onClick={() => onChange(!accepted)}
          type="button"
          role="checkbox"
          aria-checked={accepted}
        >
          {accepted && <CheckIcon />}
        </button>
        <span className="terms-accept-label">{t("installer.terms.accept")}</span>
      </label>

      <div className="page-footer">
        <button className="btn btn--ghost" disabled type="button">
          {t("installer.actions.back")}
        </button>
        <button
          className="btn btn--primary"
          onClick={onNext}
          disabled={!accepted}
          type="button"
        >
          {t("actions.next")}
        </button>
      </div>
    </div>
  );
}

interface PreparePageProps {
  opts: InstallOptions;
  setOpts: React.Dispatch<React.SetStateAction<InstallOptions>>;
  onPickFolder: () => void;
  onBack: () => void;
  onNext: () => void;
  currentLang: string;
  onChangeLang: (lang: string) => void;
  pathError: string | null;
  t: (key: string) => string;
}

function PreparePage({
  opts,
  setOpts,
  onPickFolder,
  onBack,
  onNext,
  currentLang,
  onChangeLang,
  pathError,
  t,
}: PreparePageProps) {
  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">
          {t("installer.prepare.title")}
        </h1>
        <p className="page-subtitle">{t("installer.prepare.subtitle")}</p>
      </div>

      <div className="lang-selector">
        <label className="path-label">{t("installer.language.label")}</label>
        <div className="lang-buttons">
          {SUPPORTED_LANGS.map((lang) => (
            <button
              key={lang.code}
              className={`lang-btn ${currentLang === lang.code ? "lang-btn--active" : ""}`}
              onClick={() => onChangeLang(lang.code)}
              type="button"
            >
              {lang.label}
            </button>
          ))}
        </div>
      </div>

      <div className="options-list">
        <RequiredCard
          title={t("installer.options.deps.title")}
          description={t("installer.options.deps.description")}
          badge={t("installer.options.deps.badge")}
        />
        <OptionCard
          checked={opts.installExplorer}
          onChange={(v) => setOpts((o) => ({ ...o, installExplorer: v }))}
          title={t("installer.options.explorer.title")}
          description={t("installer.options.explorer.description")}
          badge={t("installer.options.explorer.badge")}
          badgeVariant="neutral"
        />
      </div>

      <div className="path-section">
        <label className="path-label">{t("installer.prepare.pathLabel")}</label>
        <div className="path-row">
          <input
            className={`path-input ${pathError ? "path-input--error" : ""}`}
            value={opts.installPath}
            onChange={(e) => setOpts((o) => ({ ...o, installPath: e.target.value }))}
            spellCheck={false}
          />
          <button className="btn btn--secondary" onClick={onPickFolder} type="button">
            {t("installer.prepare.changePath")}
          </button>
        </div>
        {pathError && (
          <div className="path-error" role="alert">
            {pathError}
          </div>
        )}
      </div>

      <div className="page-footer">
        <button className="btn btn--ghost" onClick={onBack} type="button">
          {t("installer.actions.back")}
        </button>
        <button className="btn btn--primary" onClick={onNext} type="button">
          {t("installer.actions.install")}
        </button>
      </div>
    </div>
  );
}

interface InstallPageProps {
  progress: InstallProgress;
  t: (key: string) => string;
}

function InstallPage({ progress, t }: InstallPageProps) {
  return (
    <div className="page page--centered">
      {progress.error ? (
        <>
          <div className="install-icon install-icon--error">
            <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
              <circle cx="20" cy="20" r="19" stroke="#EF4444" strokeWidth="2" />
              <path
                d="M13 13l14 14M27 13L13 27"
                stroke="#EF4444"
                strokeWidth="2.5"
                strokeLinecap="round"
              />
            </svg>
          </div>
          <h2 className="install-title">{t("installer.install.errorTitle")}</h2>
          <p className="install-error-msg">{progress.error}</p>
        </>
      ) : (
        <>
          <div className="install-icon">
            <SpinnerIcon />
          </div>
          <h2 className="install-title">{progress.step}</h2>
          <div className="progress-track">
            <div
              className="progress-fill"
              style={{ width: `${progress.pct}%` }}
            />
          </div>
          <p className="install-pct">{progress.pct}%</p>
        </>
      )}
    </div>
  );
}

interface FinishPageProps {
  error: string | null;
  onLaunch: () => void;
  t: (key: string) => string;
}

function FinishPage({ error, onLaunch, t }: FinishPageProps) {
  return (
    <div className="page page--centered">
      <div className="finish-icon">
        <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
          <circle cx="32" cy="32" r="30" stroke="var(--amber)" strokeWidth="2.5" />
          <path
            d="M18 32l10 10 18-18"
            stroke="var(--amber)"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <h2 className="finish-title">{t("installer.finish.title")}</h2>
      <p className="finish-sub">
        {error ? t("installer.finish.withWarnings") : t("installer.finish.success")}
      </p>
      <div className="page-footer page-footer--centered">
        <button className="btn btn--primary btn--wide" onClick={onLaunch} type="button">
          {t("installer.finish.openApp")}
        </button>
      </div>
    </div>
  );
}

interface OptionCardProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  description: string;
  badge: string;
  badgeVariant: "amber" | "neutral";
}

function OptionCard({
  checked,
  onChange,
  title,
  description,
  badge,
  badgeVariant,
}: OptionCardProps) {
  return (
    <button
      className={`option-card ${checked ? "option-card--checked" : ""}`}
      onClick={() => onChange(!checked)}
      type="button"
    >
      <div className={`option-checkbox ${checked ? "option-checkbox--checked" : ""}`}>
        {checked && <CheckIcon />}
      </div>
      <div className="option-body">
        <div className="option-title">{title}</div>
        <div className="option-desc">{description}</div>
      </div>
      <span className={`option-badge option-badge--${badgeVariant}`}>{badge}</span>
    </button>
  );
}

interface RequiredCardProps {
  title: string;
  description: string;
  badge: string;
}

function RequiredCard({ title, description, badge }: RequiredCardProps) {
  return (
    <div className="required-card">
      <div className="required-icon">
        <CheckIcon />
      </div>
      <div className="required-body">
        <div className="required-title">{title}</div>
        <div className="required-desc">{description}</div>
      </div>
      <span className="required-badge">{badge}</span>
    </div>
  );
}

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path
        d="M2 6l3 3 5-5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg className="spinner" width="48" height="48" viewBox="0 0 48 48" fill="none">
      <circle cx="24" cy="24" r="20" stroke="#2a2a2a" strokeWidth="3" />
      <path
        d="M24 4a20 20 0 0 1 20 20"
        stroke="var(--amber)"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
