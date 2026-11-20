// api/radio.js — Precision Cross-Engine Smart Radio (No 1-Hour Mixes, Exact Vibe Match)
const SAAVN_BASE = "https://jio-saavn-api-self.vercel.app";
const YT_BASE = "https://yt-music-api-indol.vercel.app";

const JUNK_PATTERNS = /\b(1\s*hour|2\s*hour|mix|compilation|reaction|mashup|jukebox|non\s*stop|24\/7|live|study\s*session|playlist|top\s*100|top\s*150|top\s*40)\b/i;

const MOOD_KEYWORDS = [
  "phonk", "slowed", "reverb", "lofi", "lo-fi", "sad", "romantic", "love",
  "punjabi", "hindi", "sufi", "ghazal", "haryanvi", "english", "drill", "trap",
  "unplugged", "acoustic", "party", "workout", "gym", "bass", "rap", "indie"
];

function cleanText(str = "") {
  return String(str)
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/\b(official|video|audio|lyrics|lyrical|song|full|hd|4k|320kbps|feat|ft)\b/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getNormalizedKey(title = "", artist = "") {
  return `${cleanText(title)}::${cleanText(artist.split(",")[0] || "")}`;
}

function extractMoodTags(title = "", artist = "") {
  const combined = `${title} ${artist}`.toLowerCase();
  return MOOD_KEYWORDS.filter(tag => combined.includes(tag));
}

function isJunkOrLongMix(title = "", durationSec = 0) {
  if (JUNK_PATTERNS.test(title)) return true;
  if (durationSec > 660) return true; // Block anything longer than 11 minutes
  return false;
}

function normalizeSaavnTrack(item) {
  if (!item || !item.id) return null;
  const title = (item.name || item.title || "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").trim();
  const duration = Number(item.duration || 0);
  if (!title || isJunkOrLongMix(title, duration)) return null;

  const imgArr = Array.isArray(item.image) ? item.image : [];
  const bestImg = imgArr[imgArr.length - 1]?.url || imgArr[0]?.url || item.image || "";
  const dlArr = Array.isArray(item.downloadUrl) ? item.downloadUrl : [];
  const bestUrl = dlArr[dlArr.length - 1]?.url || dlArr[0]?.url || item.url || "";
  const primaryArtists = item.artists?.primary?.map(a => a.name).join(", ") || item.primaryArtists || "Unknown Artist";

  return {
    id: String(item.id),
    title,
    artist: primaryArtists.replace(/&amp;/g, "&"),
    image: bestImg,
    url: bestUrl,
    duration,
    language: (item.language || "").toLowerCase(),
    engine: "saavn"
  };
}

function normalizeYTTrack(item) {
  const vid = item?.videoId || item?.id;
  if (!vid) return null;
  const title = (item.title || item.name || "").trim();
  const duration = Number(item.duration_seconds || item.duration || 0);
  if (!title || isJunkOrLongMix(title, duration)) return null;

  const thumbs = Array.isArray(item.thumbnails) ? item.thumbnails : [];
  const bestImg = thumbs[thumbs.length - 1]?.url || item.thumbnail || `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;
  const artists = Array.isArray(item.artists)
    ? item.artists.map(a => a.name || a).join(", ")
    : (item.artist || item.author || "YouTube Music");

  return {
    id: String(vid),
    title,
    artist: artists,
    image: bestImg,
    url: "",
    duration,
    language: "",
    engine: "yt"
  };
}

async function safeFetchJson(url, timeoutMs = 4500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    clearTimeout(timer);
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const body = req.method === "POST" ? (req.body || {}) : {};
    const seed = body.seedTrack || {
      id: req.query.id || "",
      title: req.query.title || "",
      artist: req.query.artist || "",
      engine: req.query.engine || "saavn"
    };

    const likedArtists = (body.likedArtists || []).map(a => a.toLowerCase());
    const recentIds = new Set((body.recentPlayed || []).map(String));
    const recentKeys = new Set((body.recentKeys || []).map(String));
    const skippedIds = new Set((body.skippedIds || []).map(String));
    const skippedArtists = new Set((body.skippedArtists || []).map(a => a.toLowerCase()));

    const primaryArtist = (seed.artist || "").split(",")[0].trim();
    const seedTags = extractMoodTags(seed.title, seed.artist);
    const vibeHint = seedTags[0] || "";
    const songTitleClean = cleanText(seed.title);

    // Parallel Cross-Engine Queries focused on Seed Artist + Exact Song Vibe
    const tasks = [];

    if (seed.engine === "saavn" && seed.id) {
      tasks.push(safeFetchJson(`${SAAVN_BASE}/api/songs/${encodeURIComponent(seed.id)}/suggestions?limit=25`));
    }
    if (primaryArtist) {
      tasks.push(safeFetchJson(`${SAAVN_BASE}/api/search/songs?query=${encodeURIComponent(primaryArtist)}&limit=15`));
      tasks.push(safeFetchJson(`${YT_BASE}/search?q=${encodeURIComponent(`${primaryArtist} ${songTitleClean} song`)}&filter=songs`));
    }
    if (songTitleClean) {
      tasks.push(safeFetchJson(`${SAAVN_BASE}/api/search/songs?query=${encodeURIComponent(`${songTitleClean} ${vibeHint}`.trim())}&limit=12`));
    }
    if (seed.engine === "yt" && seed.id) {
      tasks.push(safeFetchJson(`${YT_BASE}/radio?videoId=${encodeURIComponent(seed.id)}`));
    }

    const results = await Promise.allSettled(tasks);
    const rawPool = [];

    for (const r of results) {
      if (r.status !== "fulfilled" || !r.value) continue;
      const payload = r.value;

      const saavnList = payload?.data?.results || (Array.isArray(payload?.data) ? payload.data : null);
      if (Array.isArray(saavnList)) {
        saavnList.forEach(item => {
          const norm = normalizeSaavnTrack(item);
          if (norm) rawPool.push(norm);
        });
      }

      const ytList = payload?.tracks || payload?.results || (Array.isArray(payload) ? payload : null);
      if (Array.isArray(ytList)) {
        ytList.forEach(item => {
          const norm = normalizeYTTrack(item);
          if (norm) rawPool.push(norm);
        });
      }
    }

    // Deduplicate (Upgrade YT duplicates to Saavn 320K)
    const dedupMap = new Map();
    const seedKey = getNormalizedKey(seed.title, seed.artist);

    for (const track of rawPool) {
      if (!track || !track.id || String(track.id) === String(seed.id)) continue;
      if (recentIds.has(String(track.id))) continue;

      const key = getNormalizedKey(track.title, track.artist);
      if (!key || key === seedKey || recentKeys.has(key)) continue;

      const existing = dedupMap.get(key);
      if (!existing || (existing.engine === "yt" && track.engine === "saavn" && track.url)) {
        dedupMap.set(key, track);
      }
    }

    // Score strictly by Seed Artist, Co-Listened Graph, Mood Tags & Skip History
    const scored = [];
    for (const track of dedupMap.values()) {
      let score = 35;
      const tArtistLower = track.artist.toLowerCase();
      const tPrimaryArtist = tArtistLower.split(",")[0].trim();
      const tTags = extractMoodTags(track.title, track.artist);

      // Strong boost for same/related artist (e.g., Satinder Sartaaj -> Punjabi Sufi/Folk peers)
      if (primaryArtist && tArtistLower.includes(primaryArtist.toLowerCase())) {
        score += 32;
      }

      // Mood tag alignment (phonk stays phonk, sufi/punjabi stays sufi/punjabi)
      const sharedTags = tTags.filter(tag => seedTags.includes(tag));
      score += Math.min(30, sharedTags.length * 16);

      // Penalize mismatching extreme genres (e.g., don't put Dark Phonk after Satinder Sartaaj!)
      const isSeedHard = seedTags.some(t => ["phonk", "drill", "trap", "gym", "workout", "bass"].includes(t));
      const isTrackHard = tTags.some(t => ["phonk", "drill", "trap", "gym", "workout", "bass"].includes(t));
      if (isSeedHard !== isTrackHard) score -= 45;

      // User's Liked Artists synergy
      if (likedArtists.some(la => la && tArtistLower.includes(la))) score += 16;

      // Early Skip Penalty
      if (skippedIds.has(String(track.id))) score -= 65;
      if (skippedArtists.has(tPrimaryArtist)) score -= 45;

      score += Math.random() * 5;
      scored.push({ track, score, primaryArtist: tPrimaryArtist });
    }

    scored.sort((a, b) => b.score - a.score);

    // Artist-Cooldown Sequencer
    const finalQueue = [];
    const recentQueuedArtists = [];

    while (scored.length > 0 && finalQueue.length < 18) {
      let pickIdx = scored.findIndex(item => !recentQueuedArtists.includes(item.primaryArtist));
      if (pickIdx === -1) pickIdx = 0;

      const chosen = scored.splice(pickIdx, 1)[0];
      finalQueue.push(chosen.track);

      recentQueuedArtists.push(chosen.primaryArtist);
      if (recentQueuedArtists.length > 2) recentQueuedArtists.shift();
    }

    return res.status(200).json({ ok: true, count: finalQueue.length, tracks: finalQueue });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message, tracks: [] });
  }
}