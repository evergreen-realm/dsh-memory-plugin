/** KAG-lite (§4-B): Rule-first Logical-Form Router + Typed-Edge BFS + Mutual-Indexed RRF over GBrain. */

                                                         
import { tokenizeText } from './retrieval.js'
                                                                                                         

const MONTH_MAP                         = {
  january: '01', jan: '01', february: '02', feb: '02', march: '03', mar: '03',
  april: '04', apr: '04', may: '05', june: '06', jun: '06',
  july: '07', jul: '07', august: '08', aug: '08', september: '09', sep: '09', sept: '09',
  october: '10', oct: '10', november: '11', nov: '11', december: '12', dec: '12',
}

/**
 * Rule-first Logical Form parser (§4-B). Zero LLM calls when deterministic structure rules match.
 */
export function parseLogicalForm(query        )                   {
  const lower = query.toLowerCase()
  const tokens = tokenizeText(query)

  let intent                             = 'general'
  const targetTypes = new Set            ()
  const preferredRelations = new Set              ()
  let matchedByRule = false

  if (/\b(decid[a-z]*|decision[a-z]*|choice[a-z]*|chose|locked|option|architecture|why did|which decision|supersed[a-z]*|replac[a-z]*|what did we lock)\b/i.test(lower)) {
    intent = 'decision_lookup'
    targetTypes.add('decision')
    targetTypes.add('project')
    preferredRelations.add('decided_on')
    preferredRelations.add('belongs_to')
    preferredRelations.add('supersedes')
    matchedByRule = true
  }
  if (/\b(fix[a-z]*|resolv[a-z]*|root cause|bug[a-z]*|error[a-z]*|issue[a-z]*|recover[a-z]*|repair[a-z]*|caused)\b/i.test(lower)) {
    if (intent === 'general') intent = 'resolution'
    targetTypes.add('decision')
    targetTypes.add('session')
    targetTypes.add('skill')
    preferredRelations.add('resolved_by')
    preferredRelations.add('depends_on')
    preferredRelations.add('belongs_to')
    matchedByRule = true
  }
  if (/\b(depend[a-z]*|requir[a-z]*|block[a-z]*|via|chain|connect[a-z]*|integrat[a-z]*|bridge|host|port|offload|downstream|upstream|through|store|storage|concept)\b/i.test(lower)) {
    if (intent === 'general') intent = 'dependency_walk'
    targetTypes.add('concept')
    targetTypes.add('project')
    targetTypes.add('repository')
    targetTypes.add('decision')
    preferredRelations.add('depends_on')
    preferredRelations.add('belongs_to')
    preferredRelations.add('decided_on')
    preferredRelations.add('uses_skill')
    matchedByRule = true
  }
  if (/\b(skill[a-z]*|tool[a-z]*|pack|schema|benchmark|capability|use|uses|using)\b/i.test(lower)) {
    if (intent === 'general' || intent === 'dependency_walk') intent = 'skill_lookup'
    targetTypes.add('skill')
    preferredRelations.add('uses_skill')
    preferredRelations.add('resolved_by')
    preferredRelations.add('belongs_to')
    matchedByRule = true
  }
  if (/\b(prefer[a-z]*|amend[a-z]*|rule[a-z]*|policy)\b/i.test(lower)) {
    targetTypes.add('preference')
    preferredRelations.add('amends')
    matchedByRule = true
  }
  if (/\b(who|owner[a-z]*|author[a-z]*|person|people|agent|account|meshack|mishael|evergreen)\b/i.test(lower)) {
    if (intent === 'general') intent = 'ownership'
    targetTypes.add('person')
    targetTypes.add('repository')
    preferredRelations.add('authored_by')
    preferredRelations.add('belongs_to')
    preferredRelations.add('decided_on')
    matchedByRule = true
  }

  let sinceDate                    
  const isoSince = lower.match(/\b(?:since|after|from)\s+(\d{4}-\d{2}(?:-\d{2})?)/i)
  if (isoSince) {
    sinceDate = isoSince[1].length === 7 ? `${isoSince[1]}-01` : isoSince[1]
    matchedByRule = true
  } else {
    const monthSince = lower.match(
      /\b(?:since|after|from)\s+(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|sept|october|oct|november|nov|december|dec)(?:\s+(\d{4}))?/i,
    )
    if (monthSince) {
      const m = MONTH_MAP[monthSince[1].toLowerCase()]
      const y = monthSince[2] ?? '2026'
      sinceDate = `${y}-${m}-01`
      matchedByRule = true
    }
  }

  const includeSuperseded = /\b(previous|old|earlier|superseded|before|history|initial|original|v0\.1|phase 1)\b/i.test(lower)
  const maxHops = /\b(indirect|chain|root|via|through|which.*and.*|across|both)\b/i.test(lower) ? 3 : 2

  return {
    matchedByRule,
    intent,
    seedEntities: tokens,
    targetTypes: [...targetTypes],
    preferredRelations: [...preferredRelations],
    sinceDate,
    includeSuperseded,
    maxHops,
  }
}

                                   
               
                  
                             
 

/**
 * Execute KAG-lite (§4-B) retrieval:
 * 1. Parse rule-first logical form.
 * 2. Score direct anchor nodes on GBrain (title/tag/token overlap).
 * 3. BFS over typed graph edges (preferring LF relations & respecting `since` / `superseded_by`).
 * 4. Fuse anchor + graph-reached nodes via mutual-indexing RRF weights.
 */
export async function kagLiteSearch(
  query        ,
  gbrain                 ,
  opts                   = {},
)                                                                                     {
  const topK = opts.topK ?? 5
  const lf = parseLogicalForm(query)
  const maxHops = opts.maxHops ?? lf.maxHops
  const includeSuperseded = opts.includeSuperseded ?? lf.includeSuperseded
  const qTokens = tokenizeText(query)

  const [seedHits, nodes] = await Promise.all([
    gbrain.query(query, { topK: Math.max(8, topK * 2), mode: 'hybrid' }),
    gbrain.allNodes(),
  ])

  const nodeMap = new Map                   (nodes.map((n) => [n.id, n]))
  const anchorScores = new Map                ()

  for (const h of seedHits) {
    anchorScores.set(h.id, Math.max(anchorScores.get(h.id) ?? 0, h.score))
  }

  // Also match entity names directly against node titles/ids/tags for exact structural grounding
  for (const node of nodes) {
    const labelText = `${node.id} ${node.title} ${(node.tags ?? []).join(' ')}`.toLowerCase()
    let titleMatches = 0
    for (const qt of qTokens) {
      if (labelText.includes(qt)) titleMatches += 1
    }
    if (titleMatches > 0) {
      const bonus = titleMatches * 0.45
      anchorScores.set(node.id, (anchorScores.get(node.id) ?? 0) + bonus)
    }
  }

  const seedIds = [...anchorScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([id]) => id)

                        
                 
                     
                
   
  const combined = new Map                    ()
  for (const sid of seedIds) {
    const baseNode = nodeMap.get(sid) ?? (await gbrain.getPage(sid))
    combined.set(sid, {
      score: anchorScores.get(sid) ?? 0.5,
      hopPath: [baseNode?.title ?? sid],
      hops: 0,
    })
  }

  // BFS graph walk over typed edges
  const queue                                                                                = seedIds.map((sid) => ({
    nodeId: sid,
    hops: 0,
    pathScore: anchorScores.get(sid) ?? 0.5,
    hopPath: [nodeMap.get(sid)?.title ?? sid],
  }))
  const bestHopSeen = new Map                ()
  for (const sid of seedIds) bestHopSeen.set(sid, 0)

  let visitedNodes = seedIds.length
  const prefRelSet = new Set(lf.preferredRelations)
  const targetTypeSet = new Set(lf.targetTypes)

  while (queue.length > 0) {
    const cur = queue.shift() 
    if (cur.hops >= maxHops) continue

    const neighbors = await gbrain.neighbors(cur.nodeId)
    for (const { edge, node } of neighbors) {
      const nextHops = cur.hops + 1
      visitedNodes += 1

      // Temporal filters
      if (!includeSuperseded && node.superseded_by) continue
      if (lf.sinceDate && node.date && node.date < lf.sinceDate) continue
      if (lf.sinceDate && edge.since && edge.since < lf.sinceDate && node.type === 'decision') continue

      const relMult = prefRelSet.size === 0 || prefRelSet.has(edge.relation) ? 1.28 : 0.85
      const typeMult = targetTypeSet.size === 0 || targetTypeSet.has(node.type) ? 1.25 : 0.92
      const tokenOverlap = qTokens.filter((qt) =>
        `${node.title} ${node.summary} ${(node.tags ?? []).join(' ')}`.toLowerCase().includes(qt),
      ).length
      const lexicalBoost = 1 + Math.min(0.8, tokenOverlap * 0.16)
      const hopDecay = Math.pow(0.76, nextHops)
      const stepScore = cur.pathScore * relMult * typeMult * lexicalBoost * hopDecay
      const stepPath = [...cur.hopPath, `[${edge.relation}]`, node.title]

      const existing = combined.get(node.id)
      // Reward converging paths while preserving best hop path
      if (!existing) {
        combined.set(node.id, { score: stepScore, hopPath: stepPath, hops: nextHops })
      } else {
        existing.score = existing.score + stepScore * 0.45
        if (stepScore > existing.score * 0.7 && stepPath.length < existing.hopPath.length) {
          existing.hopPath = stepPath
        }
      }

      const prevBest = bestHopSeen.get(node.id)
      if (prevBest === undefined || nextHops < prevBest) {
        bestHopSeen.set(node.id, nextHops)
        queue.push({ nodeId: node.id, hops: nextHops, pathScore: stepScore, hopPath: stepPath })
      }
    }
  }

  const out                     = []
  for (const [id, rec] of combined.entries()) {
    const node = nodeMap.get(id) ?? (await gbrain.getPage(id))
    const hitSeed = seedHits.find((h) => h.id === id)
    if (!node && !hitSeed) continue
    const finalNode = node ?? {
      id,
      type: (hitSeed?.type              ) ?? 'concept',
      title: hitSeed?.title ?? id,
      summary: hitSeed?.snippet ?? '',
      date: hitSeed?.date,
    }
    if (!includeSuperseded && 'superseded_by' in finalNode && finalNode.superseded_by) continue
    if (lf.sinceDate && finalNode.date && finalNode.date < lf.sinceDate) continue

    // Boost target-type nodes actually answering the primary relational intent over bare anchor hubs
    const isPrimarySkill = lf.intent === 'skill_lookup' && finalNode.type === 'skill'
    const isPrimaryOwner = lf.intent === 'ownership' && finalNode.type === 'person'
    const isPrimaryDecision = lf.intent === 'decision_lookup' && finalNode.type === 'decision'
    const targetAnswerBoost =
      isPrimarySkill || isPrimaryOwner || isPrimaryDecision
        ? 1.5
        : targetTypeSet.size > 0 && targetTypeSet.has(finalNode.type)
          ? 1.15
          : 0.85
    out.push({
      id: finalNode.id,
      source: 'kag-lite',
      title: finalNode.title,
      snippet: finalNode.summary,
      score: Number((rec.score * targetAnswerBoost).toFixed(4)),
      hopPath: rec.hops > 0 ? rec.hopPath : undefined,
      date: finalNode.date,
      project_id: 'project_id' in finalNode ? finalNode.project_id : undefined,
    })
  }

  out.sort((a, b) => b.score - a.score)
  return { items: out.slice(0, topK), lf, visitedNodes }
}
