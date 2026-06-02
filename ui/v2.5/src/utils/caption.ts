export const languageMap = new Map<string, string>([
  ["de", "Deutsche"],
  ["en", "English"],
  ["es", "Español"],
  ["fr", "Français"],
  ["it", "Italiano"],
  ["ja", "日本"],
  ["ko", "한국인"],
  ["nl", "Holandés"],
  ["pt", "Português"],
  ["ru", "Русский"],
  ["00", "Unknown"], // stash reserved language code
]);

// Cache one Intl.DisplayNames instance per UI locale; constructing it is
// relatively expensive and several track labels may be formatted per scene.
const displayNamesCache = new Map<string, Intl.DisplayNames | null>();

function getLanguageDisplayNames(locale: string): Intl.DisplayNames | null {
  if (!displayNamesCache.has(locale)) {
    let instance: Intl.DisplayNames | null = null;
    try {
      instance = new Intl.DisplayNames([locale], { type: "language" });
    } catch {
      instance = null;
    }
    displayNamesCache.set(locale, instance);
  }
  return displayNamesCache.get(locale) ?? null;
}

// Render an ISO 639 language code (e.g. "ja", "zh") as a human-readable name in
// the given UI locale, so subtitle tracks are labelled consistently (all in the
// user's language) instead of a mix of endonyms and raw codes. Falls back to the
// static languageMap, then the raw code, for codes that cannot be resolved.
export function getLanguageDisplayName(
  code: string,
  locale: string = "en"
): string {
  // stash reserved "unknown" language code
  if (code === "00") {
    return languageMap.get("00") ?? code;
  }

  const displayNames = getLanguageDisplayNames(locale);
  if (displayNames) {
    try {
      const name = displayNames.of(code);
      // DisplayNames returns the input unchanged for codes it cannot resolve.
      if (name && name.toLowerCase() !== code.toLowerCase()) {
        return name;
      }
    } catch {
      // ignore and fall through to the static map
    }
  }

  return languageMap.get(code) ?? code;
}

export const valueToCode = (value?: string | null) => {
  if (!value) {
    return undefined;
  }

  return Array.from(languageMap.keys()).find((v) => {
    return languageMap.get(v) === value;
  });
};
