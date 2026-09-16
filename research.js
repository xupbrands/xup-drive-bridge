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

  // Some niche URLs use a shorter opaque id segment after /niches/.
  const seg = s.match(/\/niches\/([^/?#]+)/i)
  if (seg) return decodeURIComponent(seg[1])

  // A bare id pasted on its own (no slashes, no spaces).
  if (!/[\s/]/.test(s)) return s

  return null
}

async function resolveNiche(link) {
  const direct = extractNicheId(link)
  if (direct) return direct

  // Treat the input as a niche label / hero keyword and look it up instead.
  const search = await datadive(`/niches?searchText=${encodeURIComponent(String(link).trim())}&pageSize=5`)
  const first = search && search.data && search.data[0]
  if (!first) throw new Error(`No Data Dive niche matched "${link}". Paste the niche link from Data Dive instead.`)
  return first.nicheId
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
  const nicheId = await resolveNiche(link)
  const res = await datadive(`/niches/${encodeURIComponent(nicheId)}/competitors`)

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
      // `imageUrl` is documented as a semicolon-separated list of thumbnails.
      thumbnails: String(unwrap(c.imageUrl) || '').split(';').map((s) => s.trim()).filter(Boolean),
    }))

  return {
    nicheId,
    marketplace: result.marketplace || DEFAULT_MARKETPLACE,
    latestResearchDate: result.latestResearchDate,
    competitors,
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

// The main image gallery is embedded as a JSON-ish blob in an inline script
// ("colorImages"), where each variant carries hiRes / large / thumb URLs. We read
// the URLs out with a regex rather than parsing, because Amazon's blob is a JS
// object literal and not reliably valid JSON.
function extractListingImages(html) {
  const hiRes = Array.from(html.matchAll(/"hiRes"\s*:\s*"(https:\/\/[^"]+)"/g)).map((m) => m[1])
  if (hiRes.length) return uniq(hiRes)
  // Older or thin listings only expose "large".
  const large = Array.from(html.matchAll(/"large"\s*:\s*"(https:\/\/[^"]+)"/g)).map((m) => m[1])
  return uniq(large)
}

// A+ content (standard and Premium) and Brand Story are both served from the
// aplus-media CDN path, which cleanly separates them from gallery images and UI
// sprites. Brand Story lives in its own feature div, so we find that div and
// bucket each URL by whether it falls inside it.
const APLUS_URL_RE = /https:\/\/m\.media-amazon\.com\/images\/S\/aplus-media[^"'\\\s)]+\.(?:jpg|jpeg|png|gif|webp)/gi

function extractAplusImages(html) {
  const storyStart = html.search(/aplusBrandStory_feature_div|aplus-brand-story/i)
  // The Brand Story block runs from its marker to the start of the next A+ block.
  let storyEnd = -1
  if (storyStart !== -1) {
    const rest = html.slice(storyStart + 1)
    const next = rest.search(/id="aplus_feature_div"|id="aplus"/i)
    storyEnd = next === -1 ? html.length : storyStart + 1 + next
  }

  const aplus = []
  const brandStory = []
  for (const m of html.matchAll(APLUS_URL_RE)) {
    if (storyStart !== -1 && m.index >= storyStart && m.index < storyEnd) brandStory.push(m[0])
    else aplus.push(m[0])
  }
  return { aplus: uniq(aplus), brandStory: uniq(brandStory) }
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
async function scrapePass(url, device) {
  let html = await scrapeDo(url, { render: false, device })
  let listing = extractListingImages(html)
  let aplus = extractAplusImages(html)

  // A+ modules are sometimes injected client-side, and a bot-check interstitial
  // yields no images at all. Either way one retry with a rendered residential
  // request is worth the extra credit — but only keep what it actually improved.
  if (listing.length === 0 || (aplus.aplus.length === 0 && aplus.brandStory.length === 0)) {
    html = await scrapeDo(url, { render: true, device })
    const retryListing = extractListingImages(html)
    const retryAplus = extractAplusImages(html)
    if (retryListing.length) listing = retryListing
    if (retryAplus.aplus.length || retryAplus.brandStory.length) aplus = retryAplus
  }

  return { html, listing, aplus: aplus.aplus, brandStory: aplus.brandStory }
}

async function scrapeAsin(marketplace, asin, kinds) {
  const wanted = new Set(normaliseKinds(kinds))
  const url = amazonDetailUrl(marketplace, asin)
  const out = { asin, sourceUrl: url, scrapedTitle: '', listing: [], aplusDesktop: [], aplusMobile: [], brandStory: [] }

  // Listing gallery, desktop A+ and Brand Story all come off the desktop page, so
  // one fetch covers any combination of them.
  const needsDesktop = wanted.has('listing') || wanted.has('aplusDesktop') || wanted.has('brandStory')
  if (needsDesktop) {
    const pass = await scrapePass(url, 'desktop')
    out.scrapedTitle = extractTitle(pass.html)
    if (wanted.has('listing')) out.listing = pass.listing
    if (wanted.has('aplusDesktop')) out.aplusDesktop = pass.aplus
    if (wanted.has('brandStory')) out.brandStory = pass.brandStory
  }

  // Mobile A+ needs its own fetch with a mobile device profile.
  if (wanted.has('aplusMobile')) {
    const pass = await scrapePass(url, 'mobile')
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

module.exports = { getNicheCompetitors, scrapeAsins, toFullSize, ASSET_KINDS }
