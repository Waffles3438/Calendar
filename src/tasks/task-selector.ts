const GENERIC_TASK_SELECTOR_TERMS = new Set(["a", "an", "task", "the", "to"]);

/**
 * Normalizes a natural-language task selector using the legacy task rules.
 * Punctuation separates terms, while generic task wording is ignored unless
 * every selector token is generic, in which case the original lower-case
 * selector remains a nonempty fallback term.
 */
export function normalizeTaskSelectorTerms(value: string): readonly string[] {
  const lowerCaseValue = value.toLocaleLowerCase();
  const terms = lowerCaseValue
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 0 && !GENERIC_TASK_SELECTOR_TERMS.has(term));
  return terms.length > 0 ? terms : [lowerCaseValue];
}

/** Requires every normalized selector term to occur in the candidate title. */
export function titleMatchesTaskSelector(
  title: string,
  selector: readonly string[] | string,
): boolean {
  const terms = typeof selector === "string" ? normalizeTaskSelectorTerms(selector) : selector;
  const normalizedTitle = title.toLocaleLowerCase();
  return terms.length > 0 && terms.every((term) => normalizedTitle.includes(term));
}
