import creative from '../../seeds/creative-v1.json';
import { z } from "zod";
import definitions from "../../seeds/types-v1.json";
import knowledgeGraphs from "../../seeds/knowledge-graphs-v1.json";
import controlPilotTypes from "../../seeds/control-pilot-types-v1.json";
import artifacts from "../../seeds/artifacts-v1.json";
import releases from "../../seeds/releases-v1.json";
import { typeInput } from "./graph";

// JSON is the shared source for demos and repeatable operational setup.
export const defaultTypes = z.array(typeInput.extend({ id: z.uuid() })).parse([
  ...definitions,
  ...creative.types,
  ...controlPilotTypes,
  ...knowledgeGraphs.types,
  ...artifacts.types,
  ...releases.types,
]);
