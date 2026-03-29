import { connect } from "framer-api"
import { google } from "googleapis"

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const FRAMER_PROJECT_URL = "https://framer.com/projects/LAN-Main-Website--RTp7QUpJk29FQK4W6e5K-6CSFl"
const SHEET_ID           = process.env.GOOGLE_SHEET_ID       // e.g. "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms"
const COLLECTION_NAME    = "jobs"                             // must match Framer CMS collection name exactly

// Column index map (0-based) — matches the screenshot column order
// Date, Slug, Job ID, Job Title, Company Name, Core Skill Set, CTC Offered,
// Workex Required, JD or Apply Link, Location, Job Poster Name, Job Poster Contact,
// Poster Email, WhatsApp (Yes/No), Mail Link, Job Location Type, WhatsApp Link,
// Job A..., Created, Edited
const COL = {
  date:             0,
  slug:             1,
  jobId:            2,
  jobTitle:         3,
  companyName:      4,
  coreSkillSet:     5,
  ctcOffered:       6,
  workexRequired:   7,
  jdOrApplyLink:    8,
  location:         9,
  jobPosterName:    10,
  jobPosterContact: 11,
  posterEmail:      12,
  whatsappYesNo:    13,
  mailLink:         14,
  jobLocationType:  15,
  whatsappLink:     16,
  // col 17 = "Job A..." (truncated) — skip for now
  created:          18,
  edited:           19,
}

// ─── HELPER: authenticate Google Sheets via service account ──────────────────
async function getSheetRows() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  })
  const sheets = google.sheets({ version: "v4", auth })
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Sheet1",   // adjust if your sheet tab has a different name
  })
  const [_header, ...rows] = res.data.values ?? []
  return rows
}

// ─── HELPER: map a sheet row → Framer CMS fieldData ──────────────────────────
// Per Framer API v3.0.0+, fieldData values must be typed objects: { type, value }
function rowToFieldData(row) {
  const get = (i) => (row[i] ?? "").toString().trim()

  const str  = (i) => ({ type: "string",  value: get(i) })
  const link = (i) => ({ type: "link",    value: get(i) })
  const bool = (i) => ({ type: "boolean", value: get(i).toLowerCase() === "yes" })
  const date = (i) => ({ type: "date",    value: parseDate(get(i)) })

  return {
    "job-title":          str(COL.jobTitle),
    "company-name":       str(COL.companyName),
    "core-skill-set":     str(COL.coreSkillSet),
    "ctc-offered":        str(COL.ctcOffered),
    "workex-required":    str(COL.workexRequired),
    "jd-or-apply-link":   link(COL.jdOrApplyLink),
    "location":           str(COL.location),
    "job-poster-name":    str(COL.jobPosterName),
    "job-poster-contact": str(COL.jobPosterContact),
    "poster-email":       str(COL.posterEmail),
    "mail-link":          link(COL.mailLink),
    "job-location-type":  str(COL.jobLocationType),
    "whatsapp-link":      link(COL.whatsappLink),
    "whatsapp":           bool(COL.whatsappYesNo),
    "date":               date(COL.date),
    "created":            date(COL.created),
    "edited":             date(COL.edited),
  }
}

// Converts "29/03/2026" or "29/03/2026..." → "2026-03-29T00:00:00.000Z"
function parseDate(raw) {
  if (!raw) return null
  const [d, m, y] = raw.split("/")
  if (!d || !m || !y) return null
  return new Date(`${y}-${m}-${d}`).toISOString()
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  // Simple shared-secret auth — Make.com sends this in the header
  const secret = req.headers["x-sync-secret"]
  if (secret !== process.env.SYNC_SECRET) {
    return res.status(401).json({ error: "Unauthorized" })
  }

  let framer
  try {
    console.log("⏳ Connecting to Framer...")
    framer = await connect(FRAMER_PROJECT_URL, process.env.FRAMER_API_KEY)

    // 1. Get all CMS collections and find the jobs one
    console.log("📂 Fetching CMS collections...")
    const collections = await framer.getCollections()
    const jobsCollection = collections.find(
      (c) => c.name.toLowerCase() === COLLECTION_NAME
    )
    if (!jobsCollection) {
      throw new Error(`Collection "${COLLECTION_NAME}" not found. Available: ${collections.map(c => c.name).join(", ")}`)
    }

    // 2. Get existing items so we can upsert (update or insert)
    console.log("📋 Fetching existing CMS items...")
    const existingItems = await jobsCollection.getItems()
    const existingBySlug = Object.fromEntries(
      existingItems.map((item) => [item.slug, item])
    )

    // 3. Fetch rows from Google Sheet
    console.log("📊 Fetching Google Sheet rows...")
    const rows = await getSheetRows()
    console.log(`   Found ${rows.length} rows`)

    // 4. Upsert each row into Framer CMS
    let created = 0, updated = 0, skipped = 0
    const itemsToAdd = []

    for (const row of rows) {
      const slug = (row[COL.slug] ?? "").toString().trim()
      const title = (row[COL.jobTitle] ?? "").toString().trim()
      const jobId = (row[COL.jobId] ?? "").toString().trim()

      if (!slug || !title) { skipped++; continue }

      const fieldData = rowToFieldData(row)

      if (existingBySlug[slug]) {
        // Update existing item — setAttributes() is the correct method per API docs
        await existingBySlug[slug].setAttributes({ fieldData })
        updated++
      } else {
        // Queue new item — id must be stable & unique; use jobId
        itemsToAdd.push({ id: jobId || slug, slug, fieldData })
        created++
      }
    }

    // Batch add new items
    if (itemsToAdd.length > 0) {
      await jobsCollection.addItems(itemsToAdd)
    }

    console.log(`✅ Sync done — ${created} created, ${updated} updated, ${skipped} skipped`)

    // 5. Publish to staging first
    console.log("🚀 Publishing...")
    const publishResult = await framer.publish()
    console.log(`   Preview: ${publishResult.hostnames?.[0] ?? "—"}`)

    // 6. Promote to production
    await framer.deploy(publishResult.deployment.id)
    console.log("🌍 Deployed to production!")

    return res.status(200).json({
      ok: true,
      created,
      updated,
      skipped,
      deployment: publishResult.deployment.id,
    })

  } catch (err) {
    console.error("❌ Sync failed:", err?.message ?? err)
    console.error("❌ Stack:", err?.stack ?? "no stack")
    return res.status(500).json({
      error: err?.message ?? String(err),
      stack: err?.stack ?? null
    })
  } finally {
    if (framer) {
      try { await framer.disconnect() } catch(e) { console.error("disconnect error:", e?.message) }
    }
  }
}
