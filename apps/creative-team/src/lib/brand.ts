// The onboarding interview that builds the brand document: who the creator helps,
// their story, the minds that shaped them, their pillars and lens, what they believe
// and are against, and the words they use. A long-term brand is built from these
// answers over 6 to 12 months of posts, never in one post.

export type BrandQuestion = { id: string; text: string; hint?: string };
export type BrandSection = { id: string; title: string; summary: string; questions: BrandQuestion[] };

export const brandSections: BrandSection[] = [
  {
    id: "audience", title: "Who you help", summary: "One real person you want to reach.",
    questions: [
      { id: "audience.person", text: "Who do you most want to help? Describe one real person." },
      { id: "audience.bad-day", text: "What does a bad day look like for them right now?" },
      { id: "audience.complaint", text: "What do they say when they complain to a friend?", hint: "Use their exact words." },
      { id: "audience.tried", text: "What have they already tried that didn't work?" },
    ],
  },
  {
    id: "story", title: "Your story", summary: "What you lived through and what you can point to.",
    questions: [
      { id: "story.lived", text: "What have you lived through that your audience is living through now?" },
      { id: "story.turn", text: "What was the moment things changed for you, no matter how small?" },
      { id: "story.built", text: "What have you built, tried, failed at, or figured out?", hint: "List them from biggest to smallest; they all count." },
      { id: "story.results", text: "What results can you point to, for you or for people you've helped?" },
    ],
  },
  {
    id: "influences", title: "Who shaped your mind", summary: "The people whose ideas you remix into your own.",
    questions: [
      { id: "influences.never-skip", text: "Whose books, posts, or videos do you never skip?", hint: "Name real people and titles." },
      { id: "influences.idea", text: "Which idea from them do you keep coming back to, and why?" },
      { id: "influences.changed", text: "Who changed how you think, even if you disagree with them now?" },
    ],
  },
  {
    id: "pillars", title: "Pillars and perspective", summary: "What you could talk about for hours, and your lens on it.",
    questions: [
      { id: "pillars.hours", text: "What could you talk about for hours?", hint: "List everything, even things that seem unrelated." },
      { id: "pillars.top", text: "Of those, which 2 or 3 matter most to you?" },
      { id: "pillars.lens", text: "How do you come at each one differently from others?", hint: "For example \"through psychology\" or \"as a former nurse\"." },
      { id: "pillars.advice", text: "What do people ask you for advice on most?" },
      { id: "pillars.explain", text: "What do you keep explaining to people over and over?" },
    ],
  },
  {
    id: "mission", title: "Mission and beliefs", summary: "What you want to help people do, and where you disagree.",
    questions: [
      { id: "mission.sentence", text: "In one sentence, what do you want to help people do?" },
      { id: "mission.contrarian", text: "What do you believe that most people in your space don't?" },
      { id: "mission.wrong-advice", text: "What common advice in your field do you think is wrong?" },
    ],
  },
  {
    id: "against", title: "What you're against", summary: "The way of living you want to help people escape.",
    questions: [
      { id: "against.hurting", text: "What way of living is hurting the people you want to help?" },
      { id: "against.escape", text: "What life do you want to help them escape?", hint: "Answer in your own words." },
      { id: "against.myth", text: "What myth or habit would you get rid of if you could?", hint: "A habit or idea, not a person or company." },
    ],
  },
  {
    id: "now", title: "Why it matters now", summary: "The shift most people haven't noticed.",
    questions: [
      { id: "now.changed", text: "What just changed in the world that most people haven't noticed yet?" },
    ],
  },
  {
    id: "destination", title: "Where you're taking them", summary: "Who they become, and who you are in their story.",
    questions: [
      { id: "destination.five-years", text: "What does their day-to-day life look like five years after following you?" },
      { id: "destination.bio", text: "What would they proudly call themselves in their own bio?" },
      { id: "destination.role", text: "Who are you in their story?", hint: "Their guide, someone documenting the journey, or someone who got out and came back with a map." },
    ],
  },
  {
    id: "words", title: "Rules and words", summary: "The rules your reader lives by and the names you give your ideas.",
    questions: [
      { id: "words.rules", text: "What does your ideal reader believe and do every day?", hint: "List 5 to 12 rules." },
      { id: "words.names", text: "Do you have names for your own ideas, methods, or problems?", hint: "Write each name with what it means." },
    ],
  },
];

export const brandQuestions = brandSections.flatMap((section) => section.questions.map((question) => ({ ...question, section: section.id })));
export const brandQuestionIds = brandQuestions.map((question) => question.id) as [string, ...string[]];
export const questionById = new Map(brandQuestions.map((question) => [question.id, question]));

/** The content map's four levels: pillars branch into topics, topics into ideas, ideas into angles. */
export const mapLevels = ["pillar", "topic", "idea", "angle"] as const;
export type MapLevel = (typeof mapLevels)[number];
export const childLevel: Record<MapLevel, MapLevel | null> = { pillar: "topic", topic: "idea", idea: "angle", angle: null };
/** What a full map aims for at each level (3-4 pillars, 5-7 topics, 5-10 ideas, 4-5 angles). */
export const mapTargets: Record<MapLevel, [number, number]> = { pillar: [3, 4], topic: [5, 7], idea: [5, 10], angle: [4, 5] };

export const sourceKinds = ["own", "influence"] as const;
export const sourceKindLabels: Record<(typeof sourceKinds)[number], string> = { own: "Your own posts", influence: "Someone who shaped you" };

export const draftFormats = ["post", "thread", "article", "newsletter", "short-video", "long-video"] as const;
export const draftFormatLabels: Record<(typeof draftFormats)[number], string> = {
  post: "Short post", thread: "Thread", article: "Article", newsletter: "Newsletter", "short-video": "Short video script", "long-video": "Long video script",
};
export const draftStatuses = ["draft", "ready", "posted", "archived"] as const;
export const draftStatusLabels: Record<(typeof draftStatuses)[number], string> = { draft: "Draft", ready: "Ready to post", posted: "Posted", archived: "Archived" };
