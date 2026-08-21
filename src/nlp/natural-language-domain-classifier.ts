import type { NaturalLanguageDomainDecision } from "./natural-language-types.js";

export interface NaturalLanguageDomainClassificationInput {
  readonly now: Date;
  readonly text: string;
  readonly timeZone: string;
}

/** Classifies only the owner request's domain; it has no execution authority. */
export interface NaturalLanguageDomainClassifier {
  classify(
    input: NaturalLanguageDomainClassificationInput,
  ): Promise<NaturalLanguageDomainDecision | undefined>;
}
