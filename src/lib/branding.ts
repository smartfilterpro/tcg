/** The product name. Change it here and it updates everywhere in the UI.
 *
 *  Was "PokéDeck", then "TrainerDeck" — both Pokémon-flavored, which stopped
 *  being true the day Magic: The Gathering cards joined the collection.
 *  "TCGdeck" (tcgdeck.io) covers every game the app will ever hold. */
export const APP_NAME = "TCGdeck";

/** The user-facing name of the in-app assistant. Renamed from "TrainerAI"
 *  alongside the site: "Trainer" is Pokémon vocabulary, and the assistant
 *  now answers about Magic cards too. */
export const AI_NAME = "DeckAI";

/** Kept explicit and prominent: the app reads real card data and shows real
 *  card art, so saying plainly that it is unofficial matters more once money
 *  is involved, not less. Both games' rights holders are named. */
export const FAN_DISCLAIMER =
  `${APP_NAME} is an unofficial fan project. Not affiliated with, endorsed by, or ` +
  `sponsored by Nintendo, Creatures Inc., GAME FREAK inc., The Pokémon Company, ` +
  `Wizards of the Coast, or Hasbro. ` +
  `All card images and names are the property of their respective owners.`;
