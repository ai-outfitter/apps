import { stableGraphId } from "@ai-outfitter/app-sdk/graph-client";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import { z } from "zod";

export const briefTimezone = z.string().min(1).max(64).refine(value => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; }
  catch { return false; }
}, "Choose a valid time zone");

export const briefSlug = async (owner: AppIdentity, date: string, timezone: string) =>
  `forerunner-brief-${date}-${await stableGraphId(owner.owner, owner.installationId, timezone)}`;
