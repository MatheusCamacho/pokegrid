import path from "node:path";
import { TTLCache } from "./cache.mjs";
import { DiskJsonCache } from "./disk-cache.mjs";
import { TYPES, TYPE_CHART } from "./team-analysis.mjs";

const API = "https://pokeapi.co/api/v2";
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const cache = new TTLCache({ ttlMs: DEFAULT_TTL_MS, maxEntries: 1800 });
const diskCache = new DiskJsonCache({
  directory: process.env.POKEGRID_CACHE_DIR?.trim() || path.resolve(process.cwd(), ".pokegrid-cache"),
  staleMs: 30 * 24 * 60 * 60 * 1000,
  maxEntries: 2200
});
const cacheMetrics = { memoryHits: 0, networkHits: 0, staleFallbacks: 0 };

function cleanText(value = "") {
  return String(value).replace(/[\n\f\r]+/g, " ").replace(/\s+/g, " ").trim();
}

function resourceId(url = "") {
  const match = String(url).match(/\/(\d+)\/?$/);
  return match ? Number(match[1]) : null;
}

function normalizeSearchText(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function displayName(value = "") {
  return String(value)
    .split("-")
    .map((part) => part ? part[0].toUpperCase() + part.slice(1) : part)
    .join(" ");
}

async function fetchJson(url, { ttlMs = DEFAULT_TTL_MS } = {}) {
  const cached = cache.get(url);
  if (cached !== undefined) {
    cacheMetrics.memoryHits += 1;
    return cached;
  }

  const persisted = await diskCache.get(url);
  if (persisted !== undefined) {
    cache.set(url, persisted, ttlMs);
    return persisted;
  }

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Pokegrid-Portfolio/1.3"
      },
      signal: AbortSignal.timeout(12_000)
    });

    if (!response.ok) {
      const error = new Error(`PokéAPI returned ${response.status}`);
      error.status = response.status;
      throw error;
    }

    const data = await response.json();
    cacheMetrics.networkHits += 1;
    cache.set(url, data, ttlMs);
    await diskCache.set(url, data, ttlMs);
    return data;
  } catch (error) {
    const stale = await diskCache.get(url, { allowStale: true });
    if (stale !== undefined) {
      cacheMetrics.staleFallbacks += 1;
      cache.set(url, stale, Math.min(ttlMs, 10 * 60 * 1000));
      return stale;
    }
    throw error;
  }
}

function officialArtwork(pokemon) {
  return pokemon.sprites?.other?.["official-artwork"]?.front_default
    ?? pokemon.sprites?.other?.home?.front_default
    ?? pokemon.sprites?.front_default
    ?? null;
}

export function normalizePokemon(pokemon) {
  return {
    id: pokemon.id,
    name: pokemon.name,
    displayName: displayName(pokemon.name),
    speciesName: pokemon.species?.name ?? pokemon.name,
    height: pokemon.height / 10,
    weight: pokemon.weight / 10,
    baseExperience: pokemon.base_experience,
    image: officialArtwork(pokemon),
    sprite: pokemon.sprites?.front_default ?? null,
    types: [...pokemon.types].sort((a, b) => a.slot - b.slot).map((entry) => entry.type.name),
    abilities: [...pokemon.abilities].sort((a, b) => Number(a.is_hidden) - Number(b.is_hidden)).map((entry) => ({
      name: entry.ability.name,
      displayName: displayName(entry.ability.name),
      hidden: entry.is_hidden
    })),
    stats: Object.fromEntries(pokemon.stats.map((entry) => [entry.stat.name, entry.base_stat])),
    totalStats: pokemon.stats.reduce((sum, entry) => sum + entry.base_stat, 0),
    movesCount: pokemon.moves?.length ?? 0
  };
}

function flattenEvolutionChain(node, stage = 0, result = []) {
  result.push({
    name: node.species.name,
    displayName: displayName(node.species.name),
    stage,
    conditions: (node.evolution_details ?? []).map((detail) => ({
      trigger: detail.trigger?.name ?? null,
      minLevel: detail.min_level ?? null,
      item: detail.item?.name ?? null,
      heldItem: detail.held_item?.name ?? null,
      timeOfDay: detail.time_of_day || null,
      minHappiness: detail.min_happiness ?? null,
      location: detail.location?.name ?? null
    }))
  });

  for (const child of node.evolves_to ?? []) flattenEvolutionChain(child, stage + 1, result);
  return result;
}

function translatedField(entries, language, field) {
  return entries.find((entry) => entry.language?.name === language)?.[field]
    ?? entries.find((entry) => entry.language?.name === "en")?.[field]
    ?? entries[0]?.[field]
    ?? null;
}

export async function getPokemon(idOrName) {
  const key = encodeURIComponent(String(idOrName).toLowerCase().trim());
  const pokemon = await fetchJson(`${API}/pokemon/${key}`);
  return normalizePokemon(pokemon);
}

export async function getPokemonDetail(idOrName) {
  const key = encodeURIComponent(String(idOrName).toLowerCase().trim());
  const rawPokemon = await fetchJson(`${API}/pokemon/${key}`);
  const pokemon = normalizePokemon(rawPokemon);

  // Forms such as Mega Evolutions and Gigantamax have IDs outside the species
  // index. Always resolve species through pokemon.species instead of pokemon.id.
  const speciesKey = encodeURIComponent(rawPokemon.species?.name ?? pokemon.speciesName);
  const species = await fetchJson(`${API}/pokemon-species/${speciesKey}`);
  const evolution = species.evolution_chain?.url ? await fetchJson(species.evolution_chain.url) : null;

  const evolutionEntries = evolution ? flattenEvolutionChain(evolution.chain) : [];
  const evolutionWithIds = evolutionEntries.map((entry) => {
    const variety = species.varieties?.find((candidate) => candidate.pokemon?.name === entry.name);
    const match = entry.name === pokemon.name ? pokemon.id : resourceId(variety?.pokemon?.url);
    return { ...entry, id: Number.isFinite(match) ? match : null };
  });

  const flavorEn = cleanText(translatedField(species.flavor_text_entries ?? [], "en", "flavor_text") ?? "");
  const flavorPt = cleanText(translatedField(species.flavor_text_entries ?? [], "pt-br", "flavor_text") ?? flavorEn);
  const genusEn = translatedField(species.genera ?? [], "en", "genus");
  const genusPt = translatedField(species.genera ?? [], "pt-br", "genus") ?? genusEn;

  return {
    ...pokemon,
    availableMoves: (rawPokemon.moves ?? [])
      .map((entry) => entry.move?.name)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b)),
    varieties: (species.varieties ?? []).map((entry) => ({
      name: entry.pokemon?.name,
      displayName: displayName(entry.pokemon?.name),
      isDefault: Boolean(entry.is_default)
    })).filter((entry) => entry.name),
    species: {
      name: species.name,
      genus: genusEn,
      flavor: flavorEn,
      localized: {
        en: { genus: genusEn, flavor: flavorEn },
        "pt-BR": { genus: genusPt, flavor: flavorPt }
      },
      color: species.color?.name ?? null,
      habitat: species.habitat?.name ?? null,
      generation: species.generation?.name ?? null,
      growthRate: species.growth_rate?.name ?? null,
      captureRate: species.capture_rate ?? null,
      baseHappiness: species.base_happiness ?? null,
      eggGroups: (species.egg_groups ?? []).map((entry) => entry.name),
      legendary: Boolean(species.is_legendary),
      mythical: Boolean(species.is_mythical)
    },
    evolution: evolutionWithIds
  };
}

export async function listPokemon({ limit = 24, offset = 0 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 24, 1), 60);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const data = await fetchJson(`${API}/pokemon?limit=${safeLimit}&offset=${safeOffset}`, { ttlMs: 30 * 60 * 1000 });

  const items = await Promise.all(
    data.results.map(async (entry) => {
      try {
        return await getPokemon(entry.name);
      } catch {
        return { name: entry.name, displayName: displayName(entry.name), image: null, types: [], stats: {}, totalStats: 0 };
      }
    })
  );

  return {
    count: data.count,
    nextOffset: data.next ? safeOffset + safeLimit : null,
    previousOffset: data.previous ? Math.max(0, safeOffset - safeLimit) : null,
    items
  };
}

function searchScore(name, query) {
  const candidate = normalizeSearchText(name);
  if (candidate === query) return 0;
  if (candidate.startsWith(query)) return 1;

  const queryTokens = query.split(" ").filter(Boolean);
  const candidateTokens = candidate.split(" ").filter(Boolean);
  if (queryTokens.length && queryTokens.every((token) => candidateTokens.some((candidateToken) => candidateToken.includes(token)))) {
    return 2 + Math.max(0, candidateTokens.length - queryTokens.length);
  }

  if (candidate.includes(query)) return 8;
  return 99;
}

export async function searchPokemon(query, { limit = 12 } = {}) {
  const rawQuery = String(query ?? "").trim();
  const q = normalizeSearchText(rawQuery);
  if (!q) return [];

  if (/^\d+$/.test(q)) {
    try {
      return [await getPokemon(q)];
    } catch (error) {
      if (error?.status === 404) return [];
      throw error;
    }
  }

  const index = await fetchJson(`${API}/pokemon?limit=2000&offset=0`, { ttlMs: 6 * 60 * 60 * 1000 });
  const ranked = index.results
    .map((entry) => ({ name: entry.name, score: searchScore(entry.name, q) }))
    .filter((entry) => entry.score < 99)
    .sort((a, b) => a.score - b.score || a.name.length - b.name.length || a.name.localeCompare(b.name))
    .slice(0, Math.min(Math.max(Number(limit) || 12, 1), 30));

  return Promise.all(ranked.map((entry) => getPokemon(entry.name)));
}

export async function listGenerations() {
  const index = await fetchJson(`${API}/generation?limit=20&offset=0`, { ttlMs: 24 * 60 * 60 * 1000 });
  const details = await Promise.all(index.results.map((entry) => fetchJson(entry.url, { ttlMs: 24 * 60 * 60 * 1000 })));

  return details
    .map((generation) => ({
      id: generation.id,
      name: generation.name,
      displayName: `Generation ${generation.id}`,
      count: generation.pokemon_species?.length ?? 0,
      region: generation.main_region?.name ?? null
    }))
    .sort((a, b) => a.id - b.id);
}

export async function listGeneration(id, { limit = 32, offset = 0 } = {}) {
  const generation = await fetchJson(`${API}/generation/${encodeURIComponent(String(id))}`, { ttlMs: 24 * 60 * 60 * 1000 });
  const all = [...(generation.pokemon_species ?? [])]
    .map((entry) => ({ name: entry.name, id: resourceId(entry.url) }))
    .sort((a, b) => (a.id ?? 99999) - (b.id ?? 99999));

  const safeOffset = Math.max(Number(offset) || 0, 0);
  const safeLimit = Math.min(Math.max(Number(limit) || 32, 1), 60);
  const slice = all.slice(safeOffset, safeOffset + safeLimit);
  const items = await Promise.all(slice.map(async (entry) => {
    try {
      return await getPokemon(entry.name);
    } catch {
      return { id: entry.id, name: entry.name, displayName: displayName(entry.name), image: null, types: [], stats: {}, totalStats: 0 };
    }
  }));

  return {
    generation: {
      id: generation.id,
      name: generation.name,
      region: generation.main_region?.name ?? null
    },
    count: all.length,
    nextOffset: safeOffset + safeLimit < all.length ? safeOffset + safeLimit : null,
    items
  };
}

export async function filterPokemon({ type = "", generation = "", limit = 36, offset = 0 } = {}) {
  const safeType = type ?String(type).toLowerCase().trim() : "";
  const safeGeneration = generation ? String(generation).toLowerCase().trim() : "";
  const safeOffset = offset ? Math.max(Number(offset) || 0, 0) : 0;
  const safeLimit = limit ? Math.min(Math.max(Number(limit) || 36, 1), 60) : 36;

  let candidates = null;

  if (safeType === "" && safeGeneration === "") {
    const error = new Error("At least one filter must be provided: type or generation.");
    error.status = 400;
    throw error;
  }

  if (safeType && safeType !== "") {
    const typeData = await fetchJson(`${API}/type/${encodeURIComponent(safeType)}`, { ttlMs: 12 * 60 * 60 * 1000 });
    candidates = (typeData.pokemon ?? []).map((entry) => ({
      name: entry.pokemon?.name,
      id: resourceId(entry.pokemon?.url)
    })).filter((entry) => entry.name);
  }

  if (safeGeneration && safeGeneration !== "") {
    const generationData = await fetchJson(`${API}/generation/${encodeURIComponent(safeGeneration)}`, { ttlMs: 24 * 60 * 60 * 1000 });
    const generationSpecies = new Map((generationData.pokemon_species ?? []).map((entry) => [entry.name, resourceId(entry.url)]));

    if (candidates) {
      candidates = candidates.filter((entry) => generationSpecies.has(entry.name));
    } else {
      candidates = [...generationSpecies].map(([name, id]) => ({ name, id }));
    }
  }

  if (!candidates) {
    const index = await fetchJson(`${API}/pokemon?limit=2000&offset=0`, { ttlMs: 6 * 60 * 60 * 1000 });
    candidates = index.results.map((entry) => ({ name: entry.name, id: resourceId(entry.url) }));
  }

  candidates.sort((a, b) => (a.id ?? 99999) - (b.id ?? 99999) || a.name.localeCompare(b.name));
  const slice = candidates.slice(safeOffset, safeOffset + safeLimit);
  const items = await Promise.all(slice.map(async (entry) => {
    try {
      return await getPokemon(entry.name);
    } catch {
      return { id: entry.id, name: entry.name, displayName: displayName(entry.name), image: null, types: [], stats: {}, totalStats: 0 };
    }
  }));

  return {
    count: candidates.length,
    nextOffset: safeOffset + safeLimit < candidates.length ? safeOffset + safeLimit : null,
    items
  };
}

export async function getMove(name) {
  const move = await fetchJson(`${API}/move/${encodeURIComponent(String(name).toLowerCase().trim())}`, { ttlMs: 24 * 60 * 60 * 1000 });
  const flavorEn = cleanText(translatedField(move.flavor_text_entries ?? [], "en", "flavor_text") ?? "");
  const flavorPt = cleanText(translatedField(move.flavor_text_entries ?? [], "pt-br", "flavor_text") ?? flavorEn);

  return {
    id: move.id,
    name: move.name,
    displayName: displayName(move.name),
    accuracy: move.accuracy,
    power: move.power,
    pp: move.pp,
    priority: move.priority,
    type: move.type?.name ?? "normal",
    damageClass: move.damage_class?.name ?? "status",
    generation: move.generation?.name ?? null,
    flavor: { en: flavorEn, "pt-BR": flavorPt }
  };
}

export async function analyzeSelectedMoves(memberSelections = []) {
  const members = memberSelections.slice(0, 6);
  const resolved = [];

  for (const member of members) {
    const pokemon = await getPokemon(member.name);
    const moveNames = [...new Set((member.moves ?? []).map((move) => String(move).toLowerCase().trim()).filter(Boolean))].slice(0, 4);
    const moves = await Promise.all(moveNames.map((move) => getMove(move)));
    resolved.push({ pokemon, moves });
  }

  const coverage = Object.fromEntries(TYPES.map((type) => [type, 0]));
  const moveTypes = new Set();
  const classes = { physical: 0, special: 0, status: 0 };
  let stabMoves = 0;
  let attackingMoves = 0;

  for (const member of resolved) {
    for (const move of member.moves) {
      moveTypes.add(move.type);
      classes[move.damageClass] = (classes[move.damageClass] ?? 0) + 1;
      if (move.damageClass !== "status") {
        attackingMoves += 1;
        if (member.pokemon.types.includes(move.type)) stabMoves += 1;
        for (const defendingType of TYPES) {
          if ((TYPE_CHART[move.type]?.[defendingType] ?? 1) > 1) coverage[defendingType] += 1;
        }
      }
    }
  }

  return {
    members: resolved,
    coverage,
    coveredTypes: TYPES.filter((type) => coverage[type] > 0),
    gaps: TYPES.filter((type) => coverage[type] === 0),
    moveTypes: [...moveTypes],
    classes,
    attackingMoves,
    stabMoves
  };
}

export function cacheStats() {
  return {
    entries: cache.size,
    ...cacheMetrics,
    persistent: diskCache.stats()
  };
}
