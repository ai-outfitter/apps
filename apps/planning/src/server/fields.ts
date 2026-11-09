import { z } from "zod";
const optionalText = (max: number) => z.string().trim().max(max).default("");
export const projectFields = z
  .object({
    githubRepository: z
      .string()
      .trim()
      .max(300)
      .transform((value) => value.replace(/^https:\/\/(?:www\.)?github\.com\/(.*?)\/?$/i, "https://github.com/$1"))
      .pipe(z.string().regex(
        /^$|^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]+$/,
        "Use https://github.com/owner/repository",
      ))
      .refine(
        (v) => ![".", ".."].includes(v.split("/").at(-1) ?? ""),
        "Use a repository URL",
      )
      .default(""),
    name: z.string().trim().min(1).max(160),
    goals: optionalText(16000),
    userStories: optionalText(16000),
    pressRelease: optionalText(16000),
    demoInstructions: optionalText(16000),
    demoResults: optionalText(16000),
  })
  .strict();
/** A mask has no defaults: absent fields must never clear stored content. */
export const projectMaskFields = z.strictObject({
  name: projectFields.shape.name.optional(),
  githubRepository: projectFields.shape.githubRepository.removeDefault().optional(),
  goals: projectFields.shape.goals.removeDefault().optional(),
  userStories: projectFields.shape.userStories.removeDefault().optional(),
  pressRelease: projectFields.shape.pressRelease.removeDefault().optional(),
  demoInstructions: projectFields.shape.demoInstructions.removeDefault().optional(),
  demoResults: projectFields.shape.demoResults.removeDefault().optional(),
});
export const projectMask = projectMaskFields.refine(value => Object.values(value).some(field => field !== undefined), "Provide at least one field to edit");

export const issueFields = z
  .object({
    projectId: z.uuid(),
    title: z.string().trim().min(1).max(200),
    description: optionalText(16000),
    category: z.enum(["stone", "pebble", "sand"]),
    status: z.enum(["todo", "in-progress", "done"]).default("todo"),
    assigneeId: z.string().min(1).max(128).nullable().default(null),
    dueDate: z.iso.date().nullable().default(null),
    parentId: z.uuid().nullable().default(null),
  })
  .strict();
