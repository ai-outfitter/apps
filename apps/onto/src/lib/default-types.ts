import { z } from "zod";
import definitions from "../../graph/.compiled/standard-types.json" with { type: "json" };
import { typeInput } from "./graph";

export const defaultTypes = z.array(typeInput.extend({ id: z.uuid() })).parse(definitions);
