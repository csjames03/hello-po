// Resort knowledge base: markdown files split into sections, searched with BM25.
//
// Each "## " heading in content/*.md is one passage. The agent retrieves the best few passages
// for the caller's question and gives only those to the LLM, which keeps the prompt small
// (Groq's free tier allows 8,000 tokens a minute) and the answers grounded.
import { readFileSync, readdirSync } from 'node:fs';

export interface Passage {
  id: string; // e.g. "policies#cancellation"
  title: string;
  text: string;
}

export interface SearchHit extends Passage {
  score: number;
}

const contentDir = new URL('../content/', import.meta.url);

/** Splits every markdown file into one passage per "## " section. */
export function loadPassages(): Passage[] {
  return readdirSync(contentDir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .flatMap((file) => {
      const doc = file.replace(/\.md$/, '');
      return readFileSync(new URL(file, contentDir), 'utf8')
        .split(/^## /m)
        .slice(1)
        .map((section) => {
          const [heading = '', ...body] = section.split('\n');
          const title = heading.trim();
          const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
          return { id: `${doc}#${slug}`, title, text: body.join(' ').replace(/\s+/g, ' ').trim() };
        });
    });
}

const stopwords = new Set(
  (
    'a an and are as at be by can could do does for from have how i if in is it its me my of ' +
    'on or our please so tell that the there this to up was we what when where which who will ' +
    'with you your would like want know about any get hi hello thanks thank time much many need'
  ).split(' '),
);

// Spoken questions use different words than the documents. Map common ones onto document terms.
const synonyms: Record<string, string[]> = {
  breakfast: ['breakfast', 'buffet'],
  food: ['restaurant', 'dishes'],
  eat: ['restaurant', 'dishes'],
  dinner: ['restaurant', 'dinner'],
  lunch: ['restaurant'],
  drinks: ['bar'],
  dog: ['pets'],
  dogs: ['pets'],
  cat: ['pets'],
  pet: ['pets'],
  massage: ['spa', 'massages'],
  swim: ['pool'],
  swimming: ['pool'],
  internet: ['wifi'],
  password: ['wifi'],
  airport: ['airport', 'transfer'],
  pickup: ['transfer', 'airport'],
  shuttle: ['transfer', 'van'],
  van: ['transfer'],
  car: ['parking'],
  park: ['parking'],
  cancel: ['cancellation'],
  cancelling: ['cancellation'],
  canceling: ['cancellation'],
  refund: ['refunds'],
  money: ['refunds', 'payment'],
  pay: ['payment'],
  gcash: ['payment', 'gcash'],
  card: ['payment', 'cards'],
  kids: ['children', 'kids'],
  child: ['children'],
  baby: ['cots', 'children'],
  crib: ['cots'],
  gym: ['gym'],
  workout: ['gym'],
  smoke: ['smoking'],
  doctor: ['medical', 'doctor'],
  sick: ['medical'],
  tour: ['tours', 'island'],
  tours: ['tours', 'island'],
  boat: ['tours', 'cruise'],
  snorkel: ['snorkel', 'snorkeling'],
  early: ['early'],
  late: ['late'],
  bags: ['luggage', 'bags'],
  luggage: ['luggage'],
  fee: ['fee'],
  tax: ['fee'],
  where: ['location'],
  located: ['location'],
  facilities: ['amenities'],
  facility: ['amenities'],
  offer: ['amenities'],
  weather: ['weather', 'season'],
  rain: ['rainy', 'weather'],
};

function tokenize(text: string): string[] {
  // "check in", "check-in" and "checkin" are the same thing; so are "wi-fi" and "wifi".
  const normalised = text
    .toLowerCase()
    .replace(/\bcheck[\s-]?(in|out)\b/g, 'check$1')
    .replace(/\bwi-?fi\b/g, 'wifi');
  return (
    (normalised.match(/[a-z0-9-]+/g) ?? [])
      .map((t) => t.replace(/^-+|-+$/g, ''))
      // Bare numbers ("12", "2") match unrelated hours and ages, so they are left out.
      .filter((t) => t.length > 1 && !stopwords.has(t) && !/^\d+$/.test(t))
  );
}

/** Light stemming so "rooms"/"room" and "towels"/"towel" match. */
const stem = (t: string) =>
  t.length > 4 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t;

export class KnowledgeBase {
  readonly passages: Passage[];
  private readonly docs: string[][];
  private readonly df = new Map<string, number>();
  private readonly avgLength: number;

  constructor(passages: Passage[] = loadPassages()) {
    this.passages = passages;
    // Titles count twice: a heading is the strongest signal of what a passage is about.
    this.docs = passages.map((p) => [...tokenize(`${p.title} ${p.title} ${p.text}`)].map(stem));
    for (const doc of this.docs)
      for (const term of new Set(doc)) {
        this.df.set(term, (this.df.get(term) ?? 0) + 1);
      }
    this.avgLength = this.docs.reduce((n, d) => n + d.length, 0) / Math.max(1, this.docs.length);
  }

  /** Top passages for a question, best first. Returns nothing if no passage is relevant. */
  search(query: string, limit = 3, minScore = 1.5): SearchHit[] {
    const terms = new Set(
      tokenize(query)
        .flatMap((t) => [t, ...(synonyms[t] ?? [])])
        .map(stem),
    );
    if (terms.size === 0) return [];
    const n = this.docs.length;
    const k1 = 1.4;
    const b = 0.75;
    return (
      this.docs
        .map((doc, i) => {
          let score = 0;
          for (const term of terms) {
            const tf = doc.filter((t) => t === term).length;
            if (tf === 0) continue;
            const df = this.df.get(term) ?? 0;
            const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
            score +=
              (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * doc.length) / this.avgLength));
          }
          return { ...this.passages[i]!, score };
        })
        .filter((h) => h.score >= minScore)
        .sort((a, b2) => b2.score - a.score)
        // Drop weak matches riding along with a strong one.
        .filter((h, _i, all) => h.score >= all[0]!.score * 0.35)
        .slice(0, limit)
    );
  }
}
