// The Guide: one short page per screen, opened by the ? button. Plain UK English, at most 120 words a page.
import type { Screen } from "../store.js";

export interface GuidePage {
  title: string;
  /** What the screen is for. */
  intro: string;
  /** The three most useful things to do here. */
  actions: [string, string, string];
  goodToKnow: string;
}

export const GUIDE: Record<Screen, GuidePage> = {
  area: {
    title: "The Area screen",
    intro: "This is where your map's place and its data come from. Every map in the project is drawn from this area.",
    actions: [
      "Refresh data fetches the latest roads, buildings and paths from OpenStreetMap.",
      "Use a file… swaps one kind of data, such as buildings, for your own file.",
      "Pick a projection: the way the curved Earth is flattened onto your page. The suggested one suits most maps.",
    ],
    goodToKnow: "Keep the area small. A park or a town centre fetches in seconds; a whole city can take a minute.",
  },
  maps: {
    title: "The Maps screen",
    intro: "Each map is one artboard in Affinity: a view of your area at a set scale and size.",
    actions: [
      "+ Add map, then click where its centre goes.",
      "Set the scale, size and rotation in the panel on the right, and choose the Affinity document it goes to.",
      "Send draws the selected maps in Affinity. With none selected, it sends every map that has changed.",
    ],
    goodToKnow: "Change something in Affinity and AffinityGeo leaves it alone; 'Reset hand edits' puts it back.",
  },
  style: {
    title: "The Style screen",
    intro: "This is where you choose how each kind of data looks: colours, line weights and what sits on top.",
    actions: [
      "Pick a preset for a complete look in one click.",
      "Change a layer's fill, stroke or width. The preview updates as you go.",
      "Hide a layer, or move it up or down to change what sits on top.",
    ],
    goodToKnow: "The style belongs to the whole project, so every map shares it. Changes reach Affinity the next time you send.",
  },
  data: {
    title: "The Data screen",
    intro: "This is the information behind your map: every road, building and place, with its name and details.",
    actions: [
      "Choose a layer and search its names and values.",
      "Use Columns to choose which details show in the table.",
      "Select by attribute finds the matching roads, buildings or places, then Select in Affinity selects them on a map, ready to restyle.",
    ],
    goodToKnow: "Names come from OpenStreetMap, so a few may be missing or spelt differently from local signs.",
  },
};
