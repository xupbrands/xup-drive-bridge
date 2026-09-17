// Competitor insights
//
// Answers four questions about a set of competitor listings:
//
//   1. What the product actually is
//   2. Which features competitors choose to highlight
//   3. What buyers complain about
//   4. Who the buyers are (age / location)
//
// Questions 1-3 are answered from text we scrape: titles, bullets, A+ copy and
// reviews. The method is document frequency across competitors rather than raw
// word counts, so a phrase only ranks when SEVERAL sellers use it — that is what
// makes it a category theme rather than one brand's slogan.
//
// Question 4 is deliberately NOT answered with a number. Amazon publishes no
// buyer demographics and Data Dive's API exposes none, so any age or location
// figure here would be fabricated. What we can honestly report is the
// marketplace and whatever the listings themselves state, and we say plainly
// where the real data has to come from.

const STOPWORDS = new Set(`a about after all also am an and any are as at be been before being between both but by can cannot could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its itself just me more most my no nor not now of off on once only or other our out over own same she should so some such than that the their them then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours
amazon product products item items buy purchase order shipping delivery price great good best love perfect nice really very much well get got one two three use used using make makes made will can also just like need needs want time day days week weeks month months year years thing things little bit lot`.split(/\s+/))

// Words that rarely carry meaning in a feature phrase on their own.
const WEAK_TAIL = new Set(['and', 'or', 'the', 'a', 'an', 'of', 'to', 'for', 'with', 'in', 'on', 'is', 'are', 'be'])

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

// n-grams of 1..3 words, skipping anything that starts or ends on a stopword so
// fragments like "of the battery" never surface.
//
// Crucially the text is split on sentence and bullet boundaries first. Without
// that, the end of one bullet joins the start of the next and yields phantom
// phrases like "24 hours leak" — which also crowds out the real claim
// ("leak proof") by stealing its occurrences.
function phrases(text) {
  const segments = String(text || '')
    .split(/[.;:!?|\n\r]+|\s[-–—]\s/)
    .map((seg) => tokenize(seg))
    .filter((w) => w.length)

  const out = new Set()
  for (const words of segments) {
    for (let n = 1; n <= 3; n++) {
      for (let i = 0; i + n <= words.length; i++) {
        const gram = words.slice(i, i + n)
        if (STOPWORDS.has(gram[0]) || WEAK_TAIL.has(gram[gram.length - 1])) continue
        if (gram.some((w) => w.length < 3 && !/^\d+$/.test(w))) continue
        if (gram.every((w) => STOPWORDS.has(w))) continue
        if (n === 1 && (STOPWORDS.has(gram[0]) || gram[0].length < 4)) continue
        out.add(gram.join(' '))
      }
    }
  }
  return out
}

// Ranks phrases by how many DIFFERENT competitors use them. `minDocs` keeps
// one-off brand language out of a list that claims to describe the category.
function rankByDocumentFrequency(docs, { minDocs = 2, limit = 15, exclude = new Set() } = {}) {
  const counts = new Map()
  for (const doc of docs) {
    for (const phrase of phrases(doc.text)) {
      if (exclude.has(phrase)) continue
      if (!counts.has(phrase)) counts.set(phrase, new Set())
      counts.get(phrase).add(doc.id)
    }
  }

  const ranked = Array.from(counts.entries())
    .map(([phrase, ids]) => ({ phrase, docs: ids.size, words: phrase.split(' ').length }))
    .filter((r) => r.docs >= Math.min(minDocs, docs.length))
    // More competitors first; longer phrases win ties because they say more.
    .sort((a, b) => b.docs - a.docs || b.words - a.words || a.phrase.localeCompare(b.phrase))

  // Suppress near-duplicates. "started leaking", "leaking after" and "lid
  // started leaking" are one complaint, not four, so a phrase is dropped when a
  // phrase we already kept contains it (or is contained by it) and has at least
  // as much reach. Without this the list reads as noise and buries the long tail.
  const kept = []
  for (const r of ranked) {
    const redundant = kept.some((k) => (
      k.docs >= r.docs && (k.phrase.includes(r.phrase) || r.phrase.includes(k.phrase))
    ))
    if (!redundant) kept.push(r)
    if (kept.length >= limit) break
  }
  return kept
}

// Brand names and the odd model number would otherwise dominate every list.
function brandNoise(copies, competitors) {
  const noise = new Set()
  for (const c of competitors || []) {
    for (const w of tokenize(c.brand)) noise.add(w)
  }
  for (const c of copies || []) {
    for (const w of tokenize(c.asin)) noise.add(w)
  }
  return noise
}

function buildInsights({ copies, competitors, marketplace }) {
  const usable = (copies || []).filter((c) => c && !c.error)
  const noise = brandNoise(usable, competitors)

  // --- 1. What the product is ------------------------------------------------
  // Titles converge on the category noun; the bullets add what it does.
  const titleDocs = usable.map((c) => ({ id: c.asin, text: c.title }))
  const titleThemes = rankByDocumentFrequency(titleDocs, { minDocs: 2, limit: 8, exclude: noise })

  const productType = titleThemes.length
    ? titleThemes[0].phrase
    : null

  // --- 2. Features competitors highlight -------------------------------------
  const featureDocs = usable.map((c) => ({
    id: c.asin,
    text: [c.bullets.join(' . '), c.aplusText, c.description].filter(Boolean).join(' . '),
  }))
  const features = rankByDocumentFrequency(featureDocs, { minDocs: 2, limit: 15, exclude: noise })

  // --- 3. Pain points --------------------------------------------------------
  const criticalDocs = usable
    .filter((c) => c.reviews && c.reviews.critical && c.reviews.critical.length)
    .map((c) => ({ id: c.asin, text: c.reviews.critical.join(' . ') }))
  const painPoints = criticalDocs.length
    ? rankByDocumentFrequency(criticalDocs, { minDocs: 1, limit: 15, exclude: noise })
    : []

  const praiseDocs = usable
    .filter((c) => c.reviews && c.reviews.positive && c.reviews.positive.length)
    .map((c) => ({ id: c.asin, text: c.reviews.positive.join(' . ') }))
  const praise = praiseDocs.length
    ? rankByDocumentFrequency(praiseDocs, { minDocs: 1, limit: 10, exclude: noise })
    : []

  // --- 4. Audience -----------------------------------------------------------
  const audience = describeAudience({ usable, marketplace })

  return {
    analysed: usable.length,
    reviewsAnalysed: criticalDocs.length,
    productType,
    titleThemes,
    features,
    painPoints,
    praise,
    audience,
    markdown: render({ usable, productType, titleThemes, features, painPoints, praise, audience, marketplace }),
  }
}

// Reports only what is actually knowable, and names the source for the rest.
// Guessing an average age here would be indistinguishable from making it up.
function describeAudience({ usable, marketplace }) {
  const country = {
    com: 'United States', ca: 'Canada', 'co.uk': 'United Kingdom', de: 'Germany',
    fr: 'France', es: 'Spain', it: 'Italy', 'com.mx': 'Mexico', in: 'India', 'co.jp': 'Japan',
  }[marketplace] || `amazon.${marketplace}`

  // Listings sometimes state their intended audience outright; that is a claim
  // by the seller, not measured demographics, and is labelled as such.
  const statedFor = []
  for (const c of usable) {
    const text = [c.title, c.bullets.join(' ')].join(' ')
    for (const m of text.matchAll(/\b(?:for|ideal for|perfect for|designed for)\s+([a-z][a-z\s]{3,28}?)(?:[.,;)]|\band\b|$)/gi)) {
      const phrase = m[1].trim().toLowerCase()
      if (phrase.length > 3 && !STOPWORDS.has(phrase)) statedFor.push(phrase)
    }
  }
  const counts = new Map()
  for (const p of statedFor) counts.set(p, (counts.get(p) || 0) + 1)
  const topStated = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([phrase, n]) => ({ phrase, mentions: n }))

  return {
    marketplace,
    country,
    statedAudience: topStated,
    demographicsAvailable: false,
    note: 'Amazon does not publish buyer age or location, and Data Dive exposes none, so no figure is given here. Real demographics come from Brand Analytics (Amazon Customer Demographics) in Seller Central for your own ASINs, or a commissioned panel for competitors.',
  }
}

function render({ usable, productType, titleThemes, features, painPoints, praise, audience, marketplace }) {
  const L = []
  const cover = (r) => `${r.docs}/${usable.length}`

  L.push('# Competitor insights')
  L.push('')
  L.push(`Based on the listing copy of ${usable.length} competitor${usable.length === 1 ? '' : 's'} on amazon.${marketplace}.`)
  L.push('')

  L.push('## 1. What the product is')
  if (productType) {
    L.push(`Competitors describe this as **${productType}**.`)
    L.push('')
    L.push('Recurring wording in titles:')
    for (const t of titleThemes.slice(0, 6)) L.push(`- ${t.phrase} — used by ${cover(t)}`)
  } else {
    L.push('_Not enough overlapping title wording to name a category._')
  }
  L.push('')

  L.push('## 2. Features competitors highlight')
  if (features.length) {
    L.push('Ranked by how many competitors make the claim, so the top entries are')
    L.push('table stakes and the lower ones are differentiators.')
    L.push('')
    for (const f of features) L.push(`- **${f.phrase}** — ${cover(f)} competitors`)
  } else {
    L.push('_No feature language was shared across enough listings to rank._')
  }
  L.push('')

  L.push('## 3. Buyer pain points')
  if (painPoints.length) {
    L.push('From critical (1-2 star) reviews:')
    L.push('')
    for (const p of painPoints) L.push(`- ${p.phrase}`)
    if (praise.length) {
      L.push('')
      L.push('What positive reviews single out:')
      for (const p of praise.slice(0, 8)) L.push(`- ${p.phrase}`)
    }
  } else {
    L.push('_No reviews were collected. Tick "Include reviews" to scrape critical reviews — it costs one extra request per ASIN._')
  }
  L.push('')

  L.push('## 4. Buyer age and location')
  L.push(`Marketplace: **${audience.country}** — that is the only location signal that can be evidenced.`)
  L.push('')
  if (audience.statedAudience.length) {
    L.push('Audiences the listings themselves claim to target (seller copy, not measured data):')
    for (const a of audience.statedAudience) L.push(`- "${a.phrase}" — stated in ${a.mentions} listing${a.mentions === 1 ? '' : 's'}`)
    L.push('')
  }
  L.push(`> ${audience.note}`)

  return L.join('\n')
}

module.exports = { buildInsights }
