import type {
  NaturalLanguageAction,
  NaturalLanguageActionPlanningInput,
} from "./natural-language-action.js";

/** Hosted planning boundary for one owner message; implementations cannot execute actions. */
export interface NaturalLanguageActionPlanner {
  plan(input: NaturalLanguageActionPlanningInput): Promise<NaturalLanguageAction | undefined>;
}
