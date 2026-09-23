/**
 * The content categories a topic pool is organised by.
 *
 * Content types, not service lines. A category called "Home Delivery" would
 * need sixteen topics about home delivery and repeat itself by the fourth;
 * "Seasonal Safety" can carry sixteen because the angle changes every time
 * while the subject stays broad.
 *
 * Services still anchor the topics inside each category. They just do not
 * define the categories, because a business with six services would get six
 * narrow buckets and a business with twenty would get twenty.
 *
 * Counts vary rather than being uniform: a category that genuinely has more to
 * say gets more room.
 */

export interface CategorySeed {
  name: string;
  description: string;
  targetCount: number;
}

/** Categories every business gets, whatever it sells. */
const UNIVERSAL: CategorySeed[] = [
  {
    name: "Holidays & Special Days",
    description:
      "Calendar moments: national holidays, observances and special days. Every " +
      "topic lands on one concrete action, never a ribbon.",
    targetCount: 13,
  },
  {
    name: "Seasonal Safety",
    description:
      "What this time of year physically changes for the customer: weather, " +
      "daylight, heat, ice, illness season, travel.",
    targetCount: 12,
  },
  {
    name: "Myth-Busting, Stats & Trends",
    description:
      "Correcting what people wrongly believe about this field. Never invent a " +
      "figure; describe the pattern in words when you do not have one.",
    targetCount: 17,
  },
  {
    name: "Emotional & Engagement Content",
    description:
      "The parts of the relationship that are not transactions: trust, dignity, " +
      "reassurance, the reason somebody chose this business.",
    targetCount: 16,
  },
];

/**
 * Industry-specific categories.
 *
 * Matched on a keyword in the industry string rather than an exact value,
 * because the crawler writes whatever the site says: "Home Health Care",
 * "Senior Home Care" and "In-Home Care" are all the same business.
 */
const BY_INDUSTRY: { match: RegExp; categories: CategorySeed[] }[] = [
  {
    // Home care, nursing, senior care.
    match: /home\s*(health|care|nursing)|senior|elder|nursing|caregiv/i,
    categories: [
      {
        name: "Health Awareness Observances",
        description:
          "Awareness months and health days, written as something a reader can " +
          "do this week rather than a ribbon to notice.",
        targetCount: 12,
      },
      {
        name: "Disease & Condition Guidance",
        description:
          "Living with a specific condition at home: dementia, Parkinsons, " +
          "diabetes, heart conditions, stroke recovery.",
        targetCount: 21,
      },
      {
        name: "Senior Daily Living & Wellbeing",
        description:
          "The ordinary day: sleep, meals, mobility, hygiene, routine, staying " +
          "engaged.",
        targetCount: 15,
      },
      {
        name: "Professional Caregiver Guidance",
        description:
          "For the paid caregiver doing the work: technique, boundaries, " +
          "communication, difficult shifts.",
        targetCount: 15,
      },
      {
        name: "Family Caregiver Guidance",
        description:
          "For the adult child or spouse arranging care: decisions, guilt, " +
          "logistics, difficult conversations.",
        targetCount: 18,
      },
      {
        name: "Recipes",
        description:
          "Food for specific needs: diabetes-friendly, soft textures, low " +
          "sodium, low appetite, easy to eat one-handed.",
        targetCount: 7,
      },
    ],
  },
  {
    // Pharmacy.
    match: /pharmac|chemist|drugstore/i,
    categories: [
      {
        name: "Health Awareness Observances",
        description:
          "Awareness months and health days, written as one thing a reader can " +
          "do this week rather than a ribbon to notice.",
        targetCount: 12,
      },
      {
        name: "Managing Your Medication",
        description:
          "Refills, timing, storage, side effects, what to ask before starting " +
          "something new, what to do about a missed dose.",
        targetCount: 20,
      },
      {
        name: "Living With a Condition",
        description:
          "Day to day with diabetes, blood pressure, cholesterol and other " +
          "long-term conditions the pharmacy supports.",
        targetCount: 18,
      },
      {
        name: "Caring for Someone Else",
        description:
          "For the person managing a parent or partner's medication: tracking " +
          "doses, coordinating refills, spotting a problem early.",
        targetCount: 15,
      },
      {
        name: "Ask Your Pharmacist",
        description:
          "Questions people are too embarrassed or too rushed to ask at the " +
          "counter, answered properly.",
        targetCount: 14,
      },
    ],
  },
  {
    // Dental.
    match: /dental|dentist|orthodont/i,
    categories: [
      {
        name: "Health Awareness Observances",
        description: "Oral health awareness days, written as one concrete action.",
        targetCount: 10,
      },
      {
        name: "Treatments Explained",
        description:
          "What a procedure actually involves: how long, how it feels, what " +
          "recovery looks like, what it costs to maintain.",
        targetCount: 20,
      },
      {
        name: "Everyday Oral Care",
        description:
          "Brushing, flossing, diet, habits, and what genuinely changes outcomes.",
        targetCount: 16,
      },
      {
        name: "Children & Family Dentistry",
        description: "First visits, teething, braces, and dental anxiety in children.",
        targetCount: 14,
      },
      {
        name: "Dental Anxiety & Comfort",
        description: "For people who have been putting off an appointment for years.",
        targetCount: 12,
      },
    ],
  },
  {
    // Agencies, software, professional services.
    match: /market|software|develop|digital|agency|consult|technolog/i,
    categories: [
      {
        name: "How It Actually Works",
        description:
          "Explaining a mechanism rather than asserting a benefit. The posts " +
          "that make a buyer trust the expertise.",
        targetCount: 20,
      },
      {
        name: "Buying Decisions",
        description:
          "Choosing a supplier, reading a quote, knowing what a fair scope " +
          "looks like, when to build and when to buy.",
        targetCount: 16,
      },
      {
        name: "Common Mistakes",
        description:
          "What goes wrong, why it goes wrong, and the specific thing to check " +
          "before it does.",
        targetCount: 18,
      },
      {
        name: "Tools & How-To",
        description:
          "Something a reader can do themselves this week, named tool and " +
          "named step.",
        targetCount: 15,
      },
      {
        name: "Industry Shifts",
        description:
          "What changed, what it means in practice, and what to do about it. " +
          "Never speculation dressed as news.",
        targetCount: 14,
      },
    ],
  },
];

/** Generic set, for an industry none of the above recognise. */
const GENERIC: CategorySeed[] = [
  {
    name: "How It Actually Works",
    description: "Explaining a mechanism rather than asserting a benefit.",
    targetCount: 18,
  },
  {
    name: "Choosing a Provider",
    description: "What to compare, what to ask, and what a fair offer looks like.",
    targetCount: 15,
  },
  {
    name: "Common Mistakes",
    description: "What goes wrong, why, and the specific thing to check first.",
    targetCount: 16,
  },
  {
    name: "Getting Started",
    description: "For somebody who has decided but does not know the first step.",
    targetCount: 14,
  },
];

/**
 * Categories that only earn their place on certain networks.
 *
 * A network does not change what a business has to say. It changes what form
 * lands: a before-and-after belongs on Instagram and dies on LinkedIn, and a
 * point of view about the industry is the reverse. So these are added on top
 * of the industry set rather than replacing any of it, and a client who runs
 * no accounts gets none of them rather than a guess.
 *
 * Matched on the network name loosely, because the field is typed by hand and
 * arrives as "Instagram", "instagram" or "IG".
 */
const BY_NETWORK: { match: RegExp; categories: CategorySeed[] }[] = [
  {
    // Instagram, TikTok, Pinterest: the image carries the post.
    match: /instagram|^ig$|tiktok|pinterest/i,
    categories: [
      {
        name: "Behind the Scenes",
        description:
          "The ordinary working day: people, places and process. What makes " +
          "a business feel real rather than advertised.",
        targetCount: 14,
      },
      {
        name: "Faces & Stories",
        description:
          "The team and the people served, with permission. Named, specific " +
          "and never a stock photo pretending to be a customer.",
        targetCount: 12,
      },
    ],
  },
  {
    // LinkedIn: a professional audience reading for judgement, not service.
    match: /linkedin/i,
    categories: [
      {
        name: "Point of View",
        description:
          "What this business believes about its field and why, argued from " +
          "experience rather than asserted.",
        targetCount: 14,
      },
      {
        name: "Team & Hiring",
        description:
          "Who works here, what the work is actually like, and what the " +
          "business looks for. Reaches candidates and clients at once.",
        targetCount: 10,
      },
    ],
  },
  {
    // Facebook: local, community, the noticeboard.
    match: /facebook|^fb$/i,
    categories: [
      {
        name: "Community & Local",
        description:
          "The neighbourhood this business is part of: events, partners, " +
          "sponsorships and local news it has a real stake in.",
        targetCount: 13,
      },
    ],
  },
  {
    // YouTube: long enough to actually teach something.
    match: /youtube|^yt$/i,
    categories: [
      {
        name: "Show, Don't Tell",
        description:
          "Walkthroughs and demonstrations: the things that are faster to " +
          "understand watched than read.",
        targetCount: 12,
      },
    ],
  },
];

/** A social channel as the customer recorded it. */
export interface SocialChannel {
  network: string;
  handle?: string;
  url?: string;
}

/**
 * The category set for a business.
 *
 * Industry-specific first, then anything the networks add, then the universal
 * ones. Most relevant at the top, where a person starts reading; the
 * calendar-and-seasonal long tail at the bottom.
 *
 * Networks are optional and additive. A client with no accounts on record
 * gets exactly what they got before, because inventing an Instagram strategy
 * for a business that has no Instagram wastes a category slot on posts that
 * will never be published.
 */
export function categoriesFor(
  industry: string | null,
  channels: SocialChannel[] = [],
): CategorySeed[] {
  const specific = industry
    ? BY_INDUSTRY.find((entry) => entry.match.test(industry))?.categories
    : undefined;

  const networked = BY_NETWORK
    .filter((entry) => channels.some((c) => entry.match.test(c.network ?? "")))
    .flatMap((entry) => entry.categories);

  // A name collides on the unique index and the second row is silently
  // dropped, leaving a pool smaller than the UI promises. Industry wins.
  const seen = new Set<string>();
  return [...(specific ?? GENERIC), ...networked, ...UNIVERSAL]
    .filter((c) => !seen.has(c.name) && seen.add(c.name));
}
