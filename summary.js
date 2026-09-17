// Competitor summary
//
// Builds a written competitive brief from data we already hold, with no language
// model involved:
//
//   * Data Dive's own analysis of the niche (opportunity ratings, benchmark
//     medians, competitor-strength mix) — it has already done this maths.
//   * Per-competitor metrics from the same response (price, rating, reviews,
//     sales, revenue, listing age, page-1 share, ad coverage).
//   * The creative audit that only this plugin can do: how many listing images
//     each ASIN has, and whether it runs A+ content and Brand Story.
//
// Deterministic on purpose. Every number below is one Data Dive returned or one
// we counted ourselves, so the brief can be pasted into a doc without anyone
// having to check whether a model made it up.

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function num(v) {
  if (v && typeof v === 'object') v = 'value' in v ? v.value : null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function median(values) {
  const xs = values.filter((v) => v !== null && v !== undefined).sort((a, b) => a - b)
  if (xs.length === 0) return null
  const mid = Math.floor(xs.length / 2)
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2
}

function money(v, marketplace) {
  if (v === null || v === undefined) return '—'
  const symbol = { com: '$', ca: 'C$', 'co.uk': '£', de: '€', fr: '€', es: '€', it: '€', 'com.mx': 'MX$', in: '₹', 'co.jp': '¥' }[marketplace] || '$'
  return symbol + Math.round(v).toLocaleString('en-US')
}

function pct(v) {
  return v === null || v === undefined ? '—' : `${Math.round(v)}%`
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many || one + 's'}`
}

// Data Dive rates several fields with an opportunity/strength enum. Render them
// as words rather than leaking the raw SCREAMING_CASE into the brief.
function humanise(value) {
  if (!value) return null
  return String(value).toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

function extractAsin(input) {
  const s = String(input || '').trim().toUpperCase()
  const m = s.match(/\b(B0[A-Z0-9]{8}|[0-9]{9}[0-9X])\b/)
  return m ? m[1] : null
}

// ---------------------------------------------------------------------------
// Creative audit — the part Data Dive cannot tell us
// ---------------------------------------------------------------------------

// `scraped` is the array /api/niche/assets returns. Anything missing simply
// leaves the creative section out rather than guessing at zeroes, because "we
// did not scrape it" and "the competitor has none" are very different claims.
function auditCreative(scraped) {
  const byAsin = new Map()
  for (const row of scraped || []) {
    if (!row || !row.asin || row.error) continue
    byAsin.set(String(row.asin).toUpperCase(), {
      images: (row.listing || []).length,
      aplusDesktop: (row.aplusDesktop || []).length,
      aplusMobile: (row.aplusMobile || []).length,
      brandStory: (row.brandStory || []).length,
      hasAplus: (row.aplusDesktop || []).length > 0 || (row.aplusMobile || []).length > 0,
      hasBrandStory: (row.brandStory || []).length > 0,
    })
  }
  return byAsin
}

// ---------------------------------------------------------------------------
// Brief
// ---------------------------------------------------------------------------

function buildSummary({ niche, scraped, focusAsin }) {
  const marketplace = niche.marketplace || 'com'
  const competitors = niche.competitors || []
  const creative = auditCreative(scraped)
  const focus = extractAsin(focusAsin)

  const prices = competitors.map((c) => num(c.price))
  const ratings = competitors.map((c) => num(c.rating))
  const reviews = competitors.map((c) => num(c.reviewCount))
  const revenues = competitors.map((c) => num(c.revenue))

  const medians = {
    price: median(prices),
    rating: median(ratings),
    reviewCount: median(reviews),
    revenue: median(revenues),
    images: median(Array.from(creative.values()).map((c) => c.images)),
  }

  const audited = Array.from(creative.values())
  const creativeStats = audited.length ? {
    audited: audited.length,
    withAplus: audited.filter((c) => c.hasAplus).length,
    withBrandStory: audited.filter((c) => c.hasBrandStory).length,
    medianImages: medians.images,
  } : null

  // --- findings: plain rules over real numbers, each one checkable ----------
  const findings = []

  if (creativeStats) {
    const noAplus = creativeStats.audited - creativeStats.withAplus
    if (noAplus > 0) {
      findings.push(`${plural(noAplus, 'competitor')} of ${creativeStats.audited} run no A+ content at all — the cheapest visual advantage available here.`)
    }
    const noStory = creativeStats.audited - creativeStats.withBrandStory
    if (noStory > 0) {
      findings.push(`${plural(noStory, 'competitor')} of ${creativeStats.audited} have no Brand Story module.`)
    }
    if (medians.images !== null && medians.images < 7) {
      findings.push(`Median gallery is only ${medians.images} images — Amazon allows 7 plus video, so there is headroom to out-shoot the category.`)
    }
    const thin = Array.from(creative.entries()).filter(([, c]) => c.images > 0 && c.images <= 4).map(([a]) => a)
    if (thin.length) {
      findings.push(`Thin galleries (4 images or fewer): ${thin.join(', ')}.`)
    }
  }

  const opp = niche.opportunityEvaluation || {}
  const medianReviews = num(opp.medianReviewCount)
  if (medianReviews !== null) {
    if (medianReviews < 200) findings.push(`Median competitor has only ${Math.round(medianReviews)} reviews — review moat is shallow.`)
    else if (medianReviews > 2000) findings.push(`Median competitor holds ${Math.round(medianReviews).toLocaleString('en-US')} reviews — expect a slow climb on social proof.`)
  }

  const strength = niche.competitorsStrength && niche.competitorsStrength.searchVolume
  if (strength) {
    const weak = (num(strength.weakCompetitor && strength.weakCompetitor.percentage) || 0)
      + (num(strength.veryWeakCompetitor && strength.veryWeakCompetitor.percentage) || 0)
    if (weak > 0) findings.push(`${pct(weak)} of search volume is held by weak or very weak competitors.`)
  }

  if (medians.rating !== null && medians.rating < 4.3) {
    findings.push(`Median rating is ${medians.rating.toFixed(1)} — customers are not satisfied, so reviews will name the product gaps to fix.`)
  }

  // --- focus ASIN comparison ------------------------------------------------
  let focusBlock = null
  if (focus) {
    const row = competitors.find((c) => c.asin === focus)
    const cre = creative.get(focus)
    if (row || cre) {
      const points = []
      const price = row ? num(row.price) : null
      if (price !== null && medians.price !== null) {
        const delta = Math.round(((price - medians.price) / medians.price) * 100)
        points.push(`Priced at ${money(price, marketplace)} — ${delta === 0 ? 'level with' : `${Math.abs(delta)}% ${delta > 0 ? 'above' : 'below'}`} the ${money(medians.price, marketplace)} median.`)
      }
      const rating = row ? num(row.rating) : null
      if (rating !== null) points.push(`Rated ${rating.toFixed(1)}${medians.rating !== null ? ` against a ${medians.rating.toFixed(1)} median` : ''}.`)
      const rev = row ? num(row.reviewCount) : null
      if (rev !== null) points.push(`${Math.round(rev).toLocaleString('en-US')} reviews.`)
      if (cre) {
        points.push(`${plural(cre.images, 'listing image')}, A+ ${cre.hasAplus ? 'present' : 'absent'}, Brand Story ${cre.hasBrandStory ? 'present' : 'absent'}.`)
        if (medians.images !== null && cre.images < medians.images) {
          points.push(`Gallery is below the ${medians.images}-image median — add ${medians.images - cre.images} more to reach parity.`)
        }
      }
      focusBlock = { asin: focus, title: row ? row.title : '', brand: row ? row.brand : '', points }
    }
  }

  // --- per-competitor table -------------------------------------------------
  const table = competitors.map((c) => {
    const cre = creative.get(c.asin)
    return {
      asin: c.asin,
      brand: c.brand || '',
      title: c.title || '',
      price: num(c.price),
      rating: num(c.rating),
      reviewCount: num(c.reviewCount),
      revenue: num(c.revenue),
      images: cre ? cre.images : null,
      hasAplus: cre ? cre.hasAplus : null,
      hasBrandStory: cre ? cre.hasBrandStory : null,
      listingAge: humanise(c.listingAgeEvaluation),
    }
  })

  return {
    marketplace,
    competitorCount: competitors.length,
    medians,
    creativeStats,
    opportunity: {
      competitionStrength: humanise(opp.competitionSvStrength && opp.competitionSvStrength.opportunity),
      relevantKeywords: num(opp.numRelevantKeywords),
      medianReviewCount: medianReviews,
      medianDaysListed: num(opp.medianDaysListed),
    },
    findings,
    focus: focusBlock,
    competitors: table,
    markdown: renderMarkdown({ marketplace, niche, medians, creativeStats, opp, findings, focusBlock, table }),
  }
}

// ---------------------------------------------------------------------------
// Markdown rendering — what gets shown in the plugin and placed on the canvas
// ---------------------------------------------------------------------------

function renderMarkdown({ marketplace, niche, medians, creativeStats, opp, findings, focusBlock, table }) {
  const L = []
  L.push('# Competitor summary')
  L.push('')
  L.push(`${table.length} competitors on amazon.${marketplace}${niche.latestResearchDate ? ` · researched ${String(niche.latestResearchDate).slice(0, 10)}` : ''}`)
  L.push('')

  L.push('## The category at a glance')
  L.push(`- Median price: ${money(medians.price, marketplace)}`)
  L.push(`- Median rating: ${medians.rating !== null ? medians.rating.toFixed(1) : '—'}`)
  L.push(`- Median reviews: ${medians.reviewCount !== null ? Math.round(medians.reviewCount).toLocaleString('en-US') : '—'}`)
  if (medians.revenue !== null) L.push(`- Median monthly revenue: ${money(medians.revenue, marketplace)}`)
  const compStrength = humanise(opp.competitionSvStrength && opp.competitionSvStrength.opportunity)
  if (compStrength) L.push(`- Competition strength: ${compStrength}`)
  L.push('')

  if (creativeStats) {
    L.push('## Creative audit')
    L.push(`Based on ${plural(creativeStats.audited, 'listing')} actually scraped.`)
    L.push('')
    L.push(`- Median gallery size: ${creativeStats.medianImages !== null ? creativeStats.medianImages : '—'} images`)
    L.push(`- Running A+ content: ${creativeStats.withAplus} of ${creativeStats.audited}`)
    L.push(`- Running Brand Story: ${creativeStats.withBrandStory} of ${creativeStats.audited}`)
    L.push('')
  }

  if (findings.length) {
    L.push('## What this means')
    for (const f of findings) L.push(`- ${f}`)
    L.push('')
  }

  if (focusBlock) {
    L.push(`## Focus: ${focusBlock.asin}${focusBlock.brand ? ` (${focusBlock.brand})` : ''}`)
    if (focusBlock.title) L.push(`_${focusBlock.title}_`)
    L.push('')
    for (const p of focusBlock.points) L.push(`- ${p}`)
    L.push('')
  }

  L.push('## Competitors')
  L.push('')
  L.push('| ASIN | Brand | Price | Rating | Reviews | Images | A+ | Story |')
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const c of table) {
    L.push([
      '', c.asin, c.brand || '—',
      money(c.price, marketplace),
      c.rating !== null ? c.rating.toFixed(1) : '—',
      c.reviewCount !== null ? Math.round(c.reviewCount).toLocaleString('en-US') : '—',
      c.images === null ? '—' : c.images,
      c.hasAplus === null ? '—' : (c.hasAplus ? 'Yes' : 'No'),
      c.hasBrandStory === null ? '—' : (c.hasBrandStory ? 'Yes' : 'No'),
      '',
    ].join(' | ').trim())
  }

  return L.join('\n')
}

module.exports = { buildSummary, extractAsin }
