// Outfitter's Onto: the same request on a separate Onto must reach the same shape.
import { launchVideoChecks } from "../../lib/checks";

launchVideoChecks({ scope: "outfitter", products: ["Onto", "Planning"] });
