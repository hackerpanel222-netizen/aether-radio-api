// api/radio.js — Unified Cross-Engine Smart Radio (JioSaavn 320K + YouTube Music)
const SAAVN_BASE = "https://jio-saavn-api-self.vercel.app";
const YT_BASE = "https://yt-music-api-indol.vercel.app";

const MOOD_KEYWORDS = [
  "phonk", "slowed", "reverb", "lofi", "lo-fi", "sad", "romantic", "love",
  "punjabi", "hindi", "haryanvi", "bhojpuri", "english", "drill", "trap",
  "remix", "mashup", "unplugged", "acoustic", "party", "workout", "gym",
  "bass", "nightcore", "sped up", "instrumental", "rap", "hip hop", "indie"
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
  const t = cleanText(title);
  const a = cleanText(artist.split(",")[0] || "");
  return `${t}::${a}`;
}

function extractMoodTags(title = "", artist = "") {
  const combined = `${title} ${artist}`.toLowerCase();
  return MOOD_KEYWORDS.filter(tag => combined.includes(tag));
}

function normalizeSaavnTrack(item) {
  if (!item || !item.id) return null;
  const imgArr = Array.isArray(item.image) ? item.image : [];
  const bestImg = imgArr[imgArr.length - 1]?.url || imgArr[0]?.url || item.image || "";
  const dlArr = Array.isArray(item.downloadUrl) ? item.downloadUrl : [];
  const bestUrl = dlArr[dlArr.length - 1]?.url || dlArr[0]?.url || item.url || "";
  const primaryArtists = item.artists?.primary?.map(a => a.name).join(", ") || item.primaryArtists || "Unknown Artist";

  return {
    id: String(item.id),
    title: (item.name || item.title || "Unknown").replace(/&quot;/g, '"').replace(/&amp;/g, "&"),
    artist: primaryArtists.replace(/&amp;/g, "&"),
    image: bestImg,
    url: bestUrl,
    duration: Number(item.duration || 0),
    engine: "saavn"
  };
}

function normalizeYTTrack(item) {
  const vid = item?.videoId || item?.id;
  if (!vid) return null;
  const thumbs = Array.isArray(item.thumbnails) ? item.thumbnails : [];
  const bestImg = thumbs[thumbs.length - 1]?.url || item.thumbnail || `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;
  const artists = Array.isArray(item.artists)
    ? item.artists.map(a => a.name || a).join(", ")
    : (item.artist || item.author || "YouTube Music");

  return {
    id: String(vid),
    title: item.title || item.name || "Unknown",
    artist: artists,
    image: bestImg,
    url: "",
    duration: Number(item.duration_seconds || item.duration || 0),
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
      title: req.query.title || "Trending Hindi",
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
    const crossQuery = encodeURIComponent(`${cleanText(seed.title)} ${primaryArtist} ${vibeHint}`.trim());
    const artistQuery = encodeURIComponent(`${primaryArtist} ${vibeHint}`.trim());

    // STAGE 1: Parallel Cross-Engine Harvesting (Both Saavn & YT fetched together!)
    const tasks = [];

    // 1A. Saavn Native Co-Listening Graph OR Cross-Search
    if (seed.engine === "saavn" && seed.id) {
      tasks.push(safeFetchJson(`${SAAVN_BASE}/api/songs/${encodeURIComponent(seed.id)}/suggestions?limit=20`));
    }
    tasks.push(safeFetchJson(`${SAAVN_BASE}/api/search/songs?query=${artistQuery || crossQuery}&limit=16`));

    // 1B. YT Music Radio Mix (RDAMVM) OR Cross-Search
    if (seed.engine === "yt" && seed.id) {
      tasks.push(safeFetchJson(`${YT_BASE}/radio?videoId=${encodeURIComponent(seed.id)}`));
      tasks.push(safeFetchJson(`${YT_BASE}/watch?videoId=${encodeURIComponent(seed.id)}`));
    }
    tasks.push(safeFetchJson(`${YT_BASE}/search?q=${crossQuery}&filter=songs`));
    if (artistQuery && artistQuery !== crossQuery) {
      tasks.push(safeFetchJson(`${YT_BASE}/search?q=${artistQuery}&filter=songs`));
    }

    const results = await Promise.allSettled(tasks);
    const rawPool = [];

    for (const r of results) {
      if (r.status !== "fulfilled" || !r.value) continue;
      const payload = r.value;

      // Parse Saavn structures
      const saavnList = payload?.data?.results || (Array.isArray(payload?.data) ? payload.data : null);
      if (Array.isArray(saavnList)) {
        saavnList.forEach(item => {
          const norm = normalizeSaavnTrack(item);
          if (norm) rawPool.push(norm);
        });
      }

      // Parse YT structures
      const ytList = payload?.tracks || payload?.results || (Array.isArray(payload) ? payload : null);
      if (Array.isArray(ytList)) {
        ytList.forEach(item => {
          const norm = normalizeYTTrack(item);
          if (norm) rawPool.push(norm);
        });
      }
    }

    // STAGE 2: Cross-Engine Deduplication (Keep Saavn 320K if same song exists on both!)
    const dedupMap = new Map();
    const seedKey = getNormalizedKey(seed.title, seed.artist);

    for (const track of rawPool) {
      if (!track || !track.id) continue;
      if (String(track.id) === String(seed.id)) continue;
      if (recentIds.has(String(track.id))) continue;

      const key = getNormalizedKey(track.title, track.artist);
      if (!key || key === seedKey || recentKeys.has(key)) continue;

      const existing = dedupMap.get(key);
      if (!existing) {
        dedupMap.set(key, track);
      } else if (existing.engine === "yt" && track.engine === "saavn" && track.url) {
        // Upgrade duplicate YT track to crisp 320K Saavn version
        dedupMap.set(key, track);
      }
    }

    // STAGE 3: Spotify-Style Taste & Vibe Scoring (Engine-Agnostic)
    const scored = [];
    const seedTitleTokens = new Set(cleanText(seed.title).split(" ").filter(w => w.length > 2));

    for (const track of dedupMap.values()) {
      let score = 40; // Base score for both Saavn & YT equally
      const tArtistLower = track.artist.toLowerCase();
      const tPrimaryArtist = tArtistLower.split(",")[0].trim();
      const tTags = extractMoodTags(track.title, track.artist);

      // +35 Vibe & Mood Tag Overlap (phonk, slowed, romantic, punjabi, etc.)
      const sharedTags = tTags.filter(tag => seedTags.includes(tag));
      score += Math.min(35, sharedTags.length * 18);

      // +20 Title/Style Keyword Synergy
      const tTokens = cleanText(track.title).split(" ");
      const tokenOverlap = tTokens.filter(w => seedTitleTokens.has(w)).length;
      score += Math.min(20, tokenOverlap * 7);

      // +22 Artist Affinity (Same/Featured Artist OR User's Liked Artists)
      if (primaryArtist && tArtistLower.includes(primaryArtist.toLowerCase())) {
        score += 18;
      }
      if (likedArtists.some(la => la && tArtistLower.includes(la))) {
        score += 22;
      }

      // -50 Skip Penalty (Negative Behavioral Signal)
      if (skippedIds.has(String(track.id))) score -= 60;
      if (skippedArtists.has(tPrimaryArtist)) score -= 40;

      // Slight jitter (+0 to +6) so radio feels organic every session
      score += Math.random() * 6;

      scored.push({ track, score, primaryArtist: tPrimaryArtist });
    }

    scored.sort((a, b) => b.score - a.score);

    // STAGE 4: Artist-Cooldown Sequencer (Never play same artist back-to-back)
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

    return res.status(200).json({
      ok: true,
      count: finalQueue.length,
      tracks: finalQueue
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message, tracks: [] });
  }
}