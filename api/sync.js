import { connect } from "framer-api"
import { google } from "googleapis"

const FRAMER_PROJECT_URL = "https://framer.com/projects/LAN-Main-Website--RTp7QUpJk29FQK4W6e5K-6CSFl"
const SHEET_ID           = process.env.GOOGLE_SHEET_ID
const COLLECTION_NAME    = "jobs"

const COL = {
  date: 0, slug: 1, jobId: 2, jobTitle: 3, companyName: 4,
  coreSkillSet: 5, ctcOffered: 6, workexRequired: 7, jdOrApplyLink: 8,
  location: 9, jobPosterName: 10, jobPosterContact: 11, posterEmail: 12,
  whatsappYesNo: 13, mailLink: 14, jobLocationType: 15, whatsappLink: 16,
  created: 18, edited: 19,
}

async function getSheetRows() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  })
  const sheets = google.sheets({ version: "v4", auth })
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Approved Jobs",
  })
  const [_header, ...rows] = res.data.values ?? []
  return rows
}

function rowToFieldData(row) {
  const get  = (i) => (row[i] ?? "").toString().trim()
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

function parseDate(raw) {
  if (!raw) return null
  const clean = raw.split(" ")[0]
  const [d, m, y] = clean.split("/")
  if (!d || !m || !y) return null
  return new Date(`${y}-${m.padStart(2,"0")}-${d.padStart(2,"0")}`).toISOString()
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" })

  if (req.headers["x-sync-secret"] !== process.env.SYNC_SECRET) {
    return res.status(401).json({ error: "Unauthorized" })
  }

  let framer
  try {
    console.log("⏳ Connecting to Framer...")
    framer = await Promise.race([
      connect(FRAMER_PROJECT_URL, process.env.FRAMER_API_KEY),
      new Promise((_, reject) => setTimeout(() => reject(new Error("connect() timeout")), 25000)),
    ])
    console.log("✅ Connected!")

    // Get existing slugs (just slugs, not full items — much faster)
    const collections = await framer.getCollections()
    const jobsCollection = collections.find((c) => c.name.toLowerCase() === COLLECTION_NAME)
    if (!jobsCollection) throw new Error(`Collection "${COLLECTION_NAME}" not found. Available: ${collections.map(c=>c.name).join(", ")}`)

    const existingItems = await jobsCollection.getItems()
    const existingSlugs = new Set(existingItems.map((item) => item.slug))
    console.log(`📋 ${existingSlugs.size} existing slugs loaded`)

    // Fetch sheet rows
    const rows = await getSheetRows()
    console.log(`📊 ${rows.length} sheet rows fetched`)

    // Only add NEW rows — skip existing ones entirely (much faster, avoids timeout)
    const itemsToAdd = []
    let skipped = 0

    for (const row of rows) {
      const slug  = (row[COL.slug]     ?? "").toString().trim()
      const title = (row[COL.jobTitle] ?? "").toString().trim()
      const jobId = (row[COL.jobId]    ?? "").toString().trim()
      if (!slug || !title) { skipped++; continue }
      if (existingSlugs.has(slug)) { skipped++; continue } // already in CMS
      itemsToAdd.push({ id: jobId || slug, slug, fieldData: rowToFieldData(row) })
    }

    console.log(`➕ ${itemsToAdd.length} new items to add, ${skipped} skipped`)

    if (itemsToAdd.length > 0) {
      await jobsCollection.addItems(itemsToAdd)
      console.log("✅ Items added!")

      // Only publish if there's something new
      const publishResult = await framer.publish()
      await framer.deploy(publishResult.deployment.id)
      console.log("🌍 Published and deployed!")

      return res.status(200).json({ ok: true, created: itemsToAdd.length, skipped, deployment: publishResult.deployment.id })
    }

    console.log("ℹ️ No new items — skipping publish")
    return res.status(200).json({ ok: true, created: 0, skipped, message: "No new items" })

  } catch (err) {
    console.error("❌ Error:", err?.message ?? String(err))
    return res.status(500).json({ error: err?.message ?? String(err) })
  } finally {
    if (framer) try { await framer.disconnect() } catch(e) {}
  }
}
