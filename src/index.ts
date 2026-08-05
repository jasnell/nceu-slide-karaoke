// ================================================================
// Slide Karaoke — for NodeConf EU 2026
// Powered by Cloudflare Workers AI
// ================================================================

interface Env {
  AI: Ai;
  DECKS: KVNamespace;
  PEXELS_API_KEY?: string;
  PIXABAY_API_KEY?: string;
}

interface ChartDataPoint {
  label: string;
  value: number;
}

interface Slide {
  title: string;
  subtitle: string;
  quote: string;
  chartData: ChartDataPoint[] | null;
  audience: boolean;
  imageQuery: string;
  imageUrl: string;
  notes: string;
}

type Difficulty = 'easy' | 'medium' | 'hard';

interface Presentation {
  title: string;
  slides: Slide[];
  difficulty: Difficulty;
}

interface StoredPresentation extends Presentation {
  id: string;
  prompt: string;
  createdAt: string;
}

interface RecentEntry {
  id: string;
  title: string;
  prompt: string;
  difficulty: Difficulty;
  createdAt: string;
}

const DIFFICULTY_CONFIG: Record<Difficulty, { slides: number; timer: number; description: string }> = {
  easy:   { slides: 8,  timer: 5 * 60, description: 'stays closer to the topic, fewer curveballs' },
  medium: { slides: 10, timer: 5 * 60, description: 'the classic experience — absurd but survivable' },
  hard:   { slides: 15, timer: 5 * 60, description: 'maximum chaos, every slide is a trap, quotes everywhere' },
};

const MAX_RECENT = 20;
const DECK_TTL = 60 * 60 * 24 * 7; // 7 days

// ================================================================
// AI SYSTEM PROMPT
// ================================================================

const BASE_PROMPT = `You generate slide decks for Slide Karaoke — a party game at a tech conference where a player must stand on stage and improvise a five-minute talk using slides they have NEVER seen before. The audience is watching. There is no escape.

Your sole purpose is to make the presenter's life as hilariously difficult as possible. The slides must look superficially like a real conference talk but be ABSOLUTE NONSENSE underneath.

Strictly safe for work. No innuendo, nothing political, nothing mean-spirited.

CREATIVITY — CRITICAL:
You will receive a "chaos seed" with each request containing random words. Use these words as creative fuel — weave them into your titles, themes, and tangents. This ensures every deck is wildly different.

EVERY DECK MUST BE UNIQUE. Never reuse the same absurd nouns, adjectives, or themes across decks. The universe of absurdity is infinite — draw from ALL of it:
- Animals, foods, professions, hobbies, historical events, geography, furniture, weather, emotions, textures, sounds, smells, scientific concepts, musical instruments, sports, fabrics, minerals, kitchen appliances, maritime terminology, botanical terms, architectural styles, dance moves...
- The absurdity should come from UNEXPECTED COMBINATIONS, not from a fixed list of "funny words"

SLIDE STRUCTURE PATTERNS (vary which you use — never use all in one deck):
- A single ominous word with a period. Pick something nobody expects.
- A fabricated statistic delivered as gospel. Invent a new one every time.
- A non-sequitur audience participation moment. Different every time.
- Corporate jargon mashed with an unrelated domain.
- A title that sounds like a chapter from a book that should not exist.
- A countdown or "phase" that implies a terrifying plan.
- A title that is a complete sentence but makes no sense.

CHART SLIDES — IMPORTANT: When a difficulty level says to include chart slides, you MUST set the "chartData" field to an array of objects like [{"label":"Cats","value":47},{"label":"Regret","value":83}]. Use 3-6 data points with absurd labels and made-up values. Labels should be funny and unexpected. Values can be any number. When chartData is null, there is no chart. When chartData is an array, a bar chart will be rendered on screen — this is the main visual for that slide.

AUDIENCE PARTICIPATION SLIDES: When specified, set "audience" to true. The slide title becomes a big centered call-to-action (e.g., "Everyone stand up if you've ever debugged in production"). Keep chartData null on audience slides. Keep quote empty on audience slides.

MUTUAL EXCLUSION: Each slide is ONE type only. A slide can have a quote OR chartData OR audience, NEVER more than one. Normal slides have all three empty/null/false.

FAKE QUOTES: Use ONLY the people and hedge words provided in the QUOTE ROSTER. Attribution format: text -- Person Name, Hedgeword (no quotation marks in the JSON — the frontend adds them). Vary tone: technical, philosophical, practical, ominous, or surreal.

IMAGE SEARCH TERMS: Must have ZERO connection to the slide. Use SPECIFIC, vivid, findable terms. NEVER generic terms like "abstract" or "technology".`;

const DIFFICULTY_PROMPTS: Record<Difficulty, string> = {
  easy: `DIFFICULTY: EASY
Generate EXACTLY 8 slides. Slide titles: 1–5 words. Subtitles: most empty, max 6 words when used.
The presentation should stay LOOSELY connected to the original topic throughout — the humor comes from odd angles and strange takes, not total derailment. Still absurd, but the presenter can find a thread to follow.
Quotes on 1–2 slides (never slide 1). No chart slides. No audience participation slides.
Speaker notes: max 15 words, mildly helpful but strange.
Slide 1 is a title slide. Last slide is a slightly odd conclusion.`,

  medium: `DIFFICULTY: MEDIUM
Generate EXACTLY 10 slides. Slide titles: 1–5 words. Subtitles: most empty, max 6 words when used, should CONTRADICT or DERAIL the title.
By slide 5, the talk should have drifted into unrelated territory. Do not acknowledge the drift.
Quotes on 2–3 slides (never slide 1). EXACTLY 1 chart slide — it MUST have a chartData array with 3-6 data points with absurd labels. 0–1 audience participation slides.
Speaker notes: max 15 words, deadpan confident gibberish.
Slide 1 is a title slide. Last slide is a bizarre call to action.`,

  hard: `DIFFICULTY: HARD — MAXIMUM CHAOS
Generate EXACTLY 15 slides. Slide titles: 1–5 words. Subtitles: use more often, always contradicting or derailing the title.
The presentation should abandon the topic by slide 3 and NEVER return. Each slide should feel like it belongs to a different presentation. The presenter should have NO idea what is happening.
Quotes on 4–5 slides (never slide 1) — make them increasingly unhinged. EXACTLY 2 chart slides — each MUST have a chartData array with 4-6 data points with absurd labels and fabricated values. 1–2 audience participation slides with impossible requests.
Speaker notes: max 15 words, actively misleading.
Slide 1 is a title slide. Last slide should be a threat disguised as a thank-you.`,
};

function buildSystemPrompt(difficulty: Difficulty): string {
  return BASE_PROMPT + '\n\n' + DIFFICULTY_PROMPTS[difficulty] + `\n\nOutput ONLY valid JSON. Example structure with two slides (one normal, one chart):
{"title":"Title","slides":[{"title":"T","subtitle":"","quote":"","chartData":null,"audience":false,"imageQuery":"photo","notes":"nonsense"},{"title":"Chart Title","subtitle":"","quote":"","chartData":[{"label":"Cats","value":47},{"label":"Regret","value":83},{"label":"Soup","value":12}],"audience":false,"imageQuery":"clouds","notes":"present this chart with confidence"}]}`;
}

// ================================================================
// HELPERS
// ================================================================

/** Pull the generated text out of whatever shape the Workers AI binding returns. */
function extractAIText(aiResponse: unknown): string {
  if (typeof aiResponse === 'string') return aiResponse;
  if (!aiResponse || typeof aiResponse !== 'object') return '';

  const obj = aiResponse as Record<string, unknown>;

  // OpenAI-compatible shape: choices[0].message.content (often the longest / most complete)
  if (Array.isArray(obj.choices) && obj.choices.length > 0) {
    const choice = obj.choices[0] as Record<string, unknown>;
    if (choice.message && typeof choice.message === 'object') {
      const msg = choice.message as Record<string, unknown>;
      if (typeof msg.content === 'string' && msg.content) return msg.content;
    }
  }

  // Simple { response: "..." }
  if (typeof obj.response === 'string' && obj.response) return obj.response;

  // Other possible fields
  for (const key of ['text', 'result', 'content', 'generated_text']) {
    if (typeof obj[key] === 'string' && obj[key]) return obj[key] as string;
  }

  return '';
}

/**
 * If the AI ran out of tokens mid-JSON or produced unescaped quotes,
 * salvage as many complete slides as possible.
 */
function repairTruncatedJSON(raw: string): string {
  // Strategy: find the last complete slide object (ends with }) that's
  // followed by , or ] in the slides array, then rebuild valid JSON.

  // Step 1: find the "slides" array start
  const slidesIdx = raw.indexOf('"slides"');
  if (slidesIdx === -1) return raw;

  const bracketIdx = raw.indexOf('[', slidesIdx);
  if (bracketIdx === -1) return raw;

  // Step 2: extract each complete slide by finding balanced {} objects
  const completeSlides: string[] = [];
  let i = bracketIdx + 1;

  while (i < raw.length) {
    // Skip whitespace and commas
    while (i < raw.length && (raw[i] === ' ' || raw[i] === '\n' || raw[i] === '\r' || raw[i] === '\t' || raw[i] === ',')) i++;
    if (i >= raw.length || raw[i] !== '{') break;

    // Try to find a balanced {} from position i
    let depth = 0;
    let inStr = false;
    let esc = false;
    let j = i;
    for (; j < raw.length; j++) {
      const ch = raw[j];
      if (esc) { esc = false; continue; }
      if (ch === '\\' && inStr) { esc = true; continue; }
      if (ch === '"' && !esc) { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) { j++; break; }
      }
    }

    if (depth === 0) {
      const candidate = raw.slice(i, j);
      // Validate this slide parses
      try {
        JSON.parse(candidate);
        completeSlides.push(candidate);
      } catch {
        // This slide has broken JSON (unescaped quotes etc.) — skip it
      }
      i = j;
    } else {
      break; // truncated, stop
    }
  }

  if (completeSlides.length === 0) return raw; // can't salvage

  // Step 3: extract the title from the prefix
  const titleMatch = raw.match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const title = titleMatch ? titleMatch[1] : 'Untitled';

  // Step 4: rebuild valid JSON
  return '{"title":"' + title + '","slides":[' + completeSlides.join(',') + ']}';
}

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash);
}

function generateId(): string {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789'; // no ambiguous chars
  let id = '';
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  for (const b of bytes) id += chars[b % chars.length];
  return id;
}

// ================================================================
// KV STORAGE
// ================================================================

async function saveDeck(env: Env, prompt: string, presentation: Presentation): Promise<StoredPresentation> {
  const id = generateId();
  const stored: StoredPresentation = {
    ...presentation,
    id,
    prompt,
    createdAt: new Date().toISOString(),
  };

  // Save the full deck
  await env.DECKS.put(`deck:${id}`, JSON.stringify(stored), { expirationTtl: DECK_TTL });

  // Update the recent list
  const recentRaw = await env.DECKS.get('recent');
  let recent: RecentEntry[] = recentRaw ? JSON.parse(recentRaw) : [];
  recent.unshift({ id, title: presentation.title, prompt, difficulty: presentation.difficulty || 'medium', createdAt: stored.createdAt });
  recent = recent.slice(0, MAX_RECENT);
  await env.DECKS.put('recent', JSON.stringify(recent));

  return stored;
}

async function getDeck(env: Env, id: string): Promise<StoredPresentation | null> {
  const raw = await env.DECKS.get(`deck:${id}`);
  return raw ? JSON.parse(raw) : null;
}

async function getRecent(env: Env): Promise<RecentEntry[]> {
  const raw = await env.DECKS.get('recent');
  return raw ? JSON.parse(raw) : [];
}

// ================================================================
// PRE-GENERATION POOL
// ================================================================

const POOL_TTL = 7200;         // 2 hours
const POOL_TARGET_SIZE = 3;    // per difficulty
const POOL_DIFFICULTIES: Difficulty[] = ['easy', 'medium'];

async function getPoolIds(env: Env, difficulty: Difficulty): Promise<string[]> {
  const raw = await env.DECKS.get(`pool-index:${difficulty}`);
  return raw ? JSON.parse(raw) : [];
}

async function setPoolIds(env: Env, difficulty: Difficulty, ids: string[]): Promise<void> {
  await env.DECKS.put(`pool-index:${difficulty}`, JSON.stringify(ids));
}

/** Store a pre-generated deck in the pool. */
async function addToPool(env: Env, difficulty: Difficulty, prompt: string, pres: Presentation): Promise<void> {
  const id = generateId();
  const stored: StoredPresentation = {
    ...pres,
    id,
    prompt,
    createdAt: new Date().toISOString(),
  };
  await env.DECKS.put(`pool:${difficulty}:${id}`, JSON.stringify(stored), { expirationTtl: POOL_TTL });

  const ids = await getPoolIds(env, difficulty);
  ids.push(id);
  await setPoolIds(env, difficulty, ids);
}

/** Pop a deck from the pool. Returns null if empty. */
async function popFromPool(env: Env, difficulty: Difficulty): Promise<StoredPresentation | null> {
  const ids = await getPoolIds(env, difficulty);
  while (ids.length > 0) {
    const id = ids.shift()!;
    await setPoolIds(env, difficulty, ids);
    const raw = await env.DECKS.get(`pool:${difficulty}:${id}`);
    if (raw) {
      // Move from pool to regular deck storage so it gets a share URL
      const deck: StoredPresentation = JSON.parse(raw);
      await env.DECKS.put(`deck:${deck.id}`, raw, { expirationTtl: DECK_TTL });
      await env.DECKS.delete(`pool:${difficulty}:${id}`);
      // Add to recent list
      const recentRaw = await env.DECKS.get('recent');
      let recent: RecentEntry[] = recentRaw ? JSON.parse(recentRaw) : [];
      recent.unshift({ id: deck.id, title: deck.title, prompt: deck.prompt || '', difficulty: deck.difficulty || 'medium', createdAt: deck.createdAt });
      recent = recent.slice(0, MAX_RECENT);
      await env.DECKS.put('recent', JSON.stringify(recent));
      return deck;
    }
  }
  return null;
}

/** Generate a random topic (server-side, no rate limit). */
async function generateRandomTopic(env: Env): Promise<string> {
  const categories = [
    'corporate strategy meeting', 'engineering all-hands', 'HR workshop',
    'product launch event', 'investor pitch', 'academic conference paper',
    'TED-style talk', 'board of directors quarterly review', 'startup demo day',
    'safety compliance seminar', 'research symposium', 'trade show panel',
  ];
  const flavors = [
    'about an extremely specific niche topic',
    'that sounds important but is about something trivial',
    'that combines two unrelated fields',
    'about an everyday object treated with extreme seriousness',
    'that a middle manager would propose with total confidence',
    'that sounds like it was auto-generated from buzzwords',
  ];
  const category = categories[Math.floor(Math.random() * categories.length)];
  const flavor = flavors[Math.floor(Math.random() * flavors.length)];
  const seedWords = pickRandom(CHAOS_NOUNS, 2).join(', ');

  const aiResponse = await env.AI.run(
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    {
      messages: [
        { role: 'system', content: 'You output a single presentation title, 3-8 words. Nothing else.' },
        { role: 'user', content: `Invent one topic for a ${category} ${flavor}. Inspired by: ${seedWords}. Just the title.` },
      ],
      max_tokens: 30,
      temperature: 1.0,
    }
  );
  const topic = extractAIText(aiResponse)
    .replace(/^["'*\s]+|["'*\s.]+$/g, '')
    .replace(/^(Title|Topic|Here|Sure)[:\s]*/i, '')
    .trim();
  if (!topic || topic.length < 5) throw new Error('Empty topic');
  return topic;
}

/** Called by cron: top up the pool to POOL_TARGET_SIZE per difficulty. */
async function refillPool(env: Env): Promise<void> {
  for (const diff of POOL_DIFFICULTIES) {
    // Prune expired entries
    const ids = await getPoolIds(env, diff);
    const valid: string[] = [];
    for (const id of ids) {
      const exists = await env.DECKS.get(`pool:${diff}:${id}`);
      if (exists) valid.push(id);
    }
    await setPoolIds(env, diff, valid);

    const needed = POOL_TARGET_SIZE - valid.length;
    if (needed <= 0) continue;

    // Generate up to 2 per invocation to stay within CPU limits
    const toGen = Math.min(needed, 2);
    for (let i = 0; i < toGen; i++) {
      try {
        const topic = await generateRandomTopic(env);
        const pres = await generatePresentation(env, topic, diff);
        await addToPool(env, diff, topic, pres);
        console.log(`Pool: added ${diff} deck "${topic}"`);
      } catch (e) {
        console.error(`Pool: failed to generate ${diff} deck:`, e);
      }
    }
  }
}

// ================================================================
// IMAGE FETCHING — multiple sources for variety
// ================================================================

type ImageSource = 'pexels' | 'pixabay';

/** Pick a URL from a Pexels search. */
async function fetchFromPexels(apiKey: string, query: string): Promise<string | null> {
  try {
    const resp = await fetch(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=20&orientation=landscape`,
      { headers: { Authorization: apiKey } }
    );
    if (!resp.ok) return null;
    const data = await resp.json() as { photos?: { src: { large2x?: string; large: string } }[] };
    if (!data.photos?.length) return null;
    const photo = data.photos[Math.floor(Math.random() * Math.min(data.photos.length, 15))];
    return photo.src.large2x || photo.src.large;
  } catch { return null; }
}

/** Pick a URL from a Pixabay search. Good for illustrations, weird niche content, animals. */
async function fetchFromPixabay(apiKey: string, query: string): Promise<string | null> {
  try {
    const resp = await fetch(
      `https://pixabay.com/api/?key=${encodeURIComponent(apiKey)}&q=${encodeURIComponent(query)}&per_page=20&orientation=horizontal&safesearch=true&min_width=1024`,
    );
    if (!resp.ok) return null;
    const data = await resp.json() as { hits?: { largeImageURL: string; webformatURL: string }[] };
    if (!data.hits?.length) return null;
    const photo = data.hits[Math.floor(Math.random() * Math.min(data.hits.length, 15))];
    return photo.largeImageURL || photo.webformatURL;
  } catch { return null; }
}

async function fetchImageUrl(env: Env, query: string, index: number): Promise<string> {
  // Build the list of available sources
  const sources: { name: ImageSource; fn: () => Promise<string | null> }[] = [];
  if (env.PEXELS_API_KEY) {
    sources.push({ name: 'pexels', fn: () => fetchFromPexels(env.PEXELS_API_KEY!, query) });
  }
  if (env.PIXABAY_API_KEY) {
    sources.push({ name: 'pixabay', fn: () => fetchFromPixabay(env.PIXABAY_API_KEY!, query) });
  }

  if (sources.length > 0) {
    // Pick a random source for this slide
    const shuffled = sources.sort(() => Math.random() - 0.5);

    for (const source of shuffled) {
      const url = await source.fn();
      if (url) return url;
      // If the picked source returned nothing for this query, try the next
    }
  }

  // Fallback: Lorem Picsum
  const seed = hashString(query + '-' + index + '-' + Date.now());
  return `https://picsum.photos/seed/${seed}/1280/720`;
}

// ================================================================
// PRESENTATION GENERATION
// ================================================================

function extractJSON(raw: string): string {
  // Strip markdown code fences if present
  let text = raw.trim();
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  const start = text.indexOf('{');
  if (start === -1) return '';

  // Return everything from the first { onward — let JSON.parse and
  // repairTruncatedJSON deal with the details. The old brace-walker
  // broke on unescaped quotes inside string values, which the AI
  // produces frequently in the "quote" field.
  return text.slice(start);
}

// Word pools for the chaos seed — drawn from wildly different domains
const CHAOS_NOUNS = [
  'accordion', 'avalanche', 'barnacle', 'basilisk', 'brisket', 'cardamom', 'centrifuge',
  'chandelier', 'clementine', 'cobalt', 'corduroy', 'cuttlefish', 'dirigible', 'dolomite',
  'echidna', 'euphonium', 'feldspar', 'fjord', 'gazpacho', 'gondola', 'harpsichord',
  'hedgehog', 'heirloom', 'isthmus', 'jackhammer', 'kumquat', 'labyrinth', 'lozenge',
  'macramé', 'mandolin', 'narwhal', 'nutmeg', 'obsidian', 'origami', 'pangolin',
  'paprika', 'parsnip', 'pelican', 'periscope', 'phosphorus', 'platypus', 'pomegranate',
  'porcelain', 'quasar', 'quicksand', 'rhubarb', 'rucksack', 'saffron', 'salamander',
  'scaffolding', 'sequoia', 'sextant', 'shrapnel', 'sousaphone', 'stalagmite', 'strudel',
  'sundial', 'tapestry', 'tarantula', 'terracotta', 'thimble', 'toboggan', 'trombone',
  'tundra', 'turmeric', 'turnstile', 'umbrella', 'velociraptor', 'vermicelli', 'walrus',
  'wheelbarrow', 'xylophone', 'yak', 'zeppelin', 'anchovy', 'armadillo', 'balustrade',
  'binoculars', 'burlap', 'cantaloupe', 'carousel', 'catamaran', 'chutney', 'coriander',
  'croissant', 'dachshund', 'dragonfly', 'duvet', 'easel', 'elderberry', 'flamingo',
  'funicular', 'gargoyle', 'glockenspiel', 'gymnasium', 'hammock', 'igloo', 'javelin',
  'kaleidoscope', 'kiln', 'lantern', 'linoleum', 'macaroon', 'mongoose', 'monocle',
  'nectarine', 'obelisk', 'ottoman', 'parabola', 'pinecone', 'prism', 'quiche',
  'rampart', 'rutabaga', 'scalpel', 'tobasco', 'trebuchet', 'tugboat', 'turnip',
  'uvula', 'vestibule', 'waffle', 'yodel', 'zucchini',
];

const CHAOS_ADJECTIVES = [
  'translucent', 'carbonated', 'gelatinous', 'magnetic', 'perpendicular', 'fossilized',
  'turbulent', 'iridescent', 'combustible', 'aerodynamic', 'subterranean', 'invertible',
  'centrifugal', 'holographic', 'amphibious', 'hydraulic', 'galvanized', 'pressurized',
  'fermented', 'crystalline', 'buoyant', 'recursive', 'vestigial', 'molten', 'tectonic',
  'plaid', 'lukewarm', 'wobbling', 'upholstered', 'unlicensed', 'artisanal', 'volatile',
  'sentient', 'tandem', 'concentric', 'complimentary', 'nomadic', 'load-bearing',
];

const CHAOS_DOMAINS = [
  'maritime law', 'interpretive dance', 'mycology', 'competitive origami',
  'alpine yodeling', 'submarine cartography', 'artisanal pickle-making',
  'zero-gravity pottery', 'forensic accounting', 'tropical dentistry',
  'underground jazz', 'medieval plumbing', 'quantum gardening',
  'professional napping', 'industrial karaoke', 'deep-sea HR',
  'orbital sandwich engineering', 'neo-classical debugging',
  'high-altitude baking', 'nocturnal procurement', 'Antarctic UX research',
  'competitive whispering', 'sustainable trebuchet design', 'ceremonial load testing',
  'intergalactic compliance', 'reverse archaeology', 'hydroponic team building',
];

function pickRandom<T>(arr: T[], n: number): T[] {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

const CONTRIBUTORS = [
  'Matteo Collina', 'James M Snell', 'Yagiz Nizipli', 'Michaël Zasso',
  'Colin Ihrig', 'Robert Nagy', 'Joyee Cheung', 'Paolo Insogna',
  'Ruy Adorno', 'Myles Borins', 'Anna Henningsen', 'Antoine du Hamel',
  'Benjamin Gruenbaum', 'Tobias Nießen', 'Richard Lau', 'Chengzhong Wu',
  'Geoffrey Booth', 'Claudio Wunder', 'Ruben Bridgewater', 'Tierney Cyren',
  'Danielle Adams', 'Beth Griggs', 'Bryan English', 'Stephen Belanger',
  'Rafael Gonzaga', 'Marco Ippolito',
];

const HEDGE_WORDS = [
  'Probably', 'Likely', 'Allegedly', 'Maybe', 'Reportedly', 'Supposedly',
  'Possibly', 'Almost Certainly', 'Presumably', 'Unverified', 'Disputed',
  'Apocryphally', 'Debatably', 'Unconfirmed', 'Implausibly',
];

function generateChaosSeed(): string {
  const nouns = pickRandom(CHAOS_NOUNS, 4);
  const adjs = pickRandom(CHAOS_ADJECTIVES, 3);
  const domains = pickRandom(CHAOS_DOMAINS, 2);
  return `CHAOS SEED (use these as creative fuel for THIS deck — weave them into titles, tangents, and themes. Do NOT use them literally as slide titles — transform and combine them):
Words: ${nouns.join(', ')}, ${adjs.join(', ')}
Domains to riff on: ${domains.join(', ')}
Vibe: ${pickRandom(['unhinged TED talk', 'corporate fever dream', 'dystopian product launch', 'motivational cult meeting', 'academic paper gone wrong', 'conspiracy theory keynote', 'infomercial from another dimension', 'nature documentary about office life', 'cooking show that went off the rails', 'startup pitch from the year 3000'], 1)[0]}`;
}

function generateQuoteRoster(): string {
  const people = pickRandom(CONTRIBUTORS, CONTRIBUTORS.length); // full shuffle
  const hedges = pickRandom(HEDGE_WORDS, HEDGE_WORDS.length);
  return `QUOTE ROSTER (use people from the TOP of this shuffled list — pick 2-3 different ones):
People: ${people.join(', ')}
Hedge words: ${hedges.join(', ')}`;
}

// ================================================================
// CONTENT MODERATION
// ================================================================

async function moderatePrompt(env: Env, prompt: string): Promise<{ safe: boolean; reason?: string }> {
  // Layer 1: quick blocklist for obvious stuff
  const lower = prompt.toLowerCase();
  const blocked = [
    'nsfw', 'porn', 'nude', 'naked', 'sex', 'hentai', 'xxx',
    'kill', 'murder', 'suicide', 'bomb', 'terror',
    'racial', 'racist', 'slur', 'nazi', 'hitler',
    'drug', 'cocaine', 'heroin', 'meth',
  ];
  for (const word of blocked) {
    // Match whole words only
    if (new RegExp(`\\b${word}\\b`, 'i').test(lower)) {
      return { safe: false, reason: 'That topic is not appropriate for this game. Try something else!' };
    }
  }

  // Layer 2: use Llama Guard for nuanced content safety
  try {
    const guardResponse = await env.AI.run(
      '@cf/meta/llama-guard-3-8b' as Parameters<typeof env.AI.run>[0],
      {
        messages: [
          { role: 'user', content: prompt },
        ],
      }
    );

    const result = extractAIText(guardResponse).trim().toLowerCase();
    // Llama Guard returns "safe" or "unsafe\n<category>" 
    if (result.startsWith('unsafe')) {
      console.log('Llama Guard flagged prompt:', prompt, '→', result);
      return { safe: false, reason: 'That topic was flagged as inappropriate. Try something else!' };
    }
  } catch (e) {
    // If the guard model fails, let it through — the system prompt
    // still enforces SFW output, and we'd rather not block legitimate
    // prompts due to a model hiccup.
    console.error('Llama Guard error (allowing prompt through):', e);
  }

  return { safe: true };
}

async function generatePresentation(env: Env, prompt: string, difficulty: Difficulty = 'medium'): Promise<Presentation> {
  const chaosSeed = generateChaosSeed();
  const quoteRoster = generateQuoteRoster();
  const systemPrompt = buildSystemPrompt(difficulty);

  const aiResponse = await env.AI.run(
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    {
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `Create an absurdist presentation about: ${prompt}\n\n${chaosSeed}\n\n${quoteRoster}\n\nRespond with ONLY the JSON object, no other text.`,
        },
      ],
      max_tokens: 8192,
      temperature: difficulty === 'hard' ? 0.95 : 0.9,
    }
  );

  // Extract text from whichever field the binding populated
  const text = extractAIText(aiResponse);
  console.log('Extracted text length:', text.length);

  if (!text) {
    console.error('AI response shape:', JSON.stringify(aiResponse).slice(0, 800));
    throw new Error('AI returned an empty response');
  }

  // Extract and parse JSON, repairing truncation if needed
  const jsonStr = extractJSON(text);
  if (!jsonStr) {
    console.error('No JSON found in response:', text.slice(0, 1000));
    throw new Error('AI did not return valid JSON');
  }

  let presentation: Presentation;
  try {
    presentation = JSON.parse(jsonStr);
  } catch {
    // The JSON is likely truncated — try to repair it
    const repaired = repairTruncatedJSON(jsonStr);
    try {
      presentation = JSON.parse(repaired);
      console.log('Parsed after JSON repair, got', presentation.slides?.length, 'slides');
    } catch {
      console.error('JSON parse failed even after repair. First 500:', jsonStr.slice(0, 500));
      throw new Error('Failed to parse AI response as JSON');
    }
  }

  // Validate structure
  if (!presentation.title || !Array.isArray(presentation.slides) || presentation.slides.length === 0) {
    console.error('Invalid structure:', JSON.stringify(presentation).slice(0, 500));
    throw new Error('Invalid presentation structure from AI');
  }

  // Ensure each slide has all required fields and enforce mutual exclusion
  presentation.slides = presentation.slides.map(slide => {
    const hasChart = Array.isArray(slide.chartData) && slide.chartData.length > 0;
    const hasAudience = !!slide.audience;
    const hasQuote = !!(slide.quote && String(slide.quote).trim());

    // Priority: audience > chart > quote (only one overlay per slide)
    return {
      title: slide.title || 'Untitled',
      subtitle: slide.subtitle || '',
      quote: (hasQuote && !hasAudience && !hasChart) ? String(slide.quote).trim() : '',
      chartData: (hasChart && !hasAudience)
        ? slide.chartData!.filter((d: any) => d && d.label != null && d.value != null).map((d: any) => ({
            label: String(d.label),
            value: Number(d.value) || 0,
          }))
        : null,
      audience: hasAudience,
      imageQuery: slide.imageQuery || 'random object',
      imageUrl: '',
      notes: slide.notes || '',
    };
  });
  presentation.difficulty = difficulty;

  // Fetch images in parallel
  const imageUrls = await Promise.all(
    presentation.slides.map((slide, i) => fetchImageUrl(env, slide.imageQuery, i))
  );

  presentation.slides.forEach((slide, i) => {
    slide.imageUrl = imageUrls[i];
  });

  return presentation;
}

// ================================================================
// HTML TEMPLATE
// ================================================================

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Slide Karaoke — NodeConf EU 2026</title>
<link rel="icon" href="https://nodeconf.eu/hexagon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300..900;1,9..144,300..900&family=Hanken+Grotesk:wght@300..900&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
/* ---- RESET & BASE ---- */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --paper: #14110c;
  --paper-deep: #1a1611;
  --panel: #1c1813;
  --ink: #f3ecdc;
  --ink-soft: #b8ae98;
  --muted: #968c78;
  --accent: #6ad975;
  --accent-strong: #6ad975;
  --accent-dim: #6ad97540;
  --border: #f3ecdce0;
  --rule: #f3ecdc38;
  --surface: #1c1813;
  --surface-elevated: #211c16;
  --shadow-hard: 4px 4px 0 0 #f3ecdc;
  --shadow-hard-sm: 3px 3px 0 0 #f3ecdc;

  --display: "Fraunces", "Times New Roman", serif;
  --body: "Hanken Grotesk", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
  --mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

html, body {
  height: 100%;
  font-family: var(--body);
  color: var(--ink);
  background: var(--paper);
  font-synthesis: none;
  text-rendering: optimizelegibility;
  -webkit-font-smoothing: antialiased;
  line-height: 1.55;
  overflow: hidden;
}

body {
  background:
    radial-gradient(ellipse at 18% 10%, #39b54a12, transparent 35%),
    radial-gradient(ellipse at 86% 8%, #39b54a0d, transparent 32%),
    linear-gradient(180deg, #14110c 0%, #110e09 50%, #0d0b07 100%);
}

body::before {
  content: "";
  pointer-events: none;
  opacity: .06;
  mix-blend-mode: screen;
  background-image: url("data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 60 52' width='60' height='52'%3E%3Cpath d='M15 1.7h30L60 26 45 50.3H15L0 26Z' fill='none' stroke='%23f3ecdc' stroke-opacity='1' stroke-width='1'/%3E%3C/svg%3E");
  background-size: 60px 52px;
  position: fixed;
  inset: 0;
  z-index: 0;
}

a { color: inherit; }

/* ---- VIEWS ---- */
.view {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.4s ease;
  z-index: 1;
  overflow-y: auto;
  padding: 1.5rem 0;
}
.view.active {
  opacity: 1;
  pointer-events: auto;
}

/* ---- LANDING ---- */
.landing-shell {
  width: min(800px, 100% - 2rem);
  display: grid;
  gap: 1.5rem;
  margin: auto 0;
  animation: rise 0.7s cubic-bezier(0.16, 1, 0.3, 1) both;
}

@keyframes rise {
  from { opacity: 0; transform: translateY(16px); }
  to   { opacity: 1; transform: translateY(0); }
}

.site-header {
  border: 1px solid var(--border);
  background: var(--surface);
  box-shadow: var(--shadow-hard-sm);
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.9rem 1.25rem;
}

.brand-mark {
  font-family: var(--mono);
  font-size: 0.78rem;
  font-weight: 500;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 0.55rem;
}
.brand-mark::before {
  content: "";
  width: 11px;
  height: 12px;
  background: var(--accent);
  clip-path: polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%);
}

.brand-sub {
  font-family: var(--mono);
  font-size: 0.7rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--muted);
}

.landing-main {
  border: 1px solid var(--border);
  background: var(--panel);
  box-shadow: var(--shadow-hard);
  padding: clamp(1.5rem, 4vw, 2.75rem);
  display: grid;
  gap: 1.6rem;
  position: relative;
  overflow: hidden;
  min-width: 0;
}
.landing-main::after {
  content: "";
  opacity: 0.18;
  pointer-events: none;
  mix-blend-mode: screen;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='94' height='82' viewBox='0 0 94 82'%3E%3Cpath d='M23.5 1h47L93 41 70.5 81h-47L1 41 23.5 1Z' fill='none' stroke='%2339b54a' stroke-opacity='.28'/%3E%3C/svg%3E");
  background-size: 94px 82px;
  position: absolute;
  inset: 0;
}
.landing-main > * { position: relative; z-index: 1; }

.kicker {
  font-family: var(--mono);
  font-size: 0.74rem;
  font-weight: 500;
  letter-spacing: 0.24em;
  text-transform: uppercase;
  color: var(--ink);
  display: inline-flex;
  align-items: center;
  gap: 0.55rem;
}
.kicker::before {
  content: "";
  width: 8px; height: 9px;
  background: var(--accent);
  clip-path: polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%);
}

.landing-copy { display: grid; gap: 0.9rem; }

.landing-copy h1 {
  font-family: var(--display);
  font-variation-settings: "opsz" 144, "SOFT" 50, "WONK" 0;
  font-size: clamp(3.2rem, 10vw, 6.5rem);
  font-weight: 400;
  line-height: 0.88;
  letter-spacing: -0.045em;
  margin: 0;
}
.landing-copy h1 em {
  font-family: var(--display);
  font-variation-settings: "opsz" 144, "SOFT" 100, "WONK" 1;
  color: var(--accent);
  font-weight: 400;
  display: block;
}

.landing-text {
  max-width: 50ch;
  color: var(--ink-soft);
  font-size: 1.04rem;
  line-height: 1.55;
}

/* ---- FORM ---- */
.prompt-form {
  display: grid;
  gap: 0.75rem;
}

.input-group {
  display: flex;
  border: 1px solid var(--border);
  background: var(--surface-elevated);
  box-shadow: var(--shadow-hard-sm);
}

.input-group input {
  flex: 1;
  min-height: 3.2rem;
  padding: 0.8rem 1rem;
  font-family: var(--body);
  font-size: 1.05rem;
  color: var(--ink);
  background: transparent;
  border: none;
  outline: none;
}
.input-group input::placeholder { color: var(--muted); }

.random-btn {
  min-width: 3.2rem;
  border: none;
  border-left: 1px solid var(--rule);
  background: transparent;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 0.72rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  cursor: pointer;
  padding: 0 0.8rem;
  transition: background 0.15s, color 0.15s;
}
.random-btn:hover { background: var(--accent-dim); color: var(--accent); }

.button {
  border: 1px solid var(--ink);
  min-height: 3rem;
  font-family: var(--mono);
  font-size: 0.82rem;
  font-weight: 500;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  box-shadow: var(--shadow-hard-sm);
  display: inline-flex;
  justify-content: center;
  align-items: center;
  gap: 0.55rem;
  padding: 0.85rem 1.4rem;
  text-decoration: none;
  cursor: pointer;
  transition: transform 0.14s, box-shadow 0.14s, background 0.14s, color 0.14s;
}
.button:hover, .button:focus-visible {
  box-shadow: 1px 1px 0 0 var(--paper-deep);
  transform: translate(2px, 2px);
}

.button-primary {
  background: var(--accent);
  color: #14110c;
  border-color: var(--ink);
}
.button-primary:hover { background: #8ce895; }
.button-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
  box-shadow: var(--shadow-hard-sm);
}

.button-instant {
  background: transparent;
  color: var(--accent);
  border: 2px solid var(--accent);
  width: 100%;
  margin-top: 0.5rem;
  font-size: 0.95rem;
}
.button-instant:hover {
  background: var(--accent);
  color: #14110c;
}
.button-instant:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
}

.hex-icon {
  font-size: 0.65rem;
}

/* ---- DIFFICULTY SELECTOR ---- */
.difficulty-selector {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.5rem;
}

.diff-btn {
  border: 1px solid var(--rule);
  background: transparent;
  color: var(--ink-soft);
  font-family: var(--mono);
  font-size: 0.76rem;
  font-weight: 500;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  padding: 0.6rem 0.5rem 0.5rem;
  cursor: pointer;
  text-align: center;
  transition: border-color 0.15s, color 0.15s, background 0.15s;
}
.diff-btn:hover { border-color: var(--accent); color: var(--ink); }
.diff-btn.active {
  border-color: var(--accent);
  background: var(--accent-dim);
  color: var(--accent);
}

.diff-desc {
  display: block;
  font-size: 0.58rem;
  font-weight: 400;
  letter-spacing: 0.06em;
  color: var(--muted);
  margin-top: 0.2rem;
}
.diff-btn.active .diff-desc { color: var(--accent); }

.presenter-input {
  border: 1px solid var(--rule);
  background: var(--surface-elevated);
  color: var(--ink);
  font-family: var(--body);
  font-size: 0.92rem;
  padding: 0.6rem 1rem;
  width: 100%;
  outline: none;
  transition: border-color 0.15s;
}
.presenter-input::placeholder { color: var(--muted); }
.presenter-input:focus { border-color: var(--accent); }

.suggestions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  font-family: var(--mono);
  font-size: 0.72rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}

.suggestion {
  border: 1px solid var(--rule);
  background: transparent;
  color: var(--ink-soft);
  font-family: var(--mono);
  font-size: 0.72rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 0.35rem 0.65rem;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s, transform 0.15s, box-shadow 0.15s;
}
.suggestion:hover {
  border-color: var(--accent);
  color: var(--ink);
  box-shadow: var(--shadow-hard-sm);
  transform: translate(-2px, -2px);
}

.site-footer {
  border: 1px solid var(--border);
  background: var(--surface);
  box-shadow: var(--shadow-hard-sm);
  padding: 0.7rem 1.25rem;
  font-family: var(--mono);
  font-size: 0.7rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--muted);
  text-align: center;
}

/* ---- LOADING ---- */
.loading-container {
  text-align: center;
  display: grid;
  gap: 1.2rem;
  justify-items: center;
  margin: auto 0;
}

.hex-spinner {
  width: 50px;
  height: 58px;
  position: relative;
}
.hex-spinner .hex {
  width: 50px;
  height: 58px;
  background: var(--accent);
  clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);
  animation: hex-pulse 1.4s ease-in-out infinite;
}

@keyframes hex-pulse {
  0%, 100% { transform: rotate(0deg) scale(1); opacity: 1; }
  50%      { transform: rotate(180deg) scale(0.7); opacity: 0.6; }
}

.loading-text {
  font-family: var(--display);
  font-variation-settings: "opsz" 96, "SOFT" 50, "WONK" 1;
  font-size: clamp(1.8rem, 5vw, 2.8rem);
  font-weight: 400;
  font-style: italic;
  letter-spacing: -0.03em;
  color: var(--ink);
}

.loading-sub {
  font-family: var(--mono);
  font-size: 0.74rem;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--muted);
}

/* ---- READY ---- */
.ready-container {
  text-align: center;
  max-width: 700px;
  padding: 2rem;
  display: grid;
  gap: 1.2rem;
  justify-items: center;
  margin: auto 0;
  animation: rise 0.6s cubic-bezier(0.16, 1, 0.3, 1) both;
}

.ready-container h1 {
  font-family: var(--display);
  font-variation-settings: "opsz" 144, "SOFT" 50, "WONK" 1;
  font-size: clamp(2.6rem, 7vw, 5rem);
  font-weight: 400;
  font-style: italic;
  letter-spacing: -0.04em;
  line-height: 0.92;
  color: var(--ink);
  text-wrap: balance;
}

.ready-info {
  font-family: var(--mono);
  font-size: 0.82rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--accent);
}

.ready-presenter {
  font-family: var(--display);
  font-variation-settings: "opsz" 48, "SOFT" 100, "WONK" 1;
  font-size: 1.2rem;
  font-style: italic;
  color: var(--ink-soft);
}

.ready-hint {
  font-family: var(--mono);
  font-size: 0.68rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--muted);
  margin-top: 0.5rem;
}

/* ---- PRESENTATION ---- */
#view-presentation { padding: 0; }
.slide-container {
  position: fixed;
  inset: 0;
  background: #000;
}

.slide-bg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center;
  opacity: 0;
  transition: opacity 0.6s ease;
}
.slide-bg.loaded { opacity: 1; }

.slide-gradient {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    to bottom,
    rgba(0,0,0,0) 0%,
    rgba(0,0,0,0) 35%,
    rgba(0,0,0,0.25) 55%,
    rgba(0,0,0,0.82) 100%
  );
}

.slide-content {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  padding: clamp(1.5rem, 4vw, 3rem);
  padding-bottom: clamp(3rem, 6vw, 5rem);
}

.slide-title {
  font-family: var(--display);
  font-variation-settings: "opsz" 144, "SOFT" 50, "WONK" 0;
  font-size: clamp(3rem, 8vw, 7rem);
  font-weight: 500;
  letter-spacing: -0.04em;
  line-height: 0.92;
  color: #fff;
  text-shadow: 0 2px 30px rgba(0,0,0,0.5), 0 1px 6px rgba(0,0,0,0.3);
  margin: 0;
}

.slide-subtitle {
  font-family: var(--display);
  font-variation-settings: "opsz" 48, "SOFT" 100, "WONK" 1;
  font-size: clamp(1.1rem, 3vw, 1.8rem);
  font-weight: 400;
  font-style: italic;
  letter-spacing: -0.01em;
  color: rgba(255,255,255,0.7);
  text-shadow: 0 1px 10px rgba(0,0,0,0.4);
  margin: 0.4rem 0 0;
}

.slide-presenter {
  font-family: var(--body);
  font-size: clamp(0.85rem, 2vw, 1.1rem);
  font-weight: 300;
  color: var(--accent);
  text-shadow: 0 1px 8px rgba(0,0,0,0.5);
  margin: 0.8rem 0 0;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  display: none;
}

/* ---- QUOTE OVERLAY ---- */
.slide-quote-container {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 3;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.35s ease;
}
.slide-quote-container.visible { opacity: 1; }

.slide-quote-inner {
  text-align: center;
  max-width: 70%;
  padding: 2.5rem 3rem;
  background: rgba(0, 0, 0, 0.65);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid rgba(255,255,255,0.12);
}

.slide-quote-text {
  font-family: var(--display);
  font-variation-settings: "opsz" 72, "SOFT" 100, "WONK" 1;
  font-size: clamp(1.6rem, 4vw, 3rem);
  font-weight: 400;
  font-style: italic;
  letter-spacing: -0.02em;
  line-height: 1.2;
  color: #fff;
  text-shadow: 0 2px 16px rgba(0,0,0,0.4);
  margin: 0;
  text-wrap: balance;
}
.slide-quote-text::before { content: "\\201C"; }
.slide-quote-text::after  { content: "\\201D"; }

.slide-quote-attr {
  display: block;
  font-family: var(--mono);
  font-size: clamp(0.72rem, 1.4vw, 0.92rem);
  font-style: normal;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--accent);
  margin-top: 1rem;
}

/* Per-person style variations — applied as data-contributor on .slide-quote-inner */
[data-contributor="collina"] .slide-quote-text { color: #ffd166; }
[data-contributor="collina"] { border-color: #ffd166; }

[data-contributor="snell"] .slide-quote-text { font-variation-settings: "opsz" 144, "SOFT" 0, "WONK" 0; font-style: normal; font-weight: 600; text-transform: uppercase; font-size: clamp(1.4rem, 3.5vw, 2.6rem); letter-spacing: 0.02em; }

[data-contributor="nizipli"] .slide-quote-text { font-family: var(--mono); font-style: normal; font-size: clamp(1.2rem, 2.8vw, 2rem); letter-spacing: 0.02em; color: #7df9ff; }
[data-contributor="nizipli"] { border-color: #7df9ff; }

[data-contributor="nagy"] .slide-quote-text { font-variation-settings: "opsz" 9, "SOFT" 100, "WONK" 1; font-size: clamp(2rem, 5vw, 3.6rem); }

[data-contributor="zasso"] .slide-quote-inner { border: 2px solid #ef476f; }
[data-contributor="zasso"] .slide-quote-text { color: #ef476f; }

[data-contributor="insogna"] .slide-quote-inner { border: 2px dashed var(--accent); background: rgba(0,0,0,0.8); }

[data-contributor="cheung"] .slide-quote-text { font-family: var(--body); font-style: normal; font-weight: 300; font-size: clamp(1.4rem, 3vw, 2.4rem); letter-spacing: 0.04em; }

[data-contributor="borins"] .slide-quote-text { text-transform: uppercase; font-style: normal; font-weight: 500; letter-spacing: 0.06em; font-size: clamp(1.3rem, 3vw, 2.2rem); }

[data-contributor="henningsen"] .slide-quote-inner { background: rgba(106, 217, 117, 0.15); border: 1px solid var(--accent); }

[data-contributor="hamel"] .slide-quote-text { font-variation-settings: "opsz" 48, "SOFT" 100, "WONK" 1; color: #e9c46a; }

[data-contributor="gruenbaum"] .slide-quote-text { font-family: var(--mono); font-style: normal; font-size: clamp(1.1rem, 2.6vw, 1.9rem); color: #a0e7a0; }
[data-contributor="gruenbaum"] .slide-quote-text::before,
[data-contributor="gruenbaum"] .slide-quote-text::after { content: ""; }
[data-contributor="gruenbaum"] .slide-quote-text::before { content: "> "; }

[data-contributor="gonzaga"] .slide-quote-inner { border-left: 4px solid #ff6b6b; border-right: none; border-top: none; border-bottom: none; text-align: left; }

[data-contributor="ippolito"] .slide-quote-text { color: #c8b6ff; }
[data-contributor="ippolito"] { border-color: #c8b6ff; }

[data-contributor="booth"] .slide-quote-text { font-family: var(--body); font-weight: 700; font-style: normal; font-size: clamp(1.8rem, 4.2vw, 3.2rem); }

[data-contributor="wunder"] .slide-quote-inner { border: 1px solid rgba(255,255,255,0.3); transform: rotate(-1deg); }

[data-contributor="bridgewater"] .slide-quote-text::before,
[data-contributor="bridgewater"] .slide-quote-text::after { content: ""; }
[data-contributor="bridgewater"] .slide-quote-text { font-style: normal; text-decoration: underline; text-decoration-color: var(--accent); text-underline-offset: 6px; }

[data-contributor="cyren"] .slide-quote-text { color: #ff9ff3; }
[data-contributor="cyren"] .slide-quote-attr { color: #ff9ff3; }

[data-contributor="english"] .slide-quote-inner { background: rgba(0,0,0,0.85); border: none; padding: 3rem 3.5rem; }
[data-contributor="english"] .slide-quote-text { font-family: var(--body); font-style: normal; font-weight: 200; font-size: clamp(1.6rem, 3.6vw, 2.8rem); letter-spacing: 0.01em; }

[data-contributor="belanger"] .slide-quote-text { font-variation-settings: "opsz" 144, "SOFT" 50, "WONK" 1; font-size: clamp(2rem, 5vw, 3.8rem); font-weight: 300; }

/* ---- CHART OVERLAY ---- */
.slide-chart-container {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 3;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.35s ease;
}
.slide-chart-container.visible { opacity: 1; }

.slide-chart-inner {
  background: rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid rgba(255,255,255,0.12);
  padding: 2rem 2.5rem 1.5rem;
  min-width: 50%;
  max-width: 80%;
}

.chart-bars {
  display: flex;
  align-items: flex-end;
  gap: clamp(0.8rem, 2vw, 1.5rem);
  height: clamp(10rem, 30vh, 18rem);
  padding-bottom: 0.5rem;
}

.chart-bar-group {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.4rem;
  height: 100%;
  justify-content: flex-end;
}

.chart-bar {
  width: 100%;
  max-width: 5rem;
  min-height: 4px;
  background: var(--accent);
  border: 1px solid rgba(255,255,255,0.2);
  transition: height 0.6s cubic-bezier(0.16, 1, 0.3, 1);
}
.chart-bar-group:nth-child(2n) .chart-bar { background: #ffd166; }
.chart-bar-group:nth-child(3n) .chart-bar { background: #ef476f; }
.chart-bar-group:nth-child(5n) .chart-bar { background: #7df9ff; }

.chart-value {
  font-family: var(--mono);
  font-size: 0.72rem;
  color: rgba(255,255,255,0.7);
  letter-spacing: 0.04em;
}

.chart-label {
  font-family: var(--mono);
  font-size: clamp(0.58rem, 1.2vw, 0.72rem);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: rgba(255,255,255,0.6);
  text-align: center;
  max-width: 8rem;
  word-break: break-word;
}

/* ---- AUDIENCE PARTICIPATION ---- */
.slide-audience-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 3;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.35s ease;
}
.slide-audience-overlay.visible { opacity: 1; }

.slide-audience-inner {
  text-align: center;
  max-width: 80%;
  animation: audience-pulse 2s ease-in-out infinite;
}

@keyframes audience-pulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.03); }
}

.slide-audience-label {
  font-family: var(--mono);
  font-size: 0.72rem;
  letter-spacing: 0.24em;
  text-transform: uppercase;
  color: var(--accent);
  margin-bottom: 1rem;
}

.slide-audience-text {
  font-family: var(--display);
  font-variation-settings: "opsz" 144, "SOFT" 50, "WONK" 0;
  font-size: clamp(2rem, 6vw, 4.5rem);
  font-weight: 500;
  letter-spacing: -0.03em;
  line-height: 1;
  color: #fff;
  text-shadow: 0 2px 20px rgba(0,0,0,0.5);
  text-wrap: balance;
}

.slide-chrome {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.8rem clamp(1.5rem, 4vw, 3rem);
}

.slide-counter {
  font-family: var(--mono);
  font-size: 0.72rem;
  letter-spacing: 0.16em;
  color: rgba(255,255,255,0.5);
}

.slide-hints {
  font-family: var(--mono);
  font-size: 0.62rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: rgba(255,255,255,0.3);
  transition: opacity 0.3s;
}
.slide-container:hover .slide-hints { color: rgba(255,255,255,0.5); }

/* ---- TIMER ---- */
.slide-timer {
  position: absolute;
  top: 1rem;
  left: 50%;
  transform: translateX(-50%);
  font-family: var(--mono);
  font-size: 1.4rem;
  letter-spacing: 0.06em;
  color: rgba(255,255,255,0.7);
  background: rgba(0,0,0,0.5);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  padding: 0.4rem 1rem;
  border: 1px solid rgba(255,255,255,0.1);
  z-index: 8;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.3s;
  user-select: none;
}
.slide-timer.visible { opacity: 1; }
.slide-timer.warning { color: #ffd166; border-color: rgba(255,209,102,0.3); }
.slide-timer.danger  { color: #ef476f; border-color: rgba(239,71,111,0.3); animation: timer-pulse 1s ease-in-out infinite; }

@keyframes timer-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}

.slide-notes-overlay {
  position: absolute;
  top: 1rem;
  right: 1rem;
  max-width: 400px;
  background: rgba(20, 17, 12, 0.92);
  border: 1px solid var(--accent-dim);
  padding: 1rem 1.2rem;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.25s;
  z-index: 10;
}
.slide-notes-overlay.visible {
  opacity: 1;
  pointer-events: auto;
}

.slide-notes-label {
  font-family: var(--mono);
  font-size: 0.62rem;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--accent);
  margin-bottom: 0.5rem;
}

.slide-notes-text {
  font-family: var(--body);
  font-size: 0.88rem;
  line-height: 1.5;
  color: var(--ink-soft);
}

/* ---- FIN ---- */
.fin-container {
  text-align: center;
  display: grid;
  gap: 1.5rem;
  justify-items: center;
  margin: auto 0;
  animation: rise 0.5s cubic-bezier(0.16, 1, 0.3, 1) both;
}

.fin-container h1 {
  font-family: var(--display);
  font-variation-settings: "opsz" 144, "SOFT" 100, "WONK" 1;
  font-size: clamp(4rem, 12vw, 9rem);
  font-weight: 400;
  font-style: italic;
  letter-spacing: -0.05em;
  line-height: 0.85;
  color: var(--accent);
}

.fin-title {
  font-family: var(--display);
  font-variation-settings: "opsz" 48, "SOFT" 50, "WONK" 1;
  font-size: clamp(1rem, 2.5vw, 1.6rem);
  font-weight: 400;
  font-style: italic;
  color: var(--ink-soft);
  max-width: 30ch;
  text-wrap: balance;
}

/* ---- ERROR ---- */
.error-container {
  text-align: center;
  display: grid;
  gap: 1.2rem;
  justify-items: center;
  max-width: 500px;
  padding: 2rem;
  margin: auto 0;
}

.error-container h2 {
  font-family: var(--display);
  font-variation-settings: "opsz" 96, "SOFT" 50, "WONK" 1;
  font-size: 3rem;
  font-weight: 400;
  font-style: italic;
  color: var(--ink);
}

.error-message {
  color: var(--ink-soft);
  font-size: 1rem;
  max-width: 40ch;
}

/* ---- PROGRESS BAR ---- */
.slide-progress {
  position: absolute;
  top: 0;
  left: 0;
  height: 3px;
  background: var(--accent);
  transition: width 0.4s ease;
  z-index: 5;
}

/* ---- RECENT DECKS ---- */
.recent-section {
  border-top: 1px solid var(--rule);
  padding-top: 1rem;
  display: grid;
  gap: 0.75rem;
  min-width: 0;
}

.recent-list {
  display: grid;
  gap: 0.5rem;
  min-width: 0;
  max-height: 11rem;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: var(--muted) transparent;
  padding-right: 0.25rem;
}
.recent-list::-webkit-scrollbar { width: 5px; }
.recent-list::-webkit-scrollbar-track { background: transparent; }
.recent-list::-webkit-scrollbar-thumb { background: var(--muted); border-radius: 3px; }

.recent-card {
  border: 1px solid var(--rule);
  background: var(--surface-elevated);
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 0.75rem;
  padding: 0.7rem 1rem;
  cursor: pointer;
  text-decoration: none;
  color: inherit;
  min-width: 0;
  transition: border-color 0.15s, transform 0.15s, box-shadow 0.15s;
}
.recent-card:hover {
  border-color: var(--accent);
  box-shadow: var(--shadow-hard-sm);
  transform: translate(-2px, -2px);
}

.recent-card-title {
  font-family: var(--display);
  font-variation-settings: "opsz" 36, "SOFT" 50, "WONK" 1;
  font-size: 1.05rem;
  font-weight: 500;
  font-style: italic;
  letter-spacing: -0.01em;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.recent-card-meta {
  font-family: var(--mono);
  font-size: 0.62rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--muted);
  white-space: nowrap;
}

/* ---- SHARE LINK ---- */
.share-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-top: 0.4rem;
}

.share-url {
  font-family: var(--mono);
  font-size: 0.7rem;
  letter-spacing: 0.04em;
  color: var(--muted);
  max-width: 30ch;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.copy-btn {
  border: 1px solid var(--rule);
  background: transparent;
  color: var(--ink-soft);
  font-family: var(--mono);
  font-size: 0.65rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  padding: 0.3rem 0.6rem;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}
.copy-btn:hover { border-color: var(--accent); color: var(--accent); }

/* ---- MOBILE ---- */
@media (max-width: 640px) {
  .landing-shell { width: min(100%, 100% - 1rem); }
  .landing-main { padding: 1.2rem; }
  .slide-title { font-size: clamp(2.2rem, 10vw, 3.5rem) !important; }
  .suggestions { gap: 0.35rem; }
}

/* ---- TRANSITIONS ---- */
.fade-content {
  transition: opacity 0.35s ease, transform 0.45s cubic-bezier(0.16, 1, 0.3, 1);
  transform: translate(0, 0) scale(1);
}
.fade-content.fading { opacity: 0; }
.fade-content.fading.tr-slide-up    { transform: translateY(30px); }
.fade-content.fading.tr-slide-left  { transform: translateX(40px); }
.fade-content.fading.tr-zoom        { transform: scale(0.92); }

/* ---- TITLE SLIDE (slide 0) ---- */
.slide-content.is-title-slide {
  top: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  text-align: center;
  padding: clamp(2rem, 5vw, 4rem);
}
.slide-content.is-title-slide .slide-title {
  font-size: clamp(3.5rem, 10vw, 9rem);
  font-variation-settings: "opsz" 144, "SOFT" 100, "WONK" 1;
  font-style: italic;
  line-height: 0.88;
}
.slide-content.is-title-slide .slide-subtitle {
  font-size: clamp(1.2rem, 3.5vw, 2.2rem);
}
.slide-content.is-title-slide .slide-presenter {
  font-size: clamp(0.9rem, 2.5vw, 1.3rem);
}

/* ---- QR CODE (fin view) ---- */
.fin-qr {
  margin-top: 0.5rem;
}
.fin-qr canvas {
  border: 3px solid var(--ink);
  background: #fff;
}
.fin-share-hint {
  font-family: var(--mono);
  font-size: 0.75rem;
  color: var(--muted);
  margin-top: 0.3rem;
  word-break: break-all;
  max-width: 22rem;
}
</style>
</head>
<body>

<!-- ============ LANDING ============ -->
<div id="view-landing" class="view active">
  <div class="landing-shell">
    <header class="site-header">
      <span class="brand-mark">Slide Karaoke</span>
      <span class="brand-sub">NodeConf EU 2026</span>
    </header>

    <main class="landing-main">
      <div class="landing-copy">
        <p class="kicker">Slide Karaoke</p>
        <h1>Slide<br><em>Karaoke.</em></h1>
        <p class="landing-text">
          Enter any topic. Our AI will generate the most absurd
          presentation imaginable. Then someone has to present it.
          Live. Without preparation. Good luck.
        </p>
      </div>

      <form id="generate-form" class="prompt-form">
        <div class="input-group">
          <input
            type="text"
            id="prompt-input"
            placeholder="quarterly earnings report"
            maxlength="200"
            autocomplete="off"
            required
          >
          <button type="button" id="random-btn" class="random-btn" title="Random topic">
            Random
          </button>
        </div>
        <div class="difficulty-selector" id="difficulty-selector">
          <button type="button" class="diff-btn" data-diff="easy">Easy<span class="diff-desc">8 slides, survivable</span></button>
          <button type="button" class="diff-btn active" data-diff="medium">Medium<span class="diff-desc">10 slides, absurd</span></button>
          <button type="button" class="diff-btn" data-diff="hard">Hard<span class="diff-desc">15 slides, unhinged</span></button>
        </div>
        <input
          type="text"
          id="presenter-input"
          class="presenter-input"
          placeholder="Speaker name"
          maxlength="60"
          autocomplete="off"
        >
        <button type="submit" id="submit-btn" class="button button-primary">
          <span class="hex-icon">&#x25C6;</span> Generate Slides
        </button>
      </form>

      <button id="instant-btn" class="button button-instant" title="Grab a pre-generated deck and start immediately">
        <span class="hex-icon">&#x26A1;</span> Instant Play
      </button>

      <div class="suggestions">
        <span>Try:</span>
        <button class="suggestion" type="button">Node.js Performance</button>
        <button class="suggestion" type="button">Cloud Migration</button>
        <button class="suggestion" type="button">Team Building</button>
        <button class="suggestion" type="button">AI Strategy</button>
        <button class="suggestion" type="button">Budget Review</button>
      </div>

      <div id="recent-section" class="recent-section" hidden>
        <p class="kicker">Recent Decks</p>
        <div id="recent-list" class="recent-list"></div>
      </div>
    </main>

    <footer class="site-footer">
      Powered by Cloudflare Workers AI
    </footer>
  </div>
</div>

<!-- ============ LOADING ============ -->
<div id="view-loading" class="view">
  <div class="loading-container">
    <div class="hex-spinner"><div class="hex"></div></div>
    <p class="loading-text">Generating absurdity...</p>
    <p class="loading-sub" id="loading-status">Asking the AI for something truly unhinged</p>
  </div>
</div>

<!-- ============ READY ============ -->
<div id="view-ready" class="view">
  <div class="ready-container">
    <p class="kicker">Ready to present</p>
    <h1 id="ready-title"></h1>
    <p class="ready-info"><span id="ready-count"></span> slides of pure absurdity</p>
    <p class="ready-presenter" id="ready-presenter"></p>
    <div class="share-row" id="share-row">
      <span class="share-url" id="share-url"></span>
      <button class="copy-btn" id="copy-btn" type="button">Copy Link</button>
    </div>
    <button id="start-btn" class="button button-primary">
      <span class="hex-icon">&#x25C6;</span> Begin Presentation
    </button>
    <p class="ready-hint">Arrow keys to navigate &middot; ESC to exit &middot; N for speaker notes</p>
  </div>
</div>

<!-- ============ PRESENTATION ============ -->
<div id="view-presentation" class="view">
  <div class="slide-container" id="slide-container">
    <div class="slide-progress" id="slide-progress"></div>
    <img class="slide-bg" id="slide-bg" alt="" draggable="false">
    <div class="slide-gradient"></div>
    <div class="slide-content fade-content" id="slide-text-content">
      <h2 class="slide-title" id="slide-title"></h2>
      <p class="slide-subtitle" id="slide-subtitle"></p>
      <p class="slide-presenter" id="slide-presenter"></p>
    </div>
    <div class="slide-quote-container fade-content" id="slide-quote-container">
      <div class="slide-quote-inner" id="slide-quote-inner">
        <blockquote class="slide-quote-text" id="slide-quote-text"></blockquote>
        <cite class="slide-quote-attr" id="slide-quote-attr"></cite>
      </div>
    </div>
    <div class="slide-chart-container" id="slide-chart-container">
      <div class="slide-chart-inner">
        <div class="chart-bars" id="chart-bars"></div>
      </div>
    </div>
    <div class="slide-audience-overlay" id="slide-audience-overlay">
      <div class="slide-audience-inner">
        <p class="slide-audience-label">Audience Participation</p>
        <p class="slide-audience-text" id="slide-audience-text"></p>
      </div>
    </div>
    <div class="slide-timer" id="slide-timer">5:00</div>
    <div class="slide-chrome">
      <span class="slide-counter" id="slide-counter"></span>
      <span class="slide-hints" id="slide-hints">&#8592; &#8594; navigate &middot; ESC exit &middot; N notes &middot; T timer</span>
    </div>
    <div class="slide-notes-overlay" id="slide-notes">
      <p class="slide-notes-label">Speaker Notes</p>
      <p class="slide-notes-text" id="notes-text"></p>
    </div>
  </div>
</div>

<!-- ============ FIN ============ -->
<div id="view-fin" class="view">
  <div class="fin-container">
    <h1>Fin.</h1>
    <p class="fin-title" id="fin-title"></p>
    <div class="fin-qr" id="fin-qr"></div>
    <p class="fin-share-hint" id="fin-share-hint"></p>
    <button id="new-btn" class="button button-primary">
      <span class="hex-icon">&#x25C6;</span> New Presentation
    </button>
  </div>
</div>

<!-- ============ ERROR ============ -->
<div id="view-error" class="view">
  <div class="error-container">
    <h2>Oops.</h2>
    <p class="error-message" id="error-message">Something went wrong generating the presentation.</p>
    <button id="retry-btn" class="button button-primary">
      <span class="hex-icon">&#x25C6;</span> Try Again
    </button>
  </div>
</div>

<script>
(function() {
  'use strict';

  // ---- State ----
  var presentation = null;
  var currentSlide = 0;
  var notesVisible = false;
  var selectedDifficulty = 'medium';
  var presenterName = '';

  // ---- Fake presenter names ----
  var FAKE_NAMES = [
    'Ms. Kari Oakie',
    'Mr. Pre Senter',
    'Dr. Slide Deckson',
    'Prof. Tal King-Point',
    'Ms. Power Pointless',
    'Mr. Bul Letpoint',
    'Dr. Laz R. Pointer',
    'Ms. Kee Note',
    'Mr. Mike Rofone',
    'Prof. Audi Torium',
    'Dr. Pro Jector',
    'Ms. Fli Pchard',
    'Mr. Ted Talke',
    'Prof. Stan Dupcomedy',
    'Dr. Poddy Umm',
    'Ms. Tele Prompter',
    'Mr. Q. N. Ay',
    'Prof. Handz Outt',
    'Dr. Cliff Hanger',
    'Ms. Seg Way',
    'Mr. Lec Tern',
    'Prof. No Tess',
    'Dr. Winging-Itt',
    'Ms. Awk Wardpause',
    'Mr. Nex Slide',
  ];

  function randomFakeName() {
    return FAKE_NAMES[Math.floor(Math.random() * FAKE_NAMES.length)];
  }

  // ---- Random topics ----
  var TOPICS = [
    'Quarterly sales report',
    'Introduction to Node.js',
    'The future of cloud computing',
    'Team building workshop',
    'Budget planning 2027',
    'Customer satisfaction survey',
    'DevOps best practices',
    'Annual company retreat',
    'Microservices architecture',
    'Employee onboarding',
    'Supply chain optimization',
    'Q4 marketing strategy',
    'Workplace wellness initiative',
    'Data center migration',
    'Cross-functional synergy',
    'Agile transformation roadmap',
    'Blockchain for HR',
    'Leveraging AI in accounting',
    'Sustainability metrics dashboard',
    'Digital twin strategy',
    'Serverless computing overview',
    'Container orchestration patterns',
    'Zero-trust security model',
    'GraphQL vs REST debate',
    'Technical debt management',
  ];

  // ---- DOM refs ----
  var views = {
    landing:      document.getElementById('view-landing'),
    loading:      document.getElementById('view-loading'),
    ready:        document.getElementById('view-ready'),
    presentation: document.getElementById('view-presentation'),
    fin:          document.getElementById('view-fin'),
    error:        document.getElementById('view-error'),
  };

  var els = {
    form:           document.getElementById('generate-form'),
    input:          document.getElementById('prompt-input'),
    submitBtn:      document.getElementById('submit-btn'),
    instantBtn:     document.getElementById('instant-btn'),
    presenterInput: document.getElementById('presenter-input'),
    randomBtn:      document.getElementById('random-btn'),
    loadingStatus:  document.getElementById('loading-status'),
    readyTitle:     document.getElementById('ready-title'),
    readyCount:     document.getElementById('ready-count'),
    readyPresenter: document.getElementById('ready-presenter'),
    shareRow:       document.getElementById('share-row'),
    shareUrl:       document.getElementById('share-url'),
    copyBtn:        document.getElementById('copy-btn'),
    startBtn:       document.getElementById('start-btn'),
    slideBg:        document.getElementById('slide-bg'),
    slideTitle:     document.getElementById('slide-title'),
    slideSubtitle:  document.getElementById('slide-subtitle'),
    slidePresenter: document.getElementById('slide-presenter'),
    slideQuoteContainer: document.getElementById('slide-quote-container'),
    slideQuoteInner: document.getElementById('slide-quote-inner'),
    slideQuoteText: document.getElementById('slide-quote-text'),
    slideQuoteAttr: document.getElementById('slide-quote-attr'),
    slideCounter:   document.getElementById('slide-counter'),
    slideProgress:  document.getElementById('slide-progress'),
    slideTextContent: document.getElementById('slide-text-content'),
    slideNotes:     document.getElementById('slide-notes'),
    slideTimer:     document.getElementById('slide-timer'),
    chartContainer: document.getElementById('slide-chart-container'),
    chartBars:      document.getElementById('chart-bars'),
    audienceOverlay: document.getElementById('slide-audience-overlay'),
    audienceText:   document.getElementById('slide-audience-text'),
    notesText:      document.getElementById('notes-text'),
    finTitle:       document.getElementById('fin-title'),
    finQr:          document.getElementById('fin-qr'),
    finShareHint:   document.getElementById('fin-share-hint'),
    newBtn:         document.getElementById('new-btn'),
    errorMessage:   document.getElementById('error-message'),
    retryBtn:       document.getElementById('retry-btn'),
    recentSection:  document.getElementById('recent-section'),
    recentList:     document.getElementById('recent-list'),
  };

  // ---- View management ----
  function showView(name) {
    Object.entries(views).forEach(function(entry) {
      entry[1].classList.toggle('active', entry[0] === name);
    });
    // Refresh recent list when returning to landing
    if (name === 'landing') loadRecent();
  }

  // ---- Image preloading ----
  function preloadImages(urls) {
    return Promise.all(urls.map(function(url) {
      return new Promise(function(resolve) {
        var img = new Image();
        img.onload = resolve;
        img.onerror = resolve;
        img.src = url;
      });
    }));
  }

  // ---- Recent decks ----
  function loadRecent() {
    fetch('/api/recent').then(function(r) { return r.json(); }).then(function(list) {
      if (!list || !list.length) {
        els.recentSection.hidden = true;
        return;
      }
      els.recentSection.hidden = false;
      els.recentList.innerHTML = list.map(function(entry) {
        var ago = timeAgo(entry.createdAt);
        return '<a class="recent-card" href="/p/' + entry.id + '" data-id="' + entry.id + '">'
          + '<span class="recent-card-title">' + escHtml(entry.title) + '</span>'
          + '<span class="recent-card-meta">' + escHtml(entry.prompt) + ' &middot; ' + ago + '</span>'
          + '</a>';
      }).join('');
      // Intercept clicks to load in-page
      els.recentList.querySelectorAll('.recent-card').forEach(function(card) {
        card.addEventListener('click', function(e) {
          e.preventDefault();
          loadDeck(card.getAttribute('data-id'));
        });
      });
    }).catch(function() {});
  }

  function escHtml(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function timeAgo(iso) {
    var diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  }

  // ---- Load a saved deck by id ----
  async function loadDeck(id) {
    showView('loading');
    els.loadingStatus.textContent = 'Loading saved deck...';
    try {
      var resp = await fetch('/api/deck/' + encodeURIComponent(id));
      if (!resp.ok) throw new Error('Deck not found');
      presentation = await resp.json();
      currentSlide = 0;
      notesVisible = false;
      els.loadingStatus.textContent = 'Loading images...';
      await preloadImages(presentation.slides.map(function(s) { return s.imageUrl; }));
      showReadyScreen();
    } catch (err) {
      els.errorMessage.textContent = err.message || 'Could not load that deck.';
      showView('error');
    }
  }

  // ---- Show ready screen with share link ----
  function showReadyScreen() {
    els.readyTitle.textContent = presentation.title;
    els.readyCount.textContent = presentation.slides.length;
    if (presenterName) {
      els.readyPresenter.textContent = 'Presented by ' + presenterName;
      els.readyPresenter.style.display = 'block';
    } else {
      els.readyPresenter.style.display = 'none';
    }
    if (presentation.id) {
      var link = location.origin + '/p/' + presentation.id;
      els.shareUrl.textContent = link;
      els.shareRow.style.display = 'flex';
      history.replaceState(null, '', '/p/' + presentation.id);
    } else {
      els.shareRow.style.display = 'none';
    }
    showView('ready');
  }

  // ---- Generate presentation ----
  async function generate(prompt) {
    presenterName = (els.presenterInput.value || '').trim();
    showView('loading');
    els.loadingStatus.textContent = 'Asking the AI for something truly unhinged';

    try {
      var loadingMessages = [
        'Consulting the department of absurdity',
        'Searching for maximally incongruent stock photos',
        'Calibrating nonsense levels',
        'Injecting corporate jargon into surrealist manifesto',
        'Almost there... probably',
      ];
      var msgIndex = 0;
      var msgInterval = setInterval(function() {
        msgIndex = (msgIndex + 1) % loadingMessages.length;
        els.loadingStatus.textContent = loadingMessages[msgIndex];
      }, 3000);

      var resp = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: prompt, difficulty: selectedDifficulty }),
      });

      clearInterval(msgInterval);

      if (!resp.ok) {
        var errData = await resp.json().catch(function() { return {}; });
        throw new Error(errData.error || 'Generation failed');
      }

      presentation = await resp.json();
      currentSlide = 0;
      notesVisible = false;

      // Preload images
      els.loadingStatus.textContent = 'Loading images...';
      await preloadImages(presentation.slides.map(function(s) { return s.imageUrl; }));

      showReadyScreen();
    } catch (err) {
      console.error('Generation error:', err);
      els.errorMessage.textContent = err.message || 'Something went wrong. Please try again.';
      showView('error');
    }
  }

  // ---- Contributor style mapping ----
  var CONTRIBUTOR_MAP = {
    'collina': 'collina', 'matteo': 'collina',
    'snell': 'snell', 'james': 'snell',
    'nizipli': 'nizipli', 'yagiz': 'nizipli',
    'zasso': 'zasso',
    'nagy': 'nagy', 'robert': 'nagy',
    'insogna': 'insogna', 'paolo': 'insogna',
    'cheung': 'cheung', 'joyee': 'cheung',
    'borins': 'borins', 'myles': 'borins',
    'henningsen': 'henningsen', 'anna': 'henningsen',
    'hamel': 'hamel', 'antoine': 'hamel',
    'gruenbaum': 'gruenbaum', 'benjamin': 'gruenbaum',
    'gonzaga': 'gonzaga', 'rafael': 'gonzaga',
    'ippolito': 'ippolito', 'marco': 'ippolito',
    'booth': 'booth', 'geoffrey': 'booth',
    'wunder': 'wunder', 'claudio': 'wunder',
    'bridgewater': 'bridgewater', 'ruben': 'bridgewater',
    'cyren': 'cyren', 'tierney': 'cyren',
    'english': 'english', 'bryan': 'english',
    'belanger': 'belanger', 'stephen': 'belanger',
    'lau': 'lau', 'richard': 'lau',
    'wu': 'wu', 'chengzhong': 'wu',
    'adams': 'adams', 'danielle': 'adams',
    'griggs': 'griggs', 'beth': 'griggs',
    'adorno': 'adorno', 'ruy': 'adorno',
    'ihrig': 'ihrig', 'colin': 'ihrig',
  };

  function getContributorKey(rawQuote) {
    var lower = rawQuote.toLowerCase();
    var keys = Object.keys(CONTRIBUTOR_MAP);
    for (var i = 0; i < keys.length; i++) {
      if (lower.indexOf(keys[i]) !== -1) return CONTRIBUTOR_MAP[keys[i]];
    }
    return '';
  }

  // ---- QR Code generator (minimal, alphanumeric mode, version 2-4) ----
  function renderQR(container, text, size) {
    // Use a canvas with a third-party-free approach:
    // Encode as a QR-like grid via a simple data URL through an img tag
    // pointing at a chart API endpoint (public, no key needed)
    var img = document.createElement('img');
    img.width = size;
    img.height = size;
    img.style.imageRendering = 'pixelated';
    img.alt = 'QR code: ' + text;
    // Use the qrserver.com open API (no key, no tracking, HTTPS)
    img.src = 'https://api.qrserver.com/v1/create-qr-code/?size='
      + size + 'x' + size
      + '&data=' + encodeURIComponent(text)
      + '&margin=1&format=png';
    container.appendChild(img);
  }

  // ---- Slide transitions ----
  var TR_CLASSES = ['tr-slide-up', 'tr-slide-left', 'tr-zoom'];
  function pickTransition(el) {
    TR_CLASSES.forEach(function(c) { el.classList.remove(c); });
    var pick = TR_CLASSES[Math.floor(Math.random() * TR_CLASSES.length)];
    el.classList.add(pick);
  }

  // ---- Slide rendering ----
  function renderSlide(index) {
    if (!presentation || index < 0 || index >= presentation.slides.length) return;

    var slide = presentation.slides[index];
    currentSlide = index;

    // Pick random transition and fade out
    pickTransition(els.slideTextContent);
    els.slideTextContent.classList.add('fading');
    els.slideQuoteContainer.classList.remove('visible');
    els.chartContainer.classList.remove('visible');
    els.audienceOverlay.classList.remove('visible');

    // Title-slide layout toggle
    if (index === 0) {
      els.slideTextContent.classList.add('is-title-slide');
    } else {
      els.slideTextContent.classList.remove('is-title-slide');
    }

    // Load background
    var bg = els.slideBg;
    bg.classList.remove('loaded');
    var newImg = new Image();
    newImg.onload = function() {
      bg.src = slide.imageUrl;
      requestAnimationFrame(function() { bg.classList.add('loaded'); });
    };
    newImg.onerror = function() {
      bg.src = '';
      bg.classList.add('loaded');
    };
    newImg.src = slide.imageUrl;

    // Update text after brief fade
    setTimeout(function() {
      els.slideTitle.textContent = slide.title;
      els.slideSubtitle.textContent = slide.subtitle || '';
      els.slideSubtitle.style.display = slide.subtitle ? 'block' : 'none';

      // Show presenter name on title slide only
      if (index === 0 && presenterName) {
        els.slidePresenter.textContent = presenterName;
        els.slidePresenter.style.display = 'block';
      } else {
        els.slidePresenter.style.display = 'none';
      }

      // Quote
      var rawQuote = (slide.quote || '').trim();
      if (rawQuote) {
        var dashMatch = rawQuote.match(/^([\s\S]+?)\s*(?:--|—|–)\s*([\s\S]+)$/);
        if (dashMatch) {
          els.slideQuoteText.textContent = dashMatch[1].replace(/^["'\u201C]+|["'\u201D]+$/g, '').trim();
          els.slideQuoteAttr.textContent = '\u2014 ' + dashMatch[2].trim();
        } else {
          els.slideQuoteText.textContent = rawQuote;
          els.slideQuoteAttr.textContent = '';
        }
        var contribKey = getContributorKey(rawQuote);
        els.slideQuoteInner.setAttribute('data-contributor', contribKey);
        els.slideQuoteContainer.classList.add('visible');
      }

      // Chart
      if (slide.chartData && slide.chartData.length > 0) {
        var maxVal = Math.max.apply(null, slide.chartData.map(function(d) { return Math.abs(d.value); }));
        els.chartBars.innerHTML = slide.chartData.map(function(d) {
          var pct = maxVal > 0 ? (Math.abs(d.value) / maxVal * 100) : 10;
          return '<div class="chart-bar-group">'
            + '<span class="chart-value">' + d.value + '</span>'
            + '<div class="chart-bar" style="height:' + Math.max(pct, 4) + '%"></div>'
            + '<span class="chart-label">' + escHtml(d.label) + '</span>'
            + '</div>';
        }).join('');
        els.chartContainer.classList.add('visible');
      }

      // Audience participation
      if (slide.audience) {
        els.audienceText.textContent = slide.title;
        els.audienceOverlay.classList.add('visible');
      }

      els.slideCounter.textContent = (index + 1) + ' / ' + presentation.slides.length;
      els.slideProgress.style.width = ((index + 1) / presentation.slides.length * 100) + '%';
      els.notesText.textContent = slide.notes || '';
      els.slideTextContent.classList.remove('fading');
    }, 200);
  }

  function nextSlide() {
    if (!presentation) return;
    if (currentSlide < presentation.slides.length - 1) {
      renderSlide(currentSlide + 1);
    } else {
      els.finTitle.textContent = presentation.title;
      // QR code for share URL
      els.finQr.innerHTML = '';
      els.finShareHint.textContent = '';
      if (presentation.id) {
        var shareUrl = location.origin + '/p/' + presentation.id;
        els.finShareHint.textContent = shareUrl;
        try { renderQR(els.finQr, shareUrl, 160); } catch(e) { /* skip QR on error */ }
      }
      showView('fin');
    }
  }

  function prevSlide() {
    if (currentSlide > 0) renderSlide(currentSlide - 1);
  }

  function startPresentation() {
    showView('presentation');
    notesVisible = false;
    els.slideNotes.classList.remove('visible');
    renderSlide(0);
    var container = document.documentElement;
    if (container.requestFullscreen) {
      container.requestFullscreen().catch(function() {});
    }
  }

  function exitPresentation() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(function() {});
    }
    resetTimer();
    history.replaceState(null, '', '/');
    showView('landing');
    presentation = null;
    els.presenterInput.value = randomFakeName();
  }

  function toggleNotes() {
    notesVisible = !notesVisible;
    els.slideNotes.classList.toggle('visible', notesVisible);
  }

  // ---- Timer ----
  var timerVisible = false;
  var timerRunning = false;
  var timerSeconds = 0;
  var timerInterval = null;

  function formatTime(secs) {
    var m = Math.floor(secs / 60);
    var s = secs % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function updateTimerDisplay() {
    els.slideTimer.textContent = formatTime(timerSeconds);
    els.slideTimer.classList.remove('warning', 'danger');
    if (timerSeconds <= 30) els.slideTimer.classList.add('danger');
    else if (timerSeconds <= 60) els.slideTimer.classList.add('warning');
  }

  function startTimer(durationSeconds) {
    stopTimer();
    timerSeconds = durationSeconds;
    updateTimerDisplay();
    timerRunning = true;
    timerInterval = setInterval(function() {
      if (timerSeconds > 0) {
        timerSeconds--;
        updateTimerDisplay();
      } else {
        stopTimer();
        els.slideTimer.textContent = '0:00';
        els.slideTimer.classList.add('danger');
      }
    }, 1000);
  }

  function stopTimer() {
    timerRunning = false;
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  }

  function toggleTimer() {
    timerVisible = !timerVisible;
    els.slideTimer.classList.toggle('visible', timerVisible);
    if (timerVisible && !timerRunning) {
      startTimer(5 * 60);
    }
  }

  function resetTimer() {
    stopTimer();
    timerVisible = false;
    els.slideTimer.classList.remove('visible', 'warning', 'danger');
  }

  // ---- Difficulty selector ----
  document.querySelectorAll('.diff-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.diff-btn').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      selectedDifficulty = btn.getAttribute('data-diff') || 'medium';
    });
  });

  // ---- Event listeners ----
  els.form.addEventListener('submit', function(e) {
    e.preventDefault();
    var prompt = els.input.value.trim();
    if (prompt) {
      els.submitBtn.disabled = true;
      generate(prompt).finally(function() { els.submitBtn.disabled = false; });
    }
  });

  els.randomBtn.addEventListener('click', function() {
    // Immediately show a local fallback so the button feels instant
    els.input.value = TOPICS[Math.floor(Math.random() * TOPICS.length)];
    els.input.focus();
    els.randomBtn.disabled = true;
    els.randomBtn.textContent = '...';
    // Then try to get a better one from the AI
    fetch('/api/random-topic').then(function(r) { return r.json(); }).then(function(data) {
      if (data.topic) {
        els.input.value = data.topic;
      }
    }).catch(function() {}).finally(function() {
      els.randomBtn.disabled = false;
      els.randomBtn.textContent = 'Random';
    });
  });

  document.querySelectorAll('.suggestion').forEach(function(btn) {
    btn.addEventListener('click', function() {
      els.input.value = btn.textContent;
      els.input.focus();
    });
  });

  // ---- Instant Play ----
  els.instantBtn.addEventListener('click', function() {
    presenterName = (els.presenterInput.value || '').trim();
    els.instantBtn.disabled = true;
    showView('loading');
    els.loadingStatus.textContent = 'Grabbing a pre-made deck';
    fetch('/api/instant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ difficulty: selectedDifficulty }),
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.error) {
        // No pool decks — fall back to normal generate with random topic
        els.loadingStatus.textContent = 'No instant decks ready, generating fresh';
        var fallback = TOPICS[Math.floor(Math.random() * TOPICS.length)];
        return generate(fallback);
      }
      presentation = data;
      showReadyScreen();
    })
    .catch(function(err) {
      els.errorMsg.textContent = err.message || 'Failed to load instant deck.';
      showView('error');
    })
    .finally(function() {
      els.instantBtn.disabled = false;
    });
  });

  els.startBtn.addEventListener('click', startPresentation);

  els.copyBtn.addEventListener('click', function() {
    var link = els.shareUrl.textContent;
    navigator.clipboard.writeText(link).then(function() {
      els.copyBtn.textContent = 'Copied!';
      setTimeout(function() { els.copyBtn.textContent = 'Copy Link'; }, 1500);
    });
  });

  els.newBtn.addEventListener('click', function() {
    history.replaceState(null, '', '/');
    showView('landing');
  });
  els.retryBtn.addEventListener('click', function() {
    history.replaceState(null, '', '/');
    showView('landing');
  });

  // Touch navigation for presentation
  (function() {
    var touchStartX = 0;
    var container = document.getElementById('slide-container');
    container.addEventListener('touchstart', function(e) {
      touchStartX = e.touches[0].clientX;
    }, { passive: true });
    container.addEventListener('touchend', function(e) {
      var diff = e.changedTouches[0].clientX - touchStartX;
      if (Math.abs(diff) > 60) {
        if (diff < 0) nextSlide();
        else prevSlide();
      }
    }, { passive: true });
    container.addEventListener('click', function(e) {
      if (e.target.closest('.slide-notes-overlay')) return;
      var rect = container.getBoundingClientRect();
      var clickX = e.clientX - rect.left;
      if (clickX > rect.width * 0.5) nextSlide();
      else prevSlide();
    });
  })();

  // Keyboard navigation
  document.addEventListener('keydown', function(e) {
    var activeView = null;
    Object.entries(views).forEach(function(entry) {
      if (entry[1].classList.contains('active')) activeView = entry[0];
    });

    if (activeView === 'presentation') {
      switch (e.key) {
        case 'ArrowRight': case ' ': case 'PageDown':
          e.preventDefault(); nextSlide(); break;
        case 'ArrowLeft': case 'PageUp':
          e.preventDefault(); prevSlide(); break;
        case 'Escape':
          e.preventDefault(); exitPresentation(); break;
        case 'n': case 'N':
          e.preventDefault(); toggleNotes(); break;
        case 't': case 'T':
          e.preventDefault(); toggleTimer(); break;
      }
    } else if (activeView === 'ready') {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); startPresentation(); }
      else if (e.key === 'Escape') { e.preventDefault(); history.replaceState(null, '', '/'); showView('landing'); }
    } else if (activeView === 'fin') {
      if (e.key === 'Escape' || e.key === ' ' || e.key === 'Enter') { e.preventDefault(); history.replaceState(null, '', '/'); showView('landing'); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); showView('presentation'); renderSlide(presentation.slides.length - 1); }
    }
  });

  // ---- Boot: check for /p/:id deep link, otherwise show landing ----
  (function boot() {
    els.presenterInput.value = randomFakeName();
    var match = location.pathname.match(/^\\/p\\/([a-z0-9]+)$/);
    if (match) {
      loadDeck(match[1]);
    } else {
      loadRecent();
      els.input.focus();
    }
  })();
})();
</script>
</body>
</html>`;

// ================================================================
// RATE LIMITING
// ================================================================

const RATE_LIMIT_GENERATE = { maxRequests: 10, windowSeconds: 300 }; // 10 per 5 min
const RATE_LIMIT_RANDOM   = { maxRequests: 30, windowSeconds: 60 };  // 30 per min

function getClientIP(request: Request): string {
  return request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
    || 'unknown';
}

async function checkRateLimit(
  kv: KVNamespace,
  key: string,
  limit: { maxRequests: number; windowSeconds: number },
): Promise<{ allowed: boolean; remaining: number }> {
  const now = Math.floor(Date.now() / 1000);
  const kvKey = `rl:${key}`;

  const raw = await kv.get(kvKey);
  let timestamps: number[] = raw ? JSON.parse(raw) : [];

  // Drop entries outside the window
  const cutoff = now - limit.windowSeconds;
  timestamps = timestamps.filter(t => t > cutoff);

  if (timestamps.length >= limit.maxRequests) {
    return { allowed: false, remaining: 0 };
  }

  timestamps.push(now);
  await kv.put(kvKey, JSON.stringify(timestamps), { expirationTtl: limit.windowSeconds + 10 });
  return { allowed: true, remaining: limit.maxRequests - timestamps.length };
}

// ================================================================
// REQUEST HANDLER
// ================================================================

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Serve the landing page (and saved-deck viewer — same SPA, JS reads the path)
    if (url.pathname === '/' || url.pathname.startsWith('/p/')) {
      return new Response(HTML, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
        },
      });
    }

    // API: generate presentation
    if (url.pathname === '/api/generate' && request.method === 'POST') {
      try {
        // Rate limit
        const ip = getClientIP(request);
        const rl = await checkRateLimit(env.DECKS, `gen:${ip}`, RATE_LIMIT_GENERATE);
        if (!rl.allowed) {
          return Response.json(
            { error: 'Slow down! Too many presentations generated. Try again in a few minutes.' },
            { status: 429, headers: { 'Retry-After': String(RATE_LIMIT_GENERATE.windowSeconds) } }
          );
        }

        const body = await request.json() as { prompt?: string; difficulty?: string };
        const prompt = body.prompt?.trim();
        const difficulty: Difficulty = (body.difficulty === 'easy' || body.difficulty === 'hard') ? body.difficulty : 'medium';

        if (!prompt) {
          return Response.json(
            { error: 'Please provide a topic for your presentation.' },
            { status: 400 }
          );
        }

        if (prompt.length > 200) {
          return Response.json(
            { error: 'Topic is too long. Keep it under 200 characters.' },
            { status: 400 }
          );
        }

        // Content moderation
        const modResult = await moderatePrompt(env, prompt);
        if (!modResult.safe) {
          return Response.json(
            { error: modResult.reason || 'That topic is not appropriate for this game.' },
            { status: 400 }
          );
        }

        const presentation = await generatePresentation(env, prompt, difficulty);

        // Save to KV and return the stored version (includes id)
        const stored = await saveDeck(env, prompt, presentation);
        return Response.json(stored);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error('Generation error:', message);
        if (error instanceof Error && error.stack) {
          console.error('Stack:', error.stack);
        }
        return Response.json(
          { error: message || 'Failed to generate presentation. Please try again.' },
          { status: 500 }
        );
      }
    }

    // API: get a saved presentation by id
    if (url.pathname.startsWith('/api/deck/') && request.method === 'GET') {
      const id = url.pathname.slice('/api/deck/'.length);
      if (!id) return Response.json({ error: 'Missing deck id' }, { status: 400 });
      const deck = await getDeck(env, id);
      if (!deck) return Response.json({ error: 'Deck not found' }, { status: 404 });
      return Response.json(deck);
    }

    // API: list recent presentations
    if (url.pathname === '/api/recent' && request.method === 'GET') {
      const recent = await getRecent(env);
      return Response.json(recent);
    }

    // API: generate a random topic via AI
    if (url.pathname === '/api/random-topic' && request.method === 'GET') {
      try {
        // Rate limit
        const ip = getClientIP(request);
        const rl = await checkRateLimit(env.DECKS, `rnd:${ip}`, RATE_LIMIT_RANDOM);
        if (!rl.allowed) {
          // Silent fallback to local list instead of error — better UX for a button mash
          const fallbacks = [
            'Quarterly sales report', 'Introduction to Node.js',
            'Cloud migration strategy', 'Team building workshop',
          ];
          return Response.json({ topic: fallbacks[Math.floor(Math.random() * fallbacks.length)] });
        }

        // Random category and seed words to steer the model away from repetition
        const categories = [
          'corporate strategy meeting', 'engineering all-hands', 'HR workshop',
          'product launch event', 'investor pitch', 'government committee briefing',
          'academic conference paper', 'TED-style talk', 'company retreat activity',
          'board of directors quarterly review', 'internal training session',
          'industry analyst briefing', 'startup demo day', 'safety compliance seminar',
          'procurement review', 'municipal planning committee', 'research symposium',
          'customer advisory board', 'standards body working group', 'trade show panel',
        ];
        const flavors = [
          'about an extremely specific niche topic',
          'that sounds important but is about something trivial',
          'that combines two unrelated fields',
          'that sounds like a self-help book title',
          'about an everyday object treated with extreme seriousness',
          'that a middle manager would propose with total confidence',
          'that sounds like it was auto-generated from buzzwords',
          'about a mundane process described with military precision',
          'that nobody asked for but someone approved a budget for',
          'that sounds like the title of a PhD thesis on something absurd',
        ];
        const category = categories[Math.floor(Math.random() * categories.length)];
        const flavor = flavors[Math.floor(Math.random() * flavors.length)];
        const seedWords = pickRandom(CHAOS_NOUNS, 2).join(', ');

        const aiResponse = await env.AI.run(
          '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
          {
            messages: [
              {
                role: 'system',
                content: `You output a single presentation title, 3-8 words. Nothing else — no quotes, no explanation, no punctuation except what's in the title. Just the title text.`,
              },
              {
                role: 'user',
                content: `Invent one presentation topic for a ${category} ${flavor}. It should sound plausibly real but be oddly specific or subtly absurd. Inspired by (but not directly using): ${seedWords}. Just the title, nothing else.`,
              },
            ],
            max_tokens: 30,
            temperature: 1.0,
          }
        );
        const topic = extractAIText(aiResponse)
          .replace(/^["'*\s]+|["'*\s.]+$/g, '')
          .replace(/^(Title|Topic|Here|Sure)[:\s]*/i, '')
          .trim();
        if (!topic || topic.length < 5) throw new Error('Empty response');
        return Response.json({ topic });
      } catch {
        const fallbacks = [
          'Quarterly sales report', 'Introduction to Node.js',
          'Cloud migration strategy', 'Team building workshop',
          'Budget planning 2027', 'Microservices architecture',
          'Workplace wellness initiative', 'Data center migration',
          'Cross-functional synergy framework', 'Container orchestration patterns',
        ];
        return Response.json({ topic: fallbacks[Math.floor(Math.random() * fallbacks.length)] });
      }
    }

    // API: instant play — pop a pre-generated deck from the pool
    if (url.pathname === '/api/instant' && request.method === 'POST') {
      try {
        const ip = getClientIP(request);
        const rl = await checkRateLimit(env.DECKS, `gen:${ip}`, RATE_LIMIT_GENERATE);
        if (!rl.allowed) {
          return Response.json(
            { error: 'Slow down! Try again in a few minutes.' },
            { status: 429, headers: { 'Retry-After': String(RATE_LIMIT_GENERATE.windowSeconds) } }
          );
        }

        const body = await request.json() as { difficulty?: string };
        const difficulty: Difficulty = (body.difficulty === 'easy' || body.difficulty === 'hard') ? body.difficulty : 'medium';
        const deck = await popFromPool(env, difficulty);
        if (!deck) {
          return Response.json({ error: 'No instant decks available. Use the normal generate button instead!' }, { status: 404 });
        }
        return Response.json(deck);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return Response.json({ error: message }, { status: 500 });
      }
    }

    // API: pool status (for debugging)
    if (url.pathname === '/api/pool-status' && request.method === 'GET') {
      const easy = await getPoolIds(env, 'easy');
      const medium = await getPoolIds(env, 'medium');
      return Response.json({ easy: easy.length, medium: medium.length, target: POOL_TARGET_SIZE });
    }

    return new Response('Not found', { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    console.log('Scheduled: refilling pre-generation pool');
    await refillPool(env);
  },
};
