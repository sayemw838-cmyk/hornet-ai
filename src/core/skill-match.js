function words(value) {
  return new Set(String(value || "").toLowerCase().match(/[a-z0-9][a-z0-9+#.-]{1,}/g) || []);
}

function scoreSkill(skill, query) {
  const terms = words(query);
  const searchable = words(`${skill.name || ""} ${skill.description || ""} ${skill.instructions || ""}`);
  let score = 0;
  for (const term of terms) if (searchable.has(term)) score += term.length > 5 ? 2 : 1;
  return score;
}

export function matchSkills(skills, query, limit = 4) {
  return (Array.isArray(skills) ? skills : [])
    .filter((skill) => skill && skill.status === "published" && skill.enabled !== false)
    .map((skill) => ({ skill, score: scoreSkill(skill, query) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || String(a.skill.name).localeCompare(String(b.skill.name)))
    .slice(0, Math.max(1, Math.min(Number(limit) || 4, 10)))
    .map(({ skill }) => skill);
}
