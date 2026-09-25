export type PathwayBuilderRelation = 'convert' | 'promote' | 'inhibit' | 'reversible';

export interface PathwayBuilderGroup { name: string; color: string; note: string }
export interface PathwayBuilderNode { name: string; group: string; x?: number; y?: number }
export interface PathwayBuilderEdge { from: string; to: string; label: string; relation: PathwayBuilderRelation; group: string }

const normalizedGroupName = (name: string, index: number) => name.trim() || `分组 ${index + 1}`;

export function makePathwayMarkdown(
  title: string,
  groups: PathwayBuilderGroup[],
  nodes: PathwayBuilderNode[],
  edges: PathwayBuilderEdge[],
) {
  const lines = [`# ${title.trim() || '医学通路'}`];
  for (const [groupIndex, group] of groups.entries()) {
    const name = normalizedGroupName(group.name, groupIndex);
    lines.push(`## ${name} | ${group.color}${group.note.trim() ? ` | ${group.note.trim()}` : ''}`);
    const used = new Set<string>();
    for (const edge of edges.filter((e) => e.group.trim() === group.name.trim() || e.group.trim() === name)) {
      const from = edge.from.trim(); const to = edge.to.trim();
      if (!from || !to) continue;
      used.add(from); used.add(to);
      const relation = edge.relation === 'promote' ? '促进' : edge.relation === 'inhibit' ? '抑制' : '';
      const label = [relation, edge.label.trim()].filter(Boolean).join(' · ');
      lines.push(`${from} ${edge.relation === 'reversible' ? '<->' : '->'} ${to}${label ? ` : ${label}` : ''}`);
    }
    for (const node of nodes.filter((n) => n.group.trim() === group.name.trim() || n.group.trim() === name)) {
      const clean = node.name.trim(); if (!clean) continue;
      if (Number.isFinite(node.x) && Number.isFinite(node.y)) lines.push(`@ ${clean} | ${Math.round(node.x!)} | ${Math.round(node.y!)}`);
      else if (!used.has(clean)) lines.push(`@ ${clean}`);
    }
  }
  return `\`\`\`pathway\n${lines.join('\n')}\n\`\`\``;
}
