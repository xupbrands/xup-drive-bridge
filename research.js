// XUP Competitor Research
//
// Turns a Data Dive niche link into a set of competitor creative assets:
//
//   1. Data Dive API  -> the niche's shortlisted competitor ASINs (plus title,
//                        brand, price, rating and the thumbnail URLs Data Dive
//                        already holds).
//   2. Scrape.do      -> each ASIN's Amazon detail page, from which we pull the
//                        hi-res listing gallery, A+ content and Brand Story images.
//
// Both API keys live here (server-side) for the same reason the Google OAuth
// secret does: a Figma plugin UI is a sandboxed iframe with no safe place to hold
// a credential, and Figma's `networkAccess.allowedDomains` only lets the plugin
// talk to this service anyway.
//
// Required environment variables:
//   DATADIVE_API_KEY  - from https://2.datadive.tools/api-key
//   SCRAPEDO_API_KEY  - from https://scrape.do/ dashboard

const { DATADIVE_API_KEY, SCRAPEDO_API_KEY } = process.env

const DATADIVE_BASE = 'https://api.datadive.tools/v1'
const SCRAPEDO_BASE = 'https://api.scrape.do/'

// Data Dive marketplace codes are the Amazon TLD suffixes ("com", "co.uk", ...).
const DEFAULT_MARKETPLACE = 'com'

// How many Amazon detail pages we fetch at once. Scrape.do bills per request and
// caps concurrency per plan, so this stays deliberately low.
const SCRAPE_CONCURRENCY = 3

// ---------------------------------------------------------------------------
// Data Dive
// ---------------------------------------------------------------------------

async function datadive(path) {
  if (!DATADIVE_API_KEY) throw new Error('DATADIVE_API_KEY is not set on the server')

  const res = await fetch(`${DATADIVE_BASE}${path}`, {
    headers: { 'x-api-key': DATADIVE_API_KEY, Accept: 'application/json' },
  })
  const text = await res.text()

  let body = null
  try { body = JSON.parse(text) } catch (e) { body = null }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Data Dive rejected the API key (${res.status}). Check DATADIVE_API_KEY, and that your plan includes API access.`)
    }
    const detail = (body && (body.message || body.error)) || text.slice(0, 300)
    throw new Error(`Data Dive request failed (${res.status}): ${detail}`)
  }
  return body
}

// A niche link looks like https://2.datadive.tools/niches/<uuid>/... — but people
// paste all sorts of things (a bare id, a link with a #fragment, a link to a
// sub-tab). Pull the first UUID-shaped token out; if there isn't one, fall back
// to treating the input as a niche name and searching for it.
function extractNicheId(link) {
  const s = String(link || '').trim()
  if (!s) return null

  const uuid = s.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
  if (uuid) return uuid[0]

  // Data Dive share links use a short opaque code on a SINGULAR path segment
  // (https://2.datadive.tools/niche/FcvKzxddHF); other views use the plural
  // /niches/. Accept either, and ignore any trailing sub-route.
  const seg = s.match(/\/niches?\/([^/?#]+)/i)
  if (seg) return decodeURIComponent(seg[1])

  // A bare id pasted on its own (no slashes, no spaces).
  if (!/[\s/]/.test(s)) return s

  return null
}

// Pages the niche list so a code can be matched against every niche on the
// account, not just the first page.
async function listAllNiches(maxPages = 10) {
  const all = []
  for (let page = 1; page <= maxPages; page++) {
    const res = await datadive(`/niches?currentPage=${page}&pageSize=100`)
    const rows = (res && res.data) || []
    all.push(...rows)
    if (!res || !res.hasNext) break
  }
  return all
}

// Turns whatever was pasted into a nicheId the API will accept.
//
// The code in a share link is not guaranteed to be the API's internal nicheId,
// so a code that the competitors endpoint rejects is looked up against the
// account's niche list before giving up — matching on id, then on label, then
// on hero keyword.
async function resolveNiche(link) {
  const raw = String(link || '').trim()
  const direct = extractNicheId(raw)
  if (direct) return direct

  // Nothing id-shaped in there: treat the input as a name and search for it.
  const search = await datadive(`/niches?searchText=${encodeURIComponent(raw)}&pageSize=5`)
  const first = search && search.data && search.data[0]
  if (!first) {
    throw new Error(`No Data Dive niche matched "${link}". Paste the niche link from Data Dive instead.`)
  }
  return first.nicheId
}

// Second chance for a code the competitors endpoint didn't accept.
async function resolveNicheByLookup(code) {
  const needle = String(code || '').trim().toLowerCase()
  const niches = await listAllNiches()

  const match = niches.find((n) => String(n.nicheId || '').toLowerCase() === needle)
    || niches.find((n) => String(n.nicheLabel || '').toLowerCase() === needle)
    || niches.find((n) => String(n.heroKeyword || '').toLowerCase() === needle)
  if (match) return match.nicheId

  // Nothing matched — name a few real niches so the message is actionable
  // rather than just telling the user they were wrong.
  const sample = niches.slice(0, 5).map((n) => n.nicheLabel || n.heroKeyword).filter(Boolean)
  const hint = sample.length
    ? ` Niches on this account include: ${sample.join(', ')}.`
    : ' This Data Dive account has no niches.'
  throw new Error(`Data Dive has no niche "${code}".${hint} Open the niche in Data Dive and copy the link from the address bar.`)
}

// Several Data Dive fields arrive wrapped as { value, evaluation } rather than as
// a bare scalar; unwrap those so the plugin only ever sees plain values.
function unwrap(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if ('value' in v) return v.value
    if ('raw' in v) return v.raw
    return null
  }
  return v
}

// Data Dive returns the niche's competitor set — that IS the shortlist the niche
// was dived with, so it needs no extra ranking or filtering here.
async function getNicheCompetitors(link) {
  let nicheId = await resolveNiche(link)

  let res
  try {
    res = await datadive(`/niches/${encodeURIComponent(nicheId)}/competitors`)
  } catch (err) {
    // A 404 here usually means the code from the share link isn't the API's
    // internal nicheId. Look it up by name/id before surfacing the failure.
    if (!/\(404\)|\(400\)/.test(err.message)) throw err
    nicheId = await resolveNicheByLookup(nicheId)
    res = await datadive(`/niches/${encodeURIComponent(nicheId)}/competitors`)
  }

  // The endpoint is documented as returning one object, but the shared response
  // envelope types `data` as an array — accept either shape.
  const payload = res && res.data
  const result = Array.isArray(payload) ? payload[0] : payload
  if (!result) throw new Error('Data Dive returned no competitor data for that niche.')

  const competitors = (result.competitors || [])
    .filter((c) => c && c.asin)
    .map((c) => ({
      asin: String(c.asin).trim().toUpperCase(),
      title: unwrap(c.title) || '',
      brand: unwrap(c.brand) || '',
      price: unwrap(c.price),
      rating: unwrap(c.rating),
      reviewCount: unwrap(c.reviewCount),
      // Kept for the competitor summary. Data Dive has already computed all of
      // this, so a summary built from it needs no AI and cannot invent a number.
      bsr: unwrap(c.bsr),
      sales: unwrap(c.sales),
      revenue: unwrap(c.revenue),
      fulfillment: c.fulfillment || '',
      numberOfVariations: c.numberOfVariations,
      listingCreationDate: c.listingCreationDate,
      listingAgeEvaluation: c.listingCreationDateEvaluation || '',
      kwRankedOnP1Percent: c.kwRankedOnP1Percent,
      svRankedOnP1Percent: c.svRankedOnP1Percent,
      advertisedKwsPercent: c.advertisedKwsPercent,
      // `imageUrl` is documented as a semicolon-separated list of thumbnails.
      thumbnails: String(unwrap(c.imageUrl) || '').split(';').map((s) => s.trim()).filter(Boolean),
    }))

  return {
    nicheId,
    marketplace: result.marketplace || DEFAULT_MARKETPLACE,
    latestResearchDate: result.latestResearchDate,
    competitors,
    // Data Dive's own analysis of the niche. Previously discarded; the summary
    // is built from these rather than from a language model.
    statistics: result.statistics || null,
    opportunityEvaluation: result.opportunityEvaluation || null,
    benchmark: result.benchmark || null,
    competitorsStrength: result.competitorsStrength || null,
  }
}

// ---------------------------------------------------------------------------
// Scrape.do -> Amazon detail page
// ---------------------------------------------------------------------------

async function scrapeDo(targetUrl, options) {
  if (!SCRAPEDO_API_KEY) throw new Error('SCRAPEDO_API_KEY is not set on the server')
  const { render = false, geoCode = 'us', device = 'desktop' } = options || {}

  const params = new URLSearchParams({ token: SCRAPEDO_API_KEY, url: targetUrl, geoCode, device })
  // Residential/mobile proxies plus a headless render are only worth their extra
  // cost on the retry pass (see scrapeAsin), so they're opt-in per call.
  if (render) {
    params.set('render', 'true')
    params.set('super', 'true')
  }

  const res = await fetch(`${SCRAPEDO_BASE}?${params.toString()}`)
  const html = await res.text()
  if (!res.ok) throw new Error(`Scrape.do request failed (${res.status}): ${html.slice(0, 200)}`)
  return html
}

function amazonDetailUrl(marketplace, asin) {
  const tld = String(marketplace || DEFAULT_MARKETPLACE).replace(/^\.+/, '')
  return `https://www.amazon.${tld}/dp/${asin}?th=1&psc=1`
}

// Amazon serves most images through a size-modifier segment in the filename
// (".../71abc._SL1500_.jpg", ".../xyz._CR0,0,970,600_.jpg"). Stripping that
// modifier yields the original full-resolution asset.
function toFullSize(url) {
  return url.replace(/\._[^./]+_\.(jpg|jpeg|png|gif|webp)/i, '.$1')
}

function uniq(urls) {
  const seen = new Set()
  const out = []
  for (const u of urls) {
    const full = toFullSize(u)
    if (seen.has(full)) continue
    seen.add(full)
    out.push(full)
  }
  return out
}

// Walks forward from an opening bracket to its match, so a nested array can be
// cut out of Amazon's blob without parsing the whole thing. String literals are
// skipped, because image URLs legitimately contain brackets.
function sliceBracketedArray(text, openIndex) {
  let depth = 0
  let quote = null
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '[') depth++
    else if (ch === ']') {
      depth--
      if (depth === 0) return text.slice(openIndex, i + 1)
    }
  }
  return null
}

// Finds the array that follows a key, tolerating whatever Amazon wraps it in.
//
// The live page does NOT write `initial: [...]` — it writes
// `\'initial\': A.$.parseJSON(\'[{"hiRes":...}]\')`, so the opening bracket sits a
// short distance after the colon behind a function call and a quote. We scan
// ahead a little way for the first `[` rather than demanding it come next.
function findArrayAfter(html, keyRegex, windowSize = 80) {
  const m = html.match(keyRegex)
  if (!m) return null
  const from = m.index + m[0].length
  const open = html.indexOf('[', from)
  if (open === -1 || open - from > windowSize) return null
  return sliceBracketedArray(html, open)
}

// Cuts out the gallery belonging to the ASIN we asked for, and nothing else.
//
// A page with variations carries a gallery per variation. Two separate blobs are
// involved on a real listing:
//
//   1. `\'colorImages\': { \'initial\': A.$.parseJSON(\'[...]\') }`  <- the displayed ASIN
//   2. `"landingAsinColor":"64GB Black","colorImages":{"128GB (PRODUCT) RED":[...], ...}`
//
// Scanning the whole page pulls in (2) and returns every sibling ASIN\'s photos,
// which is exactly what we must avoid. So: prefer `initial`; failing that use
// `landingAsinColor` to pick the right key out of (2); failing that take the
// first gallery in (2). Only if none of that is present do we scan everything.
function extractMainGalleryBlock(html) {
  // 1. The displayed variant\'s own gallery.
  const initial = findArrayAfter(html, /["\']colorImages["\']\s*:\s*\{\s*["\']initial["\']\s*:/)
  if (initial) return initial

  // 2. Keyed by the variation that is actually on screen.
  //
  // Located by literal search rather than a regex: the galleries sitting between
  // `colorImages` and the wanted key contain braces and brackets of their own, so
  // no bounded character class can hop over them - and variation names routinely
  // contain regex metacharacters ("Black (PRODUCT) RED +1").
  const landing = html.match(/["']landingAsinColor["']\s*:\s*["']([^"']+)["']/)
  if (landing) {
    const colorImagesAt = html.search(/["']colorImages["']\s*:/)
    if (colorImagesAt !== -1) {
      for (const quote of ['"', "'"]) {
        const needle = quote + landing[1] + quote
        let at = html.indexOf(needle, colorImagesAt)
        while (at !== -1) {
          const after = at + needle.length
          if (/^\s*:/.test(html.slice(after, after + 8))) {
            const open = html.indexOf('[', after)
            if (open !== -1 && open - after <= 80) {
              const sliced = sliceBracketedArray(html, open)
              if (sliced) return sliced
            }
          }
          at = html.indexOf(needle, at + 1)
        }
      }
    }
  }

  // 3. First gallery in the variation map.
  const first = findArrayAfter(html, /["\']colorImages["\']\s*:\s*\{\s*["\'][^"\']+["\']\s*:/)
  if (first) return first

  return null
}

function extractListingImages(html) {
  // Scope to the displayed ASIN when we can find it; fall back to the whole page
  // only when no gallery blob is present at all, so a layout change degrades to
  // the old over-broad behaviour instead of returning nothing.
  const scope = extractMainGalleryBlock(html) || html

  const hiRes = Array.from(scope.matchAll(/["\']hiRes["\']\s*:\s*["\'](https:\/\/[^"\']+)["\']/g)).map((m) => m[1])
  if (hiRes.length) return uniq(hiRes)
  // Older or thin listings only expose "large".
  const large = Array.from(scope.matchAll(/["\']large["\']\s*:\s*["\'](https:\/\/[^"\']+)["\']/g)).map((m) => m[1])
  return uniq(large)
}

// A+ content (standard and Premium) and Brand Story are both served from the
// aplus-media CDN path, which cleanly separates them from gallery images and UI
// sprites. Brand Story lives in its own feature div, so we find that div and
// bucket each URL by whether it falls inside it.
const APLUS_URL_RE = /https:\/\/m\.media-amazon\.com\/images\/S\/aplus-media[^"'\\\s)]+\.(?:jpg|jpeg|png|gif|webp)/gi

// Finds a feature div by id. The id string ALSO appears in page-config JSON
// (`{"dtu":"aplusBrandStory_feature_div",...}`) several hundred KB before the
// real element, so matching the bare word picks the wrong spot entirely and the
// Brand Story region gets measured from nowhere near the content. Anchor on the
// attribute so only the real element matches.
function findFeatureDiv(html, id) {
  const m = html.match(new RegExp(`id=["']${id}["']`, 'i'))
  return m ? m.index : -1
}

// Buckets each A+ image by which feature div it sits under. Either block can come
// first in the document, so the markers are sorted and each URL is attributed to
// the nearest preceding one.
function extractAplusImages(html) {
  const markers = []
  const aplusAt = findFeatureDiv(html, 'aplus_feature_div')
  const storyAt = findFeatureDiv(html, 'aplusBrandStory_feature_div')
  if (aplusAt !== -1) markers.push({ at: aplusAt, bucket: 'aplus' })
  if (storyAt !== -1) markers.push({ at: storyAt, bucket: 'brandStory' })
  markers.sort((a, b) => a.at - b.at)

  const aplus = []
  const brandStory = []
  for (const m of html.matchAll(APLUS_URL_RE)) {
    let bucket = 'aplus'
    for (const marker of markers) {
      if (m.index >= marker.at) bucket = marker.bucket
      else break
    }
    if (bucket === 'brandStory') brandStory.push(m[0])
    else aplus.push(m[0])
  }
  return { aplus: uniq(aplus), brandStory: uniq(brandStory) }
}

// ---------------------------------------------------------------------------
// Keyword search -> the main image of the top N results
//
// This is a different question from the per-ASIN scrape above. There the input
// is a known competitor; here the input is a product name and the output is the
// first (main) gallery image of everything currently ranking for it, which is
// what a thumbnail-competitiveness review needs.
// ---------------------------------------------------------------------------

const SEARCH_RESULT_LIMIT = 50
// Amazon serves ~16-24 usable organic results per search page, so four pages
// comfortably covers 50 without scraping pages nobody asked for.
const SEARCH_MAX_PAGES = 4

function amazonSearchUrl(marketplace, query, page) {
  const tld = String(marketplace || DEFAULT_MARKETPLACE).replace(/^\.+/, '')
  const params = new URLSearchParams({ k: query })
  if (page > 1) params.set('page', String(page))
  return `https://www.amazon.${tld}/s?${params.toString()}`
}

// Sponsored placements are paid, not ranked, so they are not "the top 50" in any
// sense a competitive review cares about. Amazon labels them several ways
// depending on the layout served.
function isSponsoredBlock(block) {
  return /AdHolder|puis-sponsored-label|>\s*Sponsored\s*</i.test(block)
}

// Each result card carries its ASIN on the wrapper element, so the page is cut
// into one block per card and read independently. The card's thumbnail is the
// listing's main image, and its `alt` text is the full product title.
function extractSearchResults(html) {
  const anchors = []
  for (const m of String(html).matchAll(/data-asin=["']([A-Z0-9]{10})["']/gi)) {
    anchors.push({ asin: m[1].toUpperCase(), at: m.index })
  }

  const out = []
  const seen = new Set()
  for (let i = 0; i < anchors.length; i++) {
    const { asin, at } = anchors[i]
    if (seen.has(asin)) continue
    const end = i + 1 < anchors.length ? anchors[i + 1].at : html.length
    const block = html.slice(at, end)
    if (isSponsoredBlock(block)) continue

    const imgTag = block.match(/<img[^>]*class=["'][^"']*s-image[^"']*["'][^>]*>/i)
      || block.match(/<img[^>]*s-image[^>]*>/i)
    if (!imgTag) continue
    const src = imgTag[0].match(/\ssrc=["'](https:\/\/[^"']+)["']/i)
    if (!src) continue

    const alt = imgTag[0].match(/\salt=["']([^"']*)["']/i)
    seen.add(asin)
    out.push({
      asin,
      title: alt ? alt[1].trim() : '',
      // Search cards serve a downscaled thumbnail; stripping the size modifier
      // gives the same full-resolution asset the detail page uses.
      image: toFullSize(src[1]),
    })
  }
  return out
}

async function searchMainImages(marketplace, query, limit) {
  const term = String(query || '').trim()
  if (!term) throw new Error('Type a product name to search for')

  const cap = Math.min(Math.max(1, Number(limit) || SEARCH_RESULT_LIMIT), 100)
  const results = []
  const seen = new Set()

  for (let page = 1; page <= SEARCH_MAX_PAGES && results.length < cap; page++) {
    const url = amazonSearchUrl(marketplace, term, page)
    let items = extractSearchResults(await scrapeDo(url, { render: false }))
    // A blocked or bot-checked response has no cards at all; the rendered retry
    // usually clears it. A page that legitimately ran out of results stays empty
    // and ends the loop below.
    if (items.length === 0) items = extractSearchResults(await scrapeDo(url, { render: true }))
    if (items.length === 0) break

    for (const item of items) {
      if (results.length >= cap) break
      if (seen.has(item.asin)) continue
      seen.add(item.asin)
      results.push(Object.assign({ rank: results.length + 1 }, item))
    }
  }

  return { query: term, results }
}

// ---------------------------------------------------------------------------
// Listing copy — what the product is and what each competitor chooses to shout
// ---------------------------------------------------------------------------

function stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    // A <style> block whose closing tag falls outside our slice window would
    // otherwise dump raw CSS into the copy, where it gets ranked as "feature
    // language". Anything from an unterminated <style> onward is discarded.
    .replace(/<style[\s\S]*$/i, ' ')
    .replace(/<[^>]+>/g, ' ')
    // Belt and braces for CSS that arrived without a <style> wrapper: rule bodies
    // first, then the selector lists left behind.
    .replace(/\{[^{}]*\}/g, ' ')
    .replace(/[.#][A-Za-z_][\w-]*(?=\s*[,{.\s])/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}


// "About this item" — the five bullets are the clearest statement a seller makes
// about which features they think win the sale.
function extractBullets(html) {
  const at = html.search(/id=["']feature-bullets["']/)
  if (at === -1) return []
  // The block ends at the next major section; a generous slice is fine because we
  // only take <li> items out of it.
  const block = html.slice(at, at + 12000)
  const items = Array.from(block.matchAll(/<span[^>]*class=["'][^"']*a-list-item[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi))
    .map((m) => stripTags(m[1]))
    .filter((t) => t.length > 12 && t.length < 600)
  // Amazon repeats some bullets in hidden blocks.
  return Array.from(new Set(items)).slice(0, 12)
}

// Slices an element's CONTENT, starting after the opening tag closes. Slicing
// from the id= match instead would begin mid-tag, and the remaining attributes
// would survive stripTags as text ('class="celwidget" data-feature-name...').
function sliceElementText(html, idPattern, span) {
  const at = html.search(idPattern)
  if (at === -1) return ''
  const contentStart = html.indexOf('>', at)
  if (contentStart === -1) return ''
  return stripTags(html.slice(contentStart + 1, contentStart + 1 + span))
}

function extractDescription(html) {
  return sliceElementText(html, /id=["']productDescription["']/, 12000).slice(0, 2500)
}

// A+ modules carry the brand's own marketing copy — often richer than the
// bullets, and it is what the comparison imagery is built around.
function extractAplusText(html) {
  return sliceElementText(html, /id=["']aplus_feature_div["']/, 40000).slice(0, 4000)
}

// Reviews are NOT on the product page — Amazon serves them from their own URL,
// and that URL refuses plain requests. It needs the residential proxy, so this is
// a separate (chargeable) fetch and only happens when pain points are asked for.
function amazonReviewsUrl(marketplace, asin, critical) {
  const tld = String(marketplace || DEFAULT_MARKETPLACE).replace(/^\.+/, '')
  const filter = critical ? 'critical' : 'positive'
  return `https://www.amazon.${tld}/product-reviews/${asin}/?filterByStar=${filter}&reviewerType=all_reviews&pageNumber=1`
}

function extractReviews(html) {
  const bodies = Array.from(html.matchAll(/data-hook=["']review-body["'][^>]*>([\s\S]*?)<\/div>/gi))
    .map((m) => stripTags(m[1]))
    .filter((t) => t.length > 20)
  return Array.from(new Set(bodies)).slice(0, 25)
}

async function scrapeReviews(marketplace, asin) {
  const out = { critical: [], positive: [] }
  for (const critical of [true, false]) {
    try {
      // Reviews are gated behind bot protection, so go straight to the rendered
      // residential request rather than wasting a cheap attempt that will fail.
      const html = await scrapeDo(amazonReviewsUrl(marketplace, asin, critical), { render: true })
      const reviews = extractReviews(html)
      if (critical) out.critical = reviews
      else out.positive = reviews
    } catch (err) {
      console.error(`Reviews (${critical ? 'critical' : 'positive'}) failed for ${asin}:`, err.message)
    }
  }
  return out
}

function extractTitle(html) {
  const m = html.match(/<span[^>]+id="productTitle"[^>]*>([\s\S]*?)<\/span>/i)
  if (!m) return ''
  return m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
}

// The four things the plugin can ask for. Amazon serves desktop and mobile A+ as
// genuinely different pages with differently-cropped assets, so those are two
// separate fetches — which is why they're two separate checkboxes rather than one
// "A+" toggle that silently doubles the scrape cost.
const ASSET_KINDS = ['listing', 'aplusDesktop', 'aplusMobile', 'brandStory']

function normaliseKinds(kinds) {
  const wanted = Array.isArray(kinds) ? kinds.filter((k) => ASSET_KINDS.includes(k)) : []
  return wanted.length ? wanted : ['listing']
}

// One pass over a single rendering of the detail page. `device` picks which
// variant of A+ Amazon serves us.
// One pass over a single rendering of the detail page. `device` picks which
// variant of A+ Amazon serves us; `want` lists which of listing / aplus /
// brandStory this pass is expected to produce.
async function scrapePass(url, device, want) {
  const needed = want && want.length ? want : ['listing']
  const parse = (html) => ({
    html,
    listing: extractListingImages(html),
    ...extractAplusImages(html),
  })

  let out = parse(await scrapeDo(url, { render: false, device }))

  // A+ and Brand Story are routinely injected client-side — on many listings the
  // feature div is an empty placeholder in the initial HTML. So we retry whenever
  // ANY requested kind is missing, not only when the page came back completely
  // empty; otherwise a listing that yields gallery images but lazy-loads its
  // Brand Story would silently return none forever.
  const missing = needed.filter((k) => out[k].length === 0)
  if (missing.length > 0) {
    const retry = parse(await scrapeDo(url, { render: true, device }))
    // Keep whatever the render actually improved; never discard what we had.
    for (const key of ['listing', 'aplus', 'brandStory']) {
      if (retry[key].length > out[key].length) out[key] = retry[key]
    }
    if (retry.html) out.html = retry.html
  }

  return out
}

async function scrapeAsin(marketplace, asin, kinds) {
  const wanted = new Set(normaliseKinds(kinds))
  const url = amazonDetailUrl(marketplace, asin)
  const out = { asin, sourceUrl: url, scrapedTitle: '', listing: [], aplusDesktop: [], aplusMobile: [], brandStory: [] }

  // Listing gallery, desktop A+ and Brand Story all come off the desktop page, so
  // one fetch covers any combination of them.
  const desktopWant = []
  if (wanted.has('listing')) desktopWant.push('listing')
  if (wanted.has('aplusDesktop')) desktopWant.push('aplus')
  if (wanted.has('brandStory')) desktopWant.push('brandStory')

  if (desktopWant.length > 0) {
    const pass = await scrapePass(url, 'desktop', desktopWant)
    out.scrapedTitle = extractTitle(pass.html)
    if (wanted.has('listing')) out.listing = pass.listing
    if (wanted.has('aplusDesktop')) out.aplusDesktop = pass.aplus
    if (wanted.has('brandStory')) out.brandStory = pass.brandStory
  }

  // Mobile A+ needs its own fetch with a mobile device profile.
  if (wanted.has('aplusMobile')) {
    const mobileWant = ['aplus']
    if (wanted.has('brandStory') && out.brandStory.length === 0) mobileWant.push('brandStory')

    const pass = await scrapePass(url, 'mobile', mobileWant)
    if (!out.scrapedTitle) out.scrapedTitle = extractTitle(pass.html)
    out.aplusMobile = pass.aplus
    // If Brand Story was asked for but the desktop page didn't carry it, take the
    // mobile page's copy rather than returning nothing.
    if (wanted.has('brandStory') && out.brandStory.length === 0) out.brandStory = pass.brandStory
  }

  return out
}

// Small fixed-size worker pool — keeps us inside Scrape.do's concurrency cap
// without pulling in a dependency. A failing ASIN records its error rather than
// rejecting the whole batch, so one blocked listing can't lose the other nine.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      try {
        results[i] = await fn(items[i], i)
      } catch (err) {
        results[i] = { asin: items[i], error: err.message, listing: [], aplusDesktop: [], aplusMobile: [], brandStory: [] }
      }
    }
  })
  await Promise.all(workers)
  return results
}

async function scrapeAsins(marketplace, asins, kinds) {
  return mapWithConcurrency(asins, SCRAPE_CONCURRENCY, (asin) => scrapeAsin(marketplace, asin, kinds))
}

async function scrapeListingCopy(marketplace, asin, withReviews) {
  const url = amazonDetailUrl(marketplace, asin)
  // Copy lives in the initial HTML, so the cheap request is usually enough; a
  // rendered retry only happens when the bullets came back empty.
  let html = await scrapeDo(url, { render: false })
  let bullets = extractBullets(html)
  if (bullets.length === 0) {
    html = await scrapeDo(url, { render: true })
    bullets = extractBullets(html)
  }

  const copy = {
    asin,
    title: extractTitle(html),
    bullets,
    description: extractDescription(html),
    aplusText: extractAplusText(html),
    reviews: { critical: [], positive: [] },
  }
  if (withReviews) copy.reviews = await scrapeReviews(marketplace, asin)
  return copy
}

async function scrapeCopyForAsins(marketplace, asins, withReviews) {
  return mapWithConcurrency(asins, SCRAPE_CONCURRENCY, (asin) => scrapeListingCopy(marketplace, asin, withReviews))
}

module.exports = {
  getNicheCompetitors, scrapeAsins, scrapeCopyForAsins, searchMainImages,
  extractSearchResults, amazonSearchUrl, toFullSize, ASSET_KINDS, SEARCH_RESULT_LIMIT,
}
