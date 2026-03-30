import "dotenv/config"
import { connect } from "framer-api"
import { google } from "googleapis"
import http from "http"

const FRAMER_PROJECT_URL = "https://framer.com/projects/LAN-Main-Website--RTp7QUpJk29FQK4W6e5K-6CSFl"
const SHEET_ID           = process.env.GOOGLE_SHEET_ID
const COLLECTION_NAME    = "jobs"
const PORT               = process.env.PORT || 3000

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
  try {
    const clean = raw.toString().split(" ")[0].trim()
    if (!clean) return null
    const parts = clean.split("/")
    if (parts.length !== 3) return null
    const [d, m, y] = parts
    if (!d || !m || !y || y.length < 4) return null
    const date = new Date(`${y}-${m.padStart(2,"0")}-${d.padStart(2,"0")}`)
    if (isNaN(date.getTime())) return null
    return date.toISOString()
  } catch(e) {
    return null
  }
}

function sendJSON(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(data))
}

async function handleSync(res) {
  let framer
  try {
    console.log("⏳ Connecting to Framer...")
    framer = await Promise.race([
      connect(FRAMER_PROJECT_URL, process.env.FRAMER_API_KEY),
      new Promise((_, reject) => setTimeout(() => reject(new Error("connect() timeout after 30s")), 30000)),
    ])
    console.log("✅ Connected!")

    const collections = await framer.getCollections()
    console.log(`📂 Collections: ${collections.map(c => c.name).join(", ")}`)

    const jobsCollection = collections.find((c) => c.name.toLowerCase() === COLLECTION_NAME)
    if (!jobsCollection) throw new Error(`Collection "${COLLECTION_NAME}" not found. Available: ${collections.map(c=>c.name).join(", ")}`)

    const existingItems = await jobsCollection.getItems()
    const existingSlugs = new Set(existingItems.map((item) => item.slug))
    console.log(`📋 ${existingSlugs.size} existing slugs`)

    const rows = await getSheetRows()
    console.log(`📊 ${rows.length} sheet rows`)

    const itemsToAdd = []
    let skipped = 0
    for (const row of rows) {
      const slug  = (row[COL.slug]     ?? "").toString().trim()
      const title = (row[COL.jobTitle] ?? "").toString().trim()
      const jobId = (row[COL.jobId]    ?? "").toString().trim()
      if (!slug || !title || existingSlugs.has(slug)) { skipped++; continue }
      itemsToAdd.push({ id: jobId || slug, slug, fieldData: rowToFieldData(row) })
    }

    console.log(`➕ ${itemsToAdd.length} new items, ${skipped} skipped`)

    if (itemsToAdd.length > 0) {
      await jobsCollection.addItems(itemsToAdd)
      const publishResult = await framer.publish()
      await framer.deploy(publishResult.deployment.id)
      console.log("🌍 Published and deployed!")
      return sendJSON(res, 200, { ok: true, created: itemsToAdd.length, skipped, deployment: publishResult.deployment.id })
    }

    console.log("ℹ️ No new items — skipping publish")
    return sendJSON(res, 200, { ok: true, created: 0, skipped, message: "No new items" })

  } catch (err) {
    console.error("❌ Error:", err?.message ?? String(err))
    return sendJSON(res, 500, { error: err?.message ?? String(err) })
  } finally {
    if (framer) try { await framer.disconnect() } catch(e) {}
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`)
  if (url.pathname !== "/sync") return sendJSON(res, 404, { error: "Not found" })
  if (req.method !== "POST") return sendJSON(res, 405, { error: "Method not allowed" })
  if (req.headers["x-sync-secret"] !== process.env.SYNC_SECRET) return sendJSON(res, 401, { error: "Unauthorized" })
  await handleSync(res)
})

server.listen(PORT, () => {
  console.log(`🚀 LAN Jobex sync server running on port ${PORT}`)
  console.log(`   FRAMER_API_KEY: ${!!process.env.FRAMER_API_KEY}`)
  console.log(`   GOOGLE_SHEET_ID: ${!!process.env.GOOGLE_SHEET_ID}`)
  console.log(`   SYNC_SECRET: ${!!process.env.SYNC_SECRET}`)
  console.log(`   SERVICE_ACCOUNT: ${!!process.env.GOOGLE_SERVICE_ACCOUNT_JSON}`)
})
