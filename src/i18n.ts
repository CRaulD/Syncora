import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import ptBR from "./locales/pt-BR.json";
import en from "./locales/en.json";
import es from "./locales/es.json";

const SUPPORTED = ["pt-BR", "en", "es"] as const;
type SupportedLng = (typeof SUPPORTED)[number];

function detectInitialLanguage(): SupportedLng {
  if (typeof window === "undefined") return "pt-BR";
  const stored = window.localStorage.getItem("synclegendas-config");
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      const lang = parsed?.appLanguage;
      if (SUPPORTED.includes(lang)) return lang as SupportedLng;
    } catch {
      // ignore
    }
  }
  const nav = window.navigator?.language;
  if (nav) {
    if (nav.toLowerCase().startsWith("en")) return "en";
    if (nav.toLowerCase().startsWith("es")) return "es";
  }
  return "pt-BR";
}

void i18n
  .use(initReactI18next)
  .init({
    resources: {
      "pt-BR": { translation: ptBR },
      en: { translation: en },
      es: { translation: es },
    },
    lng: detectInitialLanguage(),
    fallbackLng: "pt-BR",
    interpolation: { escapeValue: false },
    returnNull: false,
  });

export default i18n;

export function changeAppLanguage(lang: string) {
  if (SUPPORTED.includes(lang as SupportedLng)) {
    void i18n.changeLanguage(lang);
  }
}
